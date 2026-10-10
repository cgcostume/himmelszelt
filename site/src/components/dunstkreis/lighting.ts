import type { AtmosphereLUTs, SkyPass, SkyPassOptions } from "@himmelszelt/dunstkreis";
import { apparentDirection, clampObserverHeight, createSkyPass } from "@himmelszelt/dunstkreis";
import type { Direction } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { onDemand } from "../frame";
import { cameraFrame, createScene } from "../scene/scene";
import {
    bindCubifyToggle,
    bindHdr,
    bindScaledToggle,
    configureCanvas,
    display,
    displayOutput,
    environment,
    gpu,
    gpuDevice,
    onDisplay,
    onEnvironment,
    onTables,
    quality,
    SDR,
    type Sky,
    tables,
} from "./atmosphere";
import { geometry } from "./lutmap";

const DEG = Math.PI / 180;
const root = find("#lighting");
const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
const canvas = field<HTMLCanvasElement>("canvas");
const pressed = (name: string) => field(name).getAttribute("aria-pressed") === "true";

// Orbiting the solids' center, looking from the south-east and a little above.
const camera = { yaw: 150 * DEG, pitch: 18 * DEG, distance: 6, fov: 50 * DEG };

// The camera looks down on the solids' center, 0.6 above the ground, at most 5 degrees up, and never from below the
// ground: from far away, looking up even a little would take it under.
const GROUND_CLEARANCE = 0.05;
function setPitch(pitch: number) {
    const lowest = Math.asin(Math.max(-1, -(0.6 - GROUND_CLEARANCE) / camera.distance));
    camera.pitch = Math.max(-5 * DEG, lowest, Math.min(89 * DEG, pitch));
}

let context: GPUCanvasContext | null = null;
let scene: ReturnType<typeof createScene> | null = null;
// The turning solids' clock, running only while they turn.
let seconds = 0;
let last: number | null = null;
const chosen = (name: string, fallback: string | number) =>
    root.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? String(fallback);
const shadowRays = () => Number(chosen("lighting-shadows", 8));
const occlusionRays = () => Number(chosen("lighting-occlusion", 8));
const liveSky = () => chosen("lighting-background", "atmosphere") === "atmosphere";
const ground = () => chosen("lighting-ground", "backdrop") as "floor" | "backdrop";

// The atmosphere behind the solids, rendered live through the scene's camera by a sky pass of the scene's own, linear
// and unexposed: the sky map's texels blur the horizon with the unlit planet below it.
let skyPass: SkyPass | null = null;
let skyPassFor: Partial<SkyPassOptions> = {};
let building: Partial<SkyPassOptions> | null = null;
let background: GPUTexture | null = null;
/** The camera's height above sea level: the scene stands where the observer does, the camera that far above it. */
const cameraHeight = () => clampObserverHeight((environment.sky?.observerHeightM ?? 0) + cameraFrame(camera).eye[2]);

// Where the camera sees the sun, for its veil, cached for the sun and height it was traced for.
let apparentFor: { key: string; direction: Direction } | null = null;

/**
 * The sun the scene draws itself, and its veil. Behind the live atmosphere, the sky pass draws the disc, pixel by pixel
 * along each bent ray as in the sky figure; the scene only needs where the sun shows from the camera, for its veil.
 * Behind the sky map, the scene draws the disc too, as the map was built: from the observer, at the moment and height
 * of that build, so the disc stays in the map's glow.
 */
function sunSeen(live: boolean, luts: AtmosphereLUTs, sky: Sky) {
    const height = live ? cameraHeight() : sky.observerHeightM;
    // The visible horizon, lifted by the air's bending like the sky's own: the disc is hidden below it.
    const horizonZ = geometry(luts.model).horizonMu(height / 1000);
    if (!live) return { discDirection: sky.apparentSun, discIlluminance: environment.sun, horizonZ };
    const key = `${sky.sunDirection},${height},${luts.model.refractivity}`;
    if (apparentFor?.key !== key) {
        apparentFor = { key, direction: apparentDirection(sky.sunDirection, luts.model, height) };
    }
    return { discDirection: apparentFor.direction, discIlluminance: environment.sun, horizonZ };
}

/** Whether the sky pass is ready for the current settings; if not, it is compiled, and renders once it is in. */
function readySkyPass(luts: AtmosphereLUTs) {
    // With the sun disc, drawn along every bent ray, as the sky figure draws it.
    const settings = { luts, groundLight: quality.groundLight, sunDisc: pressed("sunDisc") };
    const same = (other: object | null) =>
        other !== null &&
        Object.entries(settings).every(([key, value]) => (other as Record<string, unknown>)[key] === value);
    if (same(skyPassFor)) return true;
    if (same(building)) return false;
    building = settings;
    createSkyPass(gpuDevice(), { ...settings, format: "rgba16float", toneMap: false }).then((next) => {
        if (building !== settings) return next.destroy();
        skyPass?.destroy();
        skyPass = next;
        skyPassFor = settings;
        building = null;
        requestRender();
    });
    return false;
}

function updateSkyPass(pass: SkyPass, sky: Sky, width: number, height: number) {
    const { forward, right, up } = cameraFrame(camera);
    const ty = Math.tan(camera.fov / 2);
    const tx = ty * (width / height);
    pass.update({
        sunDirection: sky.sunDirection,
        sunAngularDiameter: sky.sunAngularDiameter,
        // Where the camera is, not where the observer stands: moving out lifts it into the air.
        observerHeightM: cameraHeight(),
        // A reversed-z projection's with an infinite far plane, the near plane at 1, as the sky figure's.
        inverseViewProjection: new Float32Array([
            ...right.map((c) => c * tx),
            0,
            ...up.map((c) => c * ty),
            0,
            0,
            0,
            0,
            1,
            ...forward,
            0,
        ]),
        projectionDistance: 0,
        // An exposure of exactly 1: the luminance itself.
        ev100: -Math.log2(1.2),
    });
}

function renderBackground(encoder: GPUCommandEncoder, pass: SkyPass, sky: Sky, width: number, height: number) {
    updateSkyPass(pass, sky, width, height);
    if (!background || background.width !== width || background.height !== height) {
        background?.destroy();
        background = gpuDevice().createTexture({
            label: "sternwarte:lightingBackground",
            size: { width, height },
            format: "rgba16float",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        });
    }
    pass.encode(encoder, background);
    return background;
}

function render() {
    const table = tables();
    const { cube, ibl, sun, ev100, sky } = environment;
    if (!cube || !ibl || !sky || !table || !context || !scene) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });

    const now = performance.now();
    if (pressed("rotate") && last !== null) seconds += (now - last) / 1000;
    last = pressed("rotate") ? now : null;

    if (liveSky() && !readySkyPass(table.luts)) return;
    const { format, headroom } = displayOutput();
    if (context.getConfiguration()?.format !== format) configureCanvas(context, format);
    field<HTMLButtonElement>("dither").disabled = format !== SDR;
    const encoder = gpuDevice().createCommandEncoder({ label: "sternwarte:lighting" });
    const live = liveSky() && skyPass ? renderBackground(encoder, skyPass, sky, width, height) : null;
    const seen = sunSeen(live !== null, table.luts, sky);
    scene.encode(encoder, context.getCurrentTexture(), {
        background: live,
        cube,
        cubified: environment.cubified,
        skyScale: environment.scale,
        sh: ibl.sh,
        camera,
        sunDirection: sky.apparentSun,
        sunAngularDiameter: sky.sunAngularDiameter,
        sunIlluminance: sun,
        ...seen,
        ev100,
        // Behind the live atmosphere, the sky pass has drawn the disc already.
        sunDisc: pressed("sunDisc") && live === null,
        bloom: ({ off: 0, light: 0.35, strong: 1 } as Record<string, number>)[chosen("lighting-bloom", "strong")],
        godRaySamples: Number(chosen("lighting-godrays", 8)),
        // The air thins with a scale height of 8 km, the haze in it with 1.2 km.
        airDensity: Math.exp(-cameraFrame(camera).eye[2] / 8000),
        hazeDensity: Math.exp(-cameraFrame(camera).eye[2] / 1200),
        occlusionRays: occlusionRays(),
        shadowRays: shadowRays(),
        sunLight: pressed("sunLight"),
        skyLight: pressed("skyLight"),
        // Half floats need no dither: their steps are far finer than 8 bits'.
        dither: pressed("dither") && format === SDR,
        toneCurve: display.toneCurve,
        headroom,
        ground: ground(),
        seconds,
    });
    gpuDevice().queue.submit([encoder.finish()]);
    const lux = 0.2126 * sun[0] + 0.7152 * sun[1] + 0.0722 * sun[2];
    const meters = (m: number) => (m < 1000 ? `${m.toFixed(1)}\u202fm` : `${(m / 1000).toFixed(2)}\u202fkm`);
    field("info").innerHTML =
        `<span class="status-title">camera</span> ${meters(cameraFrame(camera).eye[2])} above the observer, ` +
        `${meters(cameraHeight())} up; ` +
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
    if (context) configureCanvas(context, SDR);
    bindHdr(find('[data-hdr="note"]', root), find('[data-hdr="choice"]', root));
    scene = createScene(gpuDevice());
    onEnvironment(requestRender);
    // Rebuilds the sky map, which renders anew once it is in.
    bindCubifyToggle(find("[data-cubify]", root));
    bindScaledToggle(find("[data-scaled]", root));
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(canvas);
    for (const radio of root.querySelectorAll(
        'input[name="lighting-shadows"], input[name="lighting-background"], input[name="lighting-ground"], input[name="lighting-occlusion"], input[name="lighting-godrays"], input[name="lighting-bloom"]',
    ))
        radio.addEventListener("change", requestRender);
    for (const name of ["rotate", "sunDisc", "sunLight", "skyLight", "dither"]) {
        field(name).addEventListener("click", () => {
            field(name).setAttribute("aria-pressed", String(!pressed(name)));
            requestRender();
        });
    }
    canvas.addEventListener("pointerdown", (event) => {
        canvas.setPointerCapture(event.pointerId);
        const start = { x: event.clientX, y: event.clientY, yaw: camera.yaw, pitch: camera.pitch };
        const move = (e: PointerEvent) => {
            const perPixel = camera.fov / canvas.clientHeight;
            camera.yaw = start.yaw + (e.clientX - start.x) * perPixel;
            setPitch(start.pitch + (e.clientY - start.y) * perPixel);
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
            setPitch(camera.pitch);
            requestRender();
        },
        { passive: false },
    );
    requestRender();
}
