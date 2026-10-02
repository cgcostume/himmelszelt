import {
    apparentDirection,
    clampObserverHeight,
    createSkyPass,
    DEFAULT_AUTO_EXPOSURE_KEYS,
} from "@himmelszelt/dunstkreis";
import { fromJulianDay, julianEphemerisDay, sun } from "@himmelszelt/sternzeit";
import { onDemand } from "../frame.js";
import { paintRange } from "../range.js";
import { COMPASS } from "../sternzeit/figure.js";
import { onChange, state } from "../sternzeit/state.js";
import {
    bindModelChoice,
    bindToneCurveChoice,
    display,
    onDisplay,
    onTables,
    quality,
    recompute,
    gpu as shared,
    skyViewChanged,
    tables,
} from "./atmosphere.js";
import { azimuthFromSun, viewDirection } from "./lutmap.js";
import { onPick, pick, picked } from "./pick.js";

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

// The sky is written by a compute pass, straight into the canvas: rgba8unorm, which storage textures take everywhere,
// or on an HDR display rgba16float, extended sRGB, whose values above 1 show brighter than SDR white.
const SDR = "rgba8unorm";
const HDR = "rgba16float";
const hdrDisplay = window.matchMedia("(dynamic-range: high)");

function configure(context, device, format) {
    const toneMapping = { mode: format === HDR ? "extended" : "standard" };
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING;
    context.configure({ device, format, alphaMode: "opaque", usage, toneMapping });
}

function setup() {
    if (shared.error) {
        showError(shared.error);
        return null;
    }
    const { device, adapterName } = shared;
    const context = canvas.getContext("webgpu");
    // Whether the canvas takes extended tone mapping at all: a browser without it drops the member it does not know.
    configure(context, device, HDR);
    const extended = context.getConfiguration?.()?.toneMapping?.mode === "extended";
    configure(context, device, SDR);
    return { device, context, format: SDR, extended, adapterName };
}

/** The format and headroom to render with: HDR where both the display and the canvas can, and a headroom is chosen. */
function output() {
    const headroom = Number(root.querySelector('input[name="sky-headroom"]:checked')?.value ?? 1);
    const hdr = gpu.extended && hdrDisplay.matches && headroom > 1;
    return { format: hdr ? HDR : SDR, headroom: hdr ? headroom : 1 };
}

// On an HDR display, a note that it is one, and the headroom to choose; a display that is HDR but a canvas that cannot
// show it say so instead.
function showHdr() {
    const note = field("hdr");
    note.hidden = !hdrDisplay.matches;
    field("headroom").hidden = !(hdrDisplay.matches && gpu.extended);
    note.textContent = gpu.extended ? "HDR display" : "HDR display, SDR canvas";
    note.title = gpu.extended
        ? "The display shows more than SDR white, and the canvas renders into that headroom: half floats, extended sRGB"
        : "The display shows more than SDR white, but this browser's WebGPU canvas has no extended tone mapping";
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
 * The inverse view-projection the pass turns pixels back into rays with, built directly: of a reversed-z projection with
 * an infinite far plane, the near plane at 1, without translation. A clip-space point (x, y) maps to the direction
 * forward + x·tx·right + y·ty·up. Column major, like WGSL.
 */
function inverseViewProjection({ f, r, u, tx, ty }) {
    return new Float32Array([...r.map((c) => c * tx), 0, ...u.map((c) => c * ty), 0, 0, 0, 0, 1, ...f, 0]);
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// The eight compass directions as labels standing on the horizon, placed by the same projection the sky uses.
const labels = COMPASS.map((name) =>
    compass.appendChild(Object.assign(document.createElement("span"), { textContent: name })),
);

/** Where `direction` shows in the view, in pixels from the top left, by the same projection the shader inverts: the
 *  angle from the axis to the image plane radius. Null behind the camera. */
function project(direction, basis, width, height) {
    const cosTheta = dot(direction, basis.f);
    if (basis.d + cosTheta <= 1e-3 || (basis.d === 0 && cosTheta <= 0)) return null;
    const inPlane = [0, 1, 2].map((c) => direction[c] - basis.f[c] * cosTheta);
    const sinTheta = Math.hypot(...inPlane);
    const scale = sinTheta > 1e-9 ? imageRadius(Math.atan2(sinTheta, cosTheta), basis.d) / sinTheta : 1;
    const x = (dot(inPlane, basis.r) * scale) / basis.tx;
    const y = (dot(inPlane, basis.u) * scale) / basis.ty;
    return { x: ((x + 1) / 2) * width, y: ((1 - y) / 2) * height };
}

/** The view direction through a point of the view, `x` and `y` in pixels from the top left: dkProjectRay's twin. */
function unproject(px, py, basis, width, height) {
    const [x, y] = [(px / width) * 2 - 1, 1 - (py / height) * 2];
    const offset = [0, 1, 2].map((c) => basis.r[c] * basis.tx * x + basis.u[c] * basis.ty * y);
    const normalize = (v) => v.map((c) => c / Math.hypot(...v));
    if (basis.d <= 0) return normalize(basis.f.map((c, i) => c + offset[i]));
    const rho = Math.hypot(...offset);
    if (rho < 1e-7) return basis.f;
    const { d } = basis;
    const k = rho / (d + 1);
    const cosTheta = (Math.sqrt(1 + k * k * (1 - d * d)) - k * k * d) / (1 + k * k);
    const sinTheta = Math.sqrt(Math.max(1 - cosTheta * cosTheta, 0));
    return normalize(basis.f.map((c, i) => c * cosTheta + (offset[i] / rho) * sinTheta));
}

function placeCompass(basis, width, height) {
    compass.hidden = !pressed("grid");
    labels.forEach((label, i) => {
        const at = project([Math.sin(i * 45 * DEG), Math.cos(i * 45 * DEG), 0], basis, width, height);
        label.hidden = at === null;
        if (label.hidden) return;
        label.style.left = `${at.x}px`;
        label.style.top = `${at.y}px`;
    });
}

// The view ray the lookup and tables figures follow, where it shows in the sky.
const marker = field("pick");
function placeMarker(basis, width, height, sunDirection) {
    const ray = picked();
    const at =
        ray.kind === "view" ? project(viewDirection(ray.mu, ray.azimuth, sunDirection), basis, width, height) : null;
    marker.hidden = at === null || at.x < 0 || at.y < 0 || at.x > width || at.y > height;
    if (marker.hidden) return;
    marker.style.left = `${at.x}px`;
    marker.style.top = `${at.y}px`;
}

const gpu = setup();
// The last frame's camera and sun, for turning a click into a view ray.
let view = null;
let pass = null;
let passFor = {};
let skyViewFor = "";
// The settings of the pass being compiled, which takes its place once it is in.
let building = null;
const requestRender = onDemand(render);

/** Makes the pass for `settings` without blocking; the last one asked for takes over, and the old tables go with it. */
function buildPass(settings) {
    if (building && Object.entries(settings).every(([key, value]) => building[key] === value)) return;
    building = settings;
    const { luts, ...features } = settings;
    createSkyPass(gpu.device, { luts, ...features }).then((next) => {
        if (building !== settings) return next.destroy();
        if (settings.format !== gpu.format) {
            configure(gpu.context, gpu.device, settings.format);
            gpu.format = settings.format;
        }
        pass?.destroy();
        if (passFor.luts && passFor.luts !== luts) passFor.luts.destroy();
        pass = next;
        passFor = settings;
        building = null;
        requestRender();
    });
}

// Where the time goes, shown with the grid: the astronomy, the sky pass' own CPU work, and when the GPU was done.
function showTiming(astronomyMs, skyMs, submitted) {
    const text = (doneMs) =>
        `${gpu.adapterName} · precompute ${tables().precomputeMs.toFixed(1)} ms · astronomy ${astronomyMs.toFixed(2)} ms · ` +
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
    const { format, headroom } = output();
    // Half floats need no dither: their steps are far finer than 8 bits'.
    const dither = pressed("dither") && format === SDR;
    field("dither").disabled = format !== SDR;
    const autoExposure = pressed("auto");
    const table = tables();
    // Where the sun shows, lifted by the same air the sky is traced through.
    const [x, y, z] = apparentDirection(sunDirection, table.luts.model, clampObserverHeight(state.heightM));
    field("sun").textContent =
        `Sun ${position.altitude.toFixed(2)}° high (${(Math.asin(z) / DEG).toFixed(2)}° apparent), ` +
        `azimuth ${position.azimuth.toFixed(2)}°`;
    if (pressed("lock")) {
        camera.yaw = Math.atan2(x, y);
        camera.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, Math.asin(z)));
    }
    const skyStarted = performance.now();
    const { toneCurve: toneMap } = display;
    const settings = {
        luts: table.luts,
        debugGrid,
        groundLight: quality.groundLight,
        dither,
        autoExposure,
        toneMap,
        format,
        headroom,
    };
    if (Object.entries(settings).some(([key, value]) => passFor[key] !== value)) {
        // Shown once it is compiled; until then the canvas keeps the last frame.
        buildPass(settings);
        return;
    }

    const basis = cameraBasis(width / height);
    placeCompass(basis, canvas.clientWidth, canvas.clientHeight);
    placeMarker(basis, canvas.clientWidth, canvas.clientHeight, sunDirection);
    view = { basis, sunDirection };
    pass.update({
        sunDirection,
        sunAngularDiameter,
        observerHeightM: state.heightM,
        inverseViewProjection: inverseViewProjection(basis),
        projectionDistance: basis.d,
        ev100: evOfSlider(),
        autoExposureKeys: pressed("ramp") ? DEFAULT_AUTO_EXPOSURE_KEYS : [],
    });

    const encoder = gpu.device.createCommandEncoder();
    pass.encode(encoder, gpu.context.getCurrentTexture());
    gpu.device.queue.submit([encoder.finish()]);
    const submitted = performance.now();
    const skyViewKey = `${state.jd},${state.latitude},${state.longitude},${state.heightM}`;
    if (skyViewKey !== skyViewFor || pass !== passFor.notified) {
        skyViewFor = skyViewKey;
        passFor.notified = pass;
        const observerHeightM = clampObserverHeight(state.heightM);
        skyViewChanged({ pass, sunDirection, apparentSun: [x, y, z], sunAngularDiameter, observerHeightM });
    }
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
        paintRange(slider);
        field("ev").textContent = `${ev100.toFixed(1)} metered`;
    });
}

if (gpu) {
    bindToneCurveChoice(root.querySelectorAll('input[name="sky-tone"]'));
    bindModelChoice(root.querySelectorAll('input[name="sky-model"]'));
    showHdr();
    hdrDisplay.addEventListener("change", () => {
        showHdr();
        requestRender();
    });
    const headrooms = root.querySelectorAll('input[name="sky-headroom"]');
    for (const input of headrooms) input.addEventListener("change", requestRender);
    onDisplay(requestRender);
    onChange(requestRender);
    onTables(() => {
        field("refraction").setAttribute("aria-pressed", String(quality.refraction));
        requestRender();
    });
    new ResizeObserver(requestRender).observe(canvas);
    field("exposure").addEventListener("input", requestRender);
    for (const name of ["auto", "ramp", "lock", "grid", "refraction", "dither"]) {
        field(name).addEventListener("click", async () => {
            field(name).setAttribute("aria-pressed", String(!pressed(name)));
            // The environment and the lighting figure take their exposure from this meter: rebuilt with it.
            if (name === "ramp") skyViewFor = "";
            if (name === "refraction") {
                quality.refraction = pressed("refraction");
                await recompute();
            }
            requestRender();
        });
    }

    onPick(requestRender);
    canvas.addEventListener("pointerdown", (event) => {
        canvas.setPointerCapture(event.pointerId);
        const start = { x: event.clientX, y: event.clientY, yaw: camera.yaw, pitch: camera.pitch };
        // A click that does not drag picks the view ray through that pixel.
        canvas.addEventListener(
            "pointerup",
            (e) => {
                if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 3 || !view) return;
                const rect = canvas.getBoundingClientRect();
                const { basis, sunDirection } = view;
                const d = unproject(e.clientX - rect.left, e.clientY - rect.top, basis, rect.width, rect.height);
                pick({ kind: "view", mu: d[2], azimuth: azimuthFromSun(d, sunDirection) }, true);
            },
            { once: true },
        );
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
