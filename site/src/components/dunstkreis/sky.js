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
    bindHdr,
    bindModelChoice,
    bindToneCurveChoice,
    configureCanvas,
    display,
    displayOutput,
    onDisplay,
    onTables,
    quality,
    recompute,
    SDR,
    gpu as shared,
    skyViewChanged,
    tables,
} from "./atmosphere.js";

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

function setup() {
    if (shared.error) {
        showError(shared.error);
        return null;
    }
    const { device, adapterName } = shared;
    const context = canvas.getContext("webgpu");
    configureCanvas(context, SDR);
    return { device, context, format: SDR, adapterName };
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

const gpu = setup();
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
            configureCanvas(gpu.context, settings.format);
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
    const { format, headroom } = displayOutput();
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
    bindHdr(root.querySelector('[data-hdr="note"]'), root.querySelector('[data-hdr="choice"]'));
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
