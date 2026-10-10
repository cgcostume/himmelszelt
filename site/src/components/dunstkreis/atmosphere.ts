import type { AtmosphereLUTs, IrradiancePass, SkyCubePass, SkyPass } from "@himmelszelt/dunstkreis";
import {
    createIrradiancePass,
    DEFAULT_ATMOSPHERE_MODEL,
    DEFAULT_TEXTURE_CONFIG,
    OSGHIMMEL_ATMOSPHERE_MODEL,
    precomputeAtmosphere,
    RGB_ATMOSPHERE_MODEL,
    skyRequirements,
} from "@himmelszelt/dunstkreis";
import type { Direction } from "@himmelszelt/sternzeit";
import type { ToneCurve } from "../scene/scene";

/**
 * The GPU and the tables the whole page shares: the sky renders with them, the tables figure configures and shows
 * them. Whoever swaps its pass to new tables destroys the old ones.
 */

async function acquire(): Promise<{ device?: GPUDevice; adapterName?: string; error?: string }> {
    if (!navigator.gpu) {
        return {
            error:
                'This figure needs WebGPU, which this browser does not expose. See <a href="https://caniuse.com/webgpu" ' +
                'target="_blank" rel="noopener">caniuse.com/webgpu</a>.',
        };
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
        // Mostly Linux, where Chrome still ships WebGPU behind a flag: the API is there, but no adapter behind it.
        return {
            error:
                "WebGPU is there, but without a GPU adapter. On Linux, Chrome needs " +
                "<code>chrome://flags/#enable-unsafe-webgpu</code> enabled and a restart.",
        };
    }
    // With subgroups where the GPU has them, for the sums over a workgroup.
    const device = await adapter.requestDevice(skyRequirements({ format: "rgba8unorm" }, adapter));
    // Which GPU, for the timings: a fallback adapter renders on the CPU, a hundred times slower.
    const { vendor, architecture, description, isFallbackAdapter } = adapter.info ?? {};
    const name = description || [vendor, architecture].filter(Boolean).join(" ") || "unknown GPU";
    return { device, adapterName: isFallbackAdapter ? `${name}, a CPU fallback` : name };
}

export const gpu = await acquire();

/** The page's GPU device, for code that runs only once `gpu.error` has been ruled out. */
export function gpuDevice(): GPUDevice {
    if (!gpu.device) throw new Error(gpu.error);
    return gpu.device;
}

/**
 * What the tables are computed with: the model, four wavelengths or three as RGB or osgHimmel's, refraction on or off, sizes and sample counts, and whether the sky lights the
 * ground in the sky-view table.
 */
export type ModelName = keyof typeof MODELS;

export const quality = {
    model: "fitted" as ModelName,
    refraction: true,
    config: structuredClone(DEFAULT_TEXTURE_CONFIG),
    groundLight: true,
};

const events = new EventTarget();

/**
 * How the page's figures show the sky on a display, shared by all: the tone curve, "neutral", "agx", "aces" or "clip",
 * and the headroom chosen for an HDR display, how many times SDR white it may show.
 */
export const display = { toneCurve: "neutral" as ToneCurve, headroom: 4 };
export const onDisplay = (listener: (current: typeof display) => void) =>
    events.addEventListener("display", () => listener(display));

// A figure writes its canvas by a compute pass: rgba8unorm, which storage textures take everywhere, or on an HDR display
// rgba16float, extended sRGB, whose values above 1 show brighter than SDR white.
export const SDR: GPUTextureFormat = "rgba8unorm";
export const HDR: GPUTextureFormat = "rgba16float";
export const hdrDisplay = window.matchMedia("(dynamic-range: high)");
hdrDisplay.addEventListener("change", () => events.dispatchEvent(new Event("display")));

/** Configures a figure's canvas for `format`, extended tone mapping for HDR, to be written by a compute pass. */
export function configureCanvas(context: GPUCanvasContext, format: GPUTextureFormat) {
    const toneMapping: GPUCanvasToneMapping = { mode: format === HDR ? "extended" : "standard" };
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING;
    context.configure({ device: gpuDevice(), format, alphaMode: "opaque", usage, toneMapping });
}

// Whether a canvas takes extended tone mapping at all: a browser without it drops the member it does not know.
let extended: boolean | null = null;
function canvasExtended() {
    if (extended === null && gpu.device) {
        const context = document.createElement("canvas").getContext("webgpu");
        if (context) {
            configureCanvas(context, HDR);
            extended = context.getConfiguration?.()?.toneMapping?.mode === "extended";
            context.unconfigure();
        }
    }
    return extended === true;
}

/** The format and headroom to render with: HDR where both the display and the canvas can, and a headroom is chosen. */
export function displayOutput() {
    const hdr = canvasExtended() && hdrDisplay.matches && display.headroom > 1;
    return { format: hdr ? HDR : SDR, headroom: hdr ? display.headroom : 1 };
}

/**
 * The headroom radios of a figure and its note (Hdr.astro): "HDR off" chosen and the headrooms disabled where the
 * display or the canvas cannot show HDR, the note on an HDR display only; choosing a headroom switches every figure.
 */
export function bindHdr(note: HTMLElement, choice: Element) {
    const show = () => {
        const can = canvasExtended();
        const available = can && hdrDisplay.matches;
        note.hidden = !hdrDisplay.matches;
        note.textContent = can ? "HDR display" : "HDR display, SDR canvas";
        note.title = can
            ? "The display shows more than SDR white, and the canvas renders into that headroom: half floats, extended sRGB"
            : "The display shows more than SDR white, but this browser's WebGPU canvas has no extended tone mapping";
        for (const input of choice.querySelectorAll("input")) {
            const headroom = Number(input.value);
            input.disabled = !available && headroom > 1;
            input.checked = headroom === (available ? display.headroom : 1);
            const label = input.parentElement;
            if (!label) continue;
            label.dataset.title ??= label.title;
            const why = hdrDisplay.matches
                ? "This browser's WebGPU canvas has no extended tone mapping"
                : "Not an HDR display, or HDR is off in the system's display settings";
            label.title = input.disabled ? why : label.dataset.title;
        }
    };
    show();
    onDisplay(show);
    for (const input of choice.querySelectorAll("input")) {
        input.addEventListener("change", () => {
            display.headroom = Number(input.value);
            events.dispatchEvent(new Event("display"));
        });
    }
}

/** Tone curve radios, `name="…"` inputs of the curves' values: choosing one switches every figure. */
export function bindToneCurveChoice(inputs: Iterable<HTMLInputElement>) {
    for (const input of inputs) {
        input.checked = input.value === display.toneCurve;
        input.addEventListener("change", () => {
            display.toneCurve = input.value as ToneCurve;
            events.dispatchEvent(new Event("display"));
        });
    }
}

const MODELS = { fitted: DEFAULT_ATMOSPHERE_MODEL, rgb: RGB_ATMOSPHERE_MODEL, osghimmel: OSGHIMMEL_ATMOSPHERE_MODEL };

/** Model radios: four wavelengths, three as RGB or osgHimmel's; choosing one recomputes every table on the page. */
export function bindModelChoice(inputs: Iterable<HTMLInputElement>) {
    for (const input of inputs) {
        input.checked = input.value === quality.model;
        input.addEventListener("change", () => {
            quality.model = input.value as ModelName;
            recompute();
        });
    }
}
export type Tables = { luts: AtmosphereLUTs; precomputeMs: number };
let current: Tables | null = null;
let running: Promise<void> | null = null;
let again = false;

/** The tables computed last, with how long that took: `{ luts, precomputeMs }`. */
export const tables = () => current;

/** Calls `listener` whenever new tables are in, or the sky passes built on them have to be made anew. */
export const onTables = (listener: (tables: Tables | null) => void) =>
    events.addEventListener("tables", () => listener(current));

/**
 * A refraction button, one of several over the page: every table and cube map is traced through the bent air, so
 * pressing any one recomputes them all, and every button follows.
 */
export function bindRefractionToggle(button: Element) {
    const show = () => button.setAttribute("aria-pressed", String(quality.refraction));
    show();
    onTables(show);
    button.addEventListener("click", () => {
        quality.refraction = !quality.refraction;
        recompute();
    });
}

/**
 * Calls `listener({ pass, sunDirection, apparentSun, sunAngularDiameter, observerHeightM })` whenever the sky pass may
 * have rebuilt its sky-view table: the pass, where the sun is, where it shows, how large, and from how high.
 */
export type Sky = {
    pass: SkyPass;
    sunDirection: Direction;
    apparentSun: Direction;
    sunAngularDiameter: number;
    observerHeightM: number;
};
export const onSkyView = (listener: (sky: Sky) => void) =>
    events.addEventListener("skyView", (event) => listener((event as CustomEvent<Sky>).detail));
export function skyViewChanged(sky: Sky) {
    events.dispatchEvent(new CustomEvent("skyView", { detail: sky }));
    lastSky = sky;
    pendingSky = sky;
    buildEnvironment();
}

/**
 * The sky as an environment to light a scene with, rebuilt along with the sky view: its cube map, without the sun
 * disc, the irradiance pass holding its nine coefficients and irradiance cube map, the coefficients read back, the
 * sunlight at the observer in lux, the metered EV100, and the sky it was built from. Scaled, the cube map, the
 * coefficients and the irradiance hold the light times `scale`, 1 otherwise.
 */
export const environment: {
    size: number;
    irradianceSize: number;
    cubify: boolean;
    cubified?: boolean;
    scaled: boolean;
    scaledWith?: boolean;
    scale: number;
    cube: GPUTexture | null;
    ibl: IrradiancePass | null;
    sh: Float32Array | null;
    sun: ArrayLike<number> & Iterable<number>;
    ev100: number;
    sky: Sky | null;
    buildMs?: number;
} = {
    size: 512,
    irradianceSize: 32,
    cubify: false,
    scaled: false,
    scale: 1,
    cube: null,
    ibl: null,
    sh: null,
    sun: [0, 0, 0],
    ev100: 14,
    sky: null,
};
export type Environment = typeof environment;
export const onEnvironment = (listener: (current: Environment) => void) =>
    events.addEventListener("environment", () => listener(environment));

let lastSky: Sky | null = null;
let pendingSky: Sky | null = null;
let building = false;
let retired: GPUTexture | null = null;
let retiredIbl: IrradiancePass | null = null;
// The cube pass, made for the sky pass and the cubify it was asked for.
let cubePassFor: { pass?: SkyPass; cubify?: boolean; scaled?: boolean; cubePass?: SkyCubePass } = {};

const cubifyToggles = new Set<Element>();
const scaledToggles = new Set<Element>();

/** Rebuilds the environment with its cube map cubified or not: texels spread evenly over the sphere, see cube.wgsl. */
export function setEnvironmentCubify(cubify: boolean) {
    environment.cubify = cubify;
    for (const button of cubifyToggles) button.setAttribute("aria-pressed", String(cubify));
    pendingSky = lastSky;
    buildEnvironment();
}

/** A cubified button, one of several: the sky cube is built cubified, and whoever samples it follows. */
export function bindCubifyToggle(button: Element) {
    cubifyToggles.add(button);
    button.setAttribute("aria-pressed", String(environment.cubify));
    button.addEventListener("click", () => setEnvironmentCubify(!environment.cubify));
}

/** Rebuilds the environment with its cube map scaled or not: times a power of two that follows the sun, or in cd/m². */
export function setEnvironmentScaled(scaled: boolean) {
    environment.scaled = scaled;
    for (const button of scaledToggles) button.setAttribute("aria-pressed", String(scaled));
    pendingSky = lastSky;
    buildEnvironment();
}

/** A scaled button, one of several: the sky cube is built scaled, and whoever reads it divides by the scale. */
export function bindScaledToggle(button: Element) {
    scaledToggles.add(button);
    button.setAttribute("aria-pressed", String(environment.scaled));
    button.addEventListener("click", () => setEnvironmentScaled(!environment.scaled));
}

/** Rebuilds the environment with an irradiance cube map of faces of `size` texels. */
export function setIrradianceSize(size: number) {
    environment.irradianceSize = size;
    pendingSky = lastSky;
    buildEnvironment();
}

/** Rebuilds the environment with cube map faces of `size` texels. */
export function setEnvironmentSize(size: number) {
    environment.size = size;
    pendingSky = lastSky;
    buildEnvironment();
}

// One build at a time: while the sky moves on, only its latest state is built next.
async function buildEnvironment() {
    if (building || !pendingSky) return;
    building = true;
    const sky = pendingSky;
    pendingSky = null;
    const started = performance.now();
    const device = gpuDevice();
    let { cube } = environment;
    if (!cube || cube.width !== environment.size) {
        // Kept one build longer: whoever still reads the old one finishes first.
        retired?.destroy();
        retired = cube;
        cube = device.createTexture({
            label: "sternwarte:skyCube",
            size: { width: environment.size, height: environment.size, depthOrArrayLayers: 6 },
            mipLevelCount: Math.floor(Math.log2(environment.size)) + 1,
            format: "rgba16float",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
            textureBindingViewDimension: "cube",
        });
    }
    const { cubify, scaled } = environment;
    let { ibl } = environment;
    if (!ibl || ibl.irradiance.width !== environment.irradianceSize || environment.cubified !== cubify) {
        // Like the cube, the old one is kept one build longer.
        retiredIbl?.destroy();
        retiredIbl = ibl;
        ibl = await createIrradiancePass(device, { size: environment.irradianceSize, cubified: cubify });
    }
    let { cubePass } = cubePassFor;
    if (!cubePass || cubePassFor.pass !== sky.pass || cubePassFor.cubify !== cubify || cubePassFor.scaled !== scaled) {
        cubePass = await sky.pass.createCubePass({ format: "rgba16float", samples: 8, cubify, scaled });
        cubePassFor = { pass: sky.pass, cubify, scaled, cubePass };
    }
    const encoder = device.createCommandEncoder({ label: "sternwarte:environment" });
    cubePass.encode(encoder, cube);
    // The scale it is written with, read as it is encoded: the next update may change it.
    const scale = scaled ? sky.pass.skyViewScale : 1;
    ibl.encode(encoder, cube);
    device.queue.submit([encoder.finish()]);
    const [sh, sun, ev100] = await Promise.all([ibl.readSH(), sky.pass.sunIlluminance(), sky.pass.meteredEV100()]);
    Object.assign(environment, {
        cube,
        cubified: cubify,
        scaledWith: scaled,
        scale,
        ibl,
        sh,
        sun,
        ev100,
        sky,
        buildMs: performance.now() - started,
    });
    events.dispatchEvent(new Event("environment"));
    building = false;
    buildEnvironment();
}

/** Recomputes the tables for `quality`; changes made while it runs are picked up by one more run after it. */
export async function recompute() {
    if (running) {
        again = true;
        return running;
    }
    running = (async () => {
        do {
            again = false;
            const { refraction, config } = structuredClone(quality);
            const base = MODELS[quality.model];
            const model = refraction ? base : { ...base, refractivity: 0 };
            const started = performance.now();
            const luts = await precomputeAtmosphere(gpuDevice(), { model, config });
            // Until the tables are computed, not just queued.
            await gpuDevice().queue.onSubmittedWorkDone();
            current = { luts, precomputeMs: performance.now() - started };
            events.dispatchEvent(new Event("tables"));
        } while (again);
    })();
    await running;
    running = null;
}

if (gpu.device) await recompute();
