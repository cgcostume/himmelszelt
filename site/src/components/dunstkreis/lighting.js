import { clampObserverHeight, createSkyPass } from "@himmelszelt/dunstkreis";
import { onDemand } from "../frame.js";
import { cameraFrame, createScene, SCENE_FRAMES } from "../scene/scene.js";
import { environment, gpu, onEnvironment, onTables, quality, tables } from "./atmosphere.js";

const DEG = Math.PI / 180;
const root = document.querySelector("#lighting");
const field = (name) => root.querySelector(`[data-field="${name}"]`);
const canvas = field("canvas");
const pressed = (name) => field(name).getAttribute("aria-pressed") === "true";

// Orbiting the solids' center, looking from the south-east and a little above.
const camera = { yaw: 150 * DEG, pitch: 18 * DEG, distance: 9, fov: 50 * DEG };

let context = null;
let scene = null;
// The turning solids' clock, running only while they turn.
let seconds = 0;
let last = null;
// Frames summed since the last change; the sum runs on by itself up to SCENE_FRAMES, then rests.
let frame = 0;
const chosen = (name, fallback) => root.querySelector(`input[name="${name}"]:checked`)?.value ?? fallback;
const shadowRays = () => Number(chosen("lighting-shadows", 8));
const liveSky = () => chosen("lighting-background", "atmosphere") === "atmosphere";

// The atmosphere behind the solids, rendered live through the scene's camera by a sky pass of the scene's own, linear
// and unexposed: the sky map's texels blur the horizon with the unlit planet below it.
let skyPass = null;
let skyPassFor = {};
let background = null;

function renderBackground(encoder, width, height) {
    const { luts } = tables();
    const sunDisc = pressed("sunDisc");
    const { groundSamples } = quality;
    if (skyPassFor.luts !== luts || skyPassFor.sunDisc !== sunDisc || skyPassFor.groundSamples !== groundSamples) {
        skyPass?.destroy();
        const options = { luts, format: "rgba16float", toneMap: false, dither: false, sunDisc, groundSamples };
        skyPass = createSkyPass(gpu.device, options);
        skyPassFor = { luts, sunDisc, groundSamples };
    }
    if (background?.width !== width || background?.height !== height) {
        background?.destroy();
        background = gpu.device.createTexture({
            label: "sternwarte:lightingBackground",
            size: { width, height },
            format: "rgba16float",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        });
    }
    const { eye, forward, right, up } = cameraFrame(camera);
    const ty = Math.tan(camera.fov / 2);
    const tx = ty * (width / height);
    const { sky } = environment;
    skyPass.update({
        sunDirection: sky.sunDirection,
        sunAngularDiameter: sky.sunAngularDiameter,
        // Where the camera is, not where the observer stands: moving out lifts it into the air.
        observerHeightM: clampObserverHeight(eye[2]),
        inverseViewProjection: new Float32Array([
            ...right.map((c) => c * tx),
            0,
            ...up.map((c) => c * ty),
            0,
            ...forward,
            0,
            0,
            0,
            0,
            1,
        ]),
        projectionDistance: 0,
        // An exposure of exactly 1: the luminance itself.
        ev100: -Math.log2(1.2),
        autoExposure: false,
    });
    skyPass.encode(encoder, background);
    return background;
}

function render() {
    if (!environment.cube) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });

    const now = performance.now();
    if (pressed("rotate") && last !== null) seconds += (now - last) / 1000;
    last = pressed("rotate") ? now : null;

    const { cube, ibl, sun, ev100, sky } = environment;
    const encoder = gpu.device.createCommandEncoder({ label: "sternwarte:lighting" });
    // The background only changes with the frame's start, not over the running sum.
    const live = liveSky() ? (frame === 0 ? renderBackground(encoder, width, height) : background) : null;
    scene.encode(encoder, context.getCurrentTexture(), {
        background: live,
        cube,
        sh: ibl.sh,
        camera,
        sunDirection: sky.apparentSun,
        sunAngularDiameter: sky.sunAngularDiameter,
        sunIlluminance: sun,
        ev100,
        sunDisc: pressed("sunDisc"),
        occlusionRays: pressed("occlusion") ? 16 : 0,
        shadowRays: shadowRays(),
        seconds,
        frame,
    });
    gpu.device.queue.submit([encoder.finish()]);
    const lux = 0.2126 * sun[0] + 0.7152 * sun[1] + 0.0722 * sun[2];
    const altitude = cameraFrame(camera).eye[2];
    field("info").textContent =
        `camera ${altitude < 1000 ? `${altitude.toFixed(1)} m` : `${(altitude / 1000).toFixed(2)} km`} up · ` +
        `sunlight ${Math.round(lux).toLocaleString("en")} lux · EV ${ev100.toFixed(1)} metered`;
    // Turning runs on by itself while asked to, each frame a new start; otherwise the sum runs on until it is done.
    if (pressed("rotate")) {
        frame = 0;
        requestRender();
    } else if (frame + 1 < SCENE_FRAMES) {
        frame += 1;
        requestRender();
    }
}

const requestRender = onDemand(render);
/** Anything that changes the picture starts the sum over. */
function restart() {
    frame = 0;
    requestRender();
}

if (gpu.error) {
    canvas.replaceWith(
        Object.assign(document.createElement("div"), { className: "sky-error", innerHTML: `<p>${gpu.error}</p>` }),
    );
} else {
    context = canvas.getContext("webgpu");
    context.configure({
        device: gpu.device,
        format: "rgba8unorm",
        alphaMode: "opaque",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING,
    });
    scene = createScene(gpu.device);
    onEnvironment(restart);
    onTables(restart);
    new ResizeObserver(restart).observe(canvas);
    for (const radio of root.querySelectorAll('input[name="lighting-shadows"], input[name="lighting-background"]'))
        radio.addEventListener("change", restart);
    for (const name of ["rotate", "sunDisc", "occlusion"]) {
        field(name).addEventListener("click", () => {
            field(name).setAttribute("aria-pressed", String(!pressed(name)));
            restart();
        });
    }
    canvas.addEventListener("pointerdown", (event) => {
        canvas.setPointerCapture(event.pointerId);
        const start = { x: event.clientX, y: event.clientY, yaw: camera.yaw, pitch: camera.pitch };
        const move = (e) => {
            const perPixel = camera.fov / canvas.clientHeight;
            camera.yaw = start.yaw + (e.clientX - start.x) * perPixel;
            camera.pitch = Math.max(-5 * DEG, Math.min(89 * DEG, start.pitch + (e.clientY - start.y) * perPixel));
            restart();
        };
        canvas.addEventListener("pointermove", move);
        canvas.addEventListener("pointerup", () => canvas.removeEventListener("pointermove", move), { once: true });
    });
    canvas.addEventListener(
        "wheel",
        (event) => {
            event.preventDefault();
            camera.distance = Math.max(3, Math.min(1e6, camera.distance * Math.exp(event.deltaY * 0.002)));
            restart();
        },
        { passive: false },
    );
    restart();
}
