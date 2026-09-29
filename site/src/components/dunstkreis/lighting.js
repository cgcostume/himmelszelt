import { clampObserverHeight, createSkyPass } from "@himmelszelt/dunstkreis";
import { onDemand } from "../frame.js";
import { cameraFrame, createScene } from "../scene/scene.js";
import { bindCubifyToggle, environment, gpu, onEnvironment, onTables, quality, tables } from "./atmosphere.js";

const DEG = Math.PI / 180;
const root = document.querySelector("#lighting");
const field = (name) => root.querySelector(`[data-field="${name}"]`);
const canvas = field("canvas");
const pressed = (name) => field(name).getAttribute("aria-pressed") === "true";

// Orbiting the solids' center, looking from the south-east and a little above.
const camera = { yaw: 150 * DEG, pitch: 18 * DEG, distance: 6, fov: 50 * DEG };

let context = null;
let scene = null;
// The turning solids' clock, running only while they turn.
let seconds = 0;
let last = null;
const chosen = (name, fallback) => root.querySelector(`input[name="${name}"]:checked`)?.value ?? fallback;
const shadowRays = () => Number(chosen("lighting-shadows", 8));
const occlusionRays = () => Number(chosen("lighting-occlusion", 8));
const liveSky = () => chosen("lighting-background", "atmosphere") === "atmosphere";
const ground = () => chosen("lighting-ground", "backdrop");

// The atmosphere behind the solids, rendered live through the scene's camera by a sky pass of the scene's own, linear
// and unexposed: the sky map's texels blur the horizon with the unlit planet below it.
let skyPass = null;
let skyPassFor = {};
let background = null;

function renderBackground(encoder, width, height) {
    const { luts } = tables();
    const { groundSamples } = quality;
    // Without the sun disc: the scene draws it itself, after tone mapping, to smooth its edge.
    if (skyPassFor.luts !== luts || skyPassFor.groundSamples !== groundSamples) {
        skyPass?.destroy();
        const options = { luts, format: "rgba16float", toneMap: false, dither: false, sunDisc: false, groundSamples };
        skyPass = createSkyPass(gpu.device, options);
        skyPassFor = { luts, groundSamples };
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
    const live = liveSky() ? renderBackground(encoder, width, height) : null;
    scene.encode(encoder, context.getCurrentTexture(), {
        background: live,
        cube,
        cubified: environment.cubified,
        sh: ibl.sh,
        camera,
        sunDirection: sky.apparentSun,
        sunAngularDiameter: sky.sunAngularDiameter,
        sunIlluminance: sun,
        ev100,
        sunDisc: pressed("sunDisc"),
        bloom: { off: 0, light: 0.35, strong: 1 }[chosen("lighting-bloom", "strong")],
        godRaySamples: Number(chosen("lighting-godrays", 8)),
        // The air thins with a scale height of 8 km, the haze in it with 1.2 km.
        airDensity: Math.exp(-cameraFrame(camera).eye[2] / 8000),
        hazeDensity: Math.exp(-cameraFrame(camera).eye[2] / 1200),
        occlusionRays: occlusionRays(),
        shadowRays: shadowRays(),
        sunLight: pressed("sunLight"),
        skyLight: pressed("skyLight"),
        ground: ground(),
        seconds,
    });
    gpu.device.queue.submit([encoder.finish()]);
    const lux = 0.2126 * sun[0] + 0.7152 * sun[1] + 0.0722 * sun[2];
    const altitude = cameraFrame(camera).eye[2];
    const up = altitude < 1000 ? `${altitude.toFixed(1)} m` : `${(altitude / 1000).toFixed(2)} km`;
    field("info").innerHTML =
        `<span class="status-title">camera</span> ${up} up; ` +
        `<span class="status-title">sunlight</span> ${Math.round(lux).toLocaleString("en")} lux; ` +
        `<span class="status-title">exposure</span> EV ${ev100.toFixed(1)}, metered`;
    // One frame per change; only turning runs on by itself, while asked to.
    if (pressed("rotate")) requestRender();
}

const requestRender = onDemand(render);

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
    onEnvironment(requestRender);
    // Rebuilds the sky map, which renders anew once it is in.
    bindCubifyToggle(root.querySelector("[data-cubify]"));
    onTables(requestRender);
    new ResizeObserver(requestRender).observe(canvas);
    for (const radio of root.querySelectorAll(
        'input[name="lighting-shadows"], input[name="lighting-background"], input[name="lighting-ground"], input[name="lighting-occlusion"], input[name="lighting-godrays"], input[name="lighting-bloom"]',
    ))
        radio.addEventListener("change", requestRender);
    for (const name of ["rotate", "sunDisc", "sunLight", "skyLight"]) {
        field(name).addEventListener("click", () => {
            field(name).setAttribute("aria-pressed", String(!pressed(name)));
            requestRender();
        });
    }
    canvas.addEventListener("pointerdown", (event) => {
        canvas.setPointerCapture(event.pointerId);
        const start = { x: event.clientX, y: event.clientY, yaw: camera.yaw, pitch: camera.pitch };
        const move = (e) => {
            const perPixel = camera.fov / canvas.clientHeight;
            camera.yaw = start.yaw + (e.clientX - start.x) * perPixel;
            camera.pitch = Math.max(-5 * DEG, Math.min(89 * DEG, start.pitch + (e.clientY - start.y) * perPixel));
            requestRender();
        };
        canvas.addEventListener("pointermove", move);
        canvas.addEventListener("pointerup", () => canvas.removeEventListener("pointermove", move), { once: true });
    });
    canvas.addEventListener(
        "wheel",
        (event) => {
            event.preventDefault();
            camera.distance = Math.max(1.5, Math.min(1e6, camera.distance * Math.exp(event.deltaY * 0.002)));
            requestRender();
        },
        { passive: false },
    );
    requestRender();
}
