import {
    apparentDirection,
    createSkyPassApprox,
    DEFAULT_ATMOSPHERE_MODEL,
    precomputeAtmosphereApprox,
} from "@himmelszelt/dunstkreis/approx";
import { fromJulianDay, julianEphemerisDay, sun } from "@himmelszelt/sternzeit";
import { onDemand } from "../frame.js";
import { COMPASS } from "../sternzeit/figure.js";
import { onChange, state } from "../sternzeit/state.js";

// The two libraries meet in one vector: sternzeit says where the Sun is, dunstkreis what the air does to its light.
const DEG = Math.PI / 180;
const root = document.querySelector("#sky");
const field = (name) => root.querySelector(`[data-field="${name}"]`);
const canvas = field("canvas");
const compass = field("compass");
const pressed = (name) => field(name).getAttribute("aria-pressed") === "true";

// Camera in the observer's ENU frame, yaw a compass azimuth; locked to the sun until dragged.
const camera = { yaw: 0, pitch: 10 * DEG, fov: 70 * DEG };

function showError(html) {
    const error = document.createElement("div");
    error.className = "sky-error";
    error.innerHTML = `<p>${html}</p>`;
    canvas.replaceWith(error);
}

async function setup() {
    if (!navigator.gpu) {
        showError(
            'This figure needs WebGPU, which this browser does not expose. See <a href="https://caniuse.com/webgpu" ' +
                'target="_blank" rel="noopener">caniuse.com/webgpu</a>.',
        );
        return null;
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
        // Mostly Linux, where Chrome still ships WebGPU behind a flag: the API is there, but no adapter behind it.
        showError(
            "WebGPU is there, but without a GPU adapter. On Linux, Chrome needs " +
                "<code>chrome://flags/#enable-unsafe-webgpu</code> enabled and a restart.",
        );
        return null;
    }
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    // The sky is written by a compute pass, straight into the canvas: rgba8unorm, which storage textures take everywhere.
    const format = "rgba8unorm";
    context.configure({
        device,
        format,
        alphaMode: "opaque",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING,
    });
    // Which GPU, for the timings: a fallback adapter renders on the CPU, a hundred times slower.
    const { vendor, architecture, description } = adapter.info ?? {};
    const name = description || [vendor, architecture].filter(Boolean).join(" ") || "unknown GPU";
    const adapterName = adapter.isFallbackAdapter ? `${name}, a CPU fallback` : name;
    return { device, context, format, adapterName };
}

// Refraction is part of the model, so switching it recomputes the tables; both sets are kept once computed.
const MODELS = { true: DEFAULT_ATMOSPHERE_MODEL, false: { ...DEFAULT_ATMOSPHERE_MODEL, refractivity: 0 } };
const tables = {};

async function precompute(refraction) {
    if (tables[refraction]) return tables[refraction];
    const started = performance.now();
    const luts = await precomputeAtmosphereApprox(gpu.device, { model: MODELS[refraction] });
    tables[refraction] = { luts, precomputeMs: performance.now() - started };
    return tables[refraction];
}

// Zooming out past 100 degrees bends the perspective into a stereographic fisheye, complete at the widest view of
// 200 degrees: the projection's d (see dunstkreis' projectionDistance). Looking up, the whole sky then shows as a disc,
// with ten degrees below the horizon to spare at the top and bottom edges.
const MAX_FOV = 200 * DEG;
const projectionDistance = (fov) => Math.min(1, Math.max(0, (fov - 100 * DEG) / (MAX_FOV - 100 * DEG)));

/** The image plane radius at `theta` from the axis, for the projection's d: (d + 1) sin(theta) / (d + cos(theta)). */
const imageRadius = (theta, d) => ((d + 1) * Math.sin(theta)) / (d + Math.cos(theta));

/** The camera's forward, right and up vectors, the image plane's half extents and the projection's d. */
function cameraBasis(aspect) {
    const { yaw, pitch, fov } = camera;
    const f = [Math.cos(pitch) * Math.sin(yaw), Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch)];
    const r = [Math.cos(yaw), -Math.sin(yaw), 0];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const d = projectionDistance(fov);
    const ty = imageRadius(fov / 2, d);
    return { f, r, u, tx: ty * aspect, ty, d };
}

/**
 * The inverse view-projection the pass turns fragments back into rays with, built directly: a clip-space point
 * (x, y) on the far plane maps to forward + x·tx·right + y·ty·up. Column major, like WGSL.
 */
function inverseViewProjection({ f, r, u, tx, ty }) {
    return new Float32Array([...r.map((c) => c * tx), 0, ...u.map((c) => c * ty), 0, ...f, 0, 0, 0, 0, 1]);
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// The eight compass directions as labels standing on the horizon, placed by the same projection the sky uses.
const labels = COMPASS.map((name) =>
    compass.appendChild(Object.assign(document.createElement("span"), { textContent: name })),
);

function placeCompass(basis, width, height) {
    compass.hidden = !pressed("grid");
    labels.forEach((label, i) => {
        const direction = [Math.sin(i * 45 * DEG), Math.cos(i * 45 * DEG), 0];
        // The same projection the shader inverts: the angle from the axis to the image plane radius.
        const cosTheta = dot(direction, basis.f);
        const inPlane = [0, 1, 2].map((c) => direction[c] - basis.f[c] * cosTheta);
        const sinTheta = Math.hypot(...inPlane);
        label.hidden = basis.d + cosTheta <= 1e-3 || (basis.d === 0 && cosTheta <= 0);
        if (label.hidden) return;
        const scale = sinTheta > 1e-9 ? imageRadius(Math.atan2(sinTheta, cosTheta), basis.d) / sinTheta : 1;
        const x = (dot(inPlane, basis.r) * scale) / basis.tx;
        const y = (dot(inPlane, basis.u) * scale) / basis.ty;
        label.style.left = `${((x + 1) / 2) * width}px`;
        label.style.top = `${((1 - y) / 2) * height}px`;
    });
}

const gpu = await setup();
let pass = null;
let passFor = {};
let table = gpu && (await precompute(true));

// Where the time goes, shown with the grid: the astronomy, the sky pass' own CPU work, and when the GPU was done.
function showTiming(astronomyMs, skyMs, submitted) {
    const text = (doneMs) =>
        `${gpu.adapterName} · precompute ${table.precomputeMs.toFixed(1)} ms · astronomy ${astronomyMs.toFixed(2)} ms · ` +
        `sky ${skyMs.toFixed(2)} ms · GPU done after ${doneMs.toFixed(2)} ms`;
    gpu.device.queue.onSubmittedWorkDone().then(() => {
        field("timing").textContent = pressed("grid") ? text(performance.now() - submitted) : "";
    });
}

function render() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });

    const started = performance.now();
    const time = fromJulianDay(state.jd);
    const position = sun.horizontalPosition(time, state);
    const sunDirection = sun.direction(time, state);
    const sunAngularDiameter = sun.apparentAngularDiameter(julianEphemerisDay(time));
    const astronomyMs = performance.now() - started;

    const debugGrid = pressed("grid");
    // Where the sun shows, lifted by the same air the sky is traced through.
    const [x, y, z] = apparentDirection(sunDirection, table.luts.model, state.heightM);
    field("sun").textContent =
        `Sun ${position.altitude.toFixed(2)}° high (${(Math.asin(z) / DEG).toFixed(2)}° apparent), ` +
        `azimuth ${position.azimuth.toFixed(2)}°`;
    if (pressed("lock")) {
        camera.yaw = Math.atan2(x, y);
        camera.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, Math.asin(z)));
    }
    const skyStarted = performance.now();
    if (table.luts !== passFor.luts || debugGrid !== passFor.debugGrid) {
        pass?.destroy();
        pass = createSkyPassApprox(gpu.device, { luts: table.luts, format: gpu.format, debugGrid });
        passFor = { luts: table.luts, debugGrid };
    }

    const basis = cameraBasis(width / height);
    placeCompass(basis, canvas.clientWidth, canvas.clientHeight);
    pass.update({
        sunDirection,
        sunAngularDiameter,
        observerHeightM: state.heightM,
        inverseViewProjection: inverseViewProjection(basis),
        projectionDistance: basis.d,
        ev100: evOfSlider(),
        autoExposure: pressed("auto"),
    });

    const encoder = gpu.device.createCommandEncoder();
    pass.encode(encoder, gpu.context.getCurrentTexture());
    gpu.device.queue.submit([encoder.finish()]);
    const submitted = performance.now();
    showTiming(astronomyMs, submitted - skyStarted, submitted);
    showExposure();
}

// The slider runs brighter to the right, so it holds minus the EV100: a lower EV lets in more light.
const evOfSlider = () => -Number(field("exposure").value);

// Metered, the slider follows the light meter and waits; by hand, it sets the exposure.
function showExposure() {
    const slider = field("exposure");
    slider.disabled = pressed("auto");
    if (!pressed("auto")) {
        field("ev").textContent = evOfSlider().toFixed(1);
        return;
    }
    pass.meteredEV100().then((ev100) => {
        slider.value = String(-ev100);
        field("ev").textContent = `${ev100.toFixed(1)} metered`;
    });
}

if (gpu) {
    const requestRender = onDemand(render);
    onChange(requestRender);
    new ResizeObserver(requestRender).observe(canvas);
    field("exposure").addEventListener("input", requestRender);
    for (const name of ["auto", "lock", "grid", "refraction"]) {
        field(name).addEventListener("click", async () => {
            field(name).setAttribute("aria-pressed", String(!pressed(name)));
            if (name === "refraction") table = await precompute(pressed("refraction"));
            requestRender();
        });
    }

    canvas.addEventListener("pointerdown", (event) => {
        canvas.setPointerCapture(event.pointerId);
        const start = { x: event.clientX, y: event.clientY, yaw: camera.yaw, pitch: camera.pitch };
        const move = (e) => {
            field("lock").setAttribute("aria-pressed", "false");
            // A pixel of drag turns the view by a pixel's worth of the field of view, so the sky follows the pointer.
            const perPixel = Math.min(camera.fov, Math.PI) / canvas.clientHeight;
            camera.yaw = start.yaw - (e.clientX - start.x) * perPixel;
            camera.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, start.pitch + (e.clientY - start.y) * perPixel));
            requestRender();
        };
        canvas.addEventListener("pointermove", move);
        canvas.addEventListener("pointerup", () => canvas.removeEventListener("pointermove", move), { once: true });
    });
    canvas.addEventListener(
        "wheel",
        (event) => {
            event.preventDefault();
            camera.fov = Math.max(0.5 * DEG, Math.min(MAX_FOV, camera.fov * Math.exp(event.deltaY * 0.001)));
            requestRender();
        },
        { passive: false },
    );
    requestRender();
}
