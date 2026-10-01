import {
    createIrradiancePass,
    DEFAULT_ATMOSPHERE_MODEL,
    DEFAULT_TEXTURE_CONFIG,
    precomputeAtmosphere,
} from "@himmelszelt/dunstkreis";

/**
 * The GPU and the tables the whole page shares: the sky renders with them, the tables figure configures and shows
 * them. Whoever swaps its pass to new tables destroys the old ones.
 */

async function acquire() {
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
    const device = await adapter.requestDevice();
    // Which GPU, for the timings: a fallback adapter renders on the CPU, a hundred times slower.
    const { vendor, architecture, description } = adapter.info ?? {};
    const name = description || [vendor, architecture].filter(Boolean).join(" ") || "unknown GPU";
    return { device, adapterName: adapter.isFallbackAdapter ? `${name}, a CPU fallback` : name };
}

export const gpu = await acquire();

/**
 * What the tables are computed with: refraction on or off, sizes and sample counts, and the samples of the sky that
 * light the ground in the sky-view table, 0, 8 or 64.
 */
export const quality = { refraction: true, config: structuredClone(DEFAULT_TEXTURE_CONFIG), groundSamples: 64 };

const events = new EventTarget();
let current = null;
let running = null;
let again = false;

/** The tables computed last, with how long that took: `{ luts, precomputeMs }`. */
export const tables = () => current;

/** Calls `listener` whenever new tables are in, or the sky passes built on them have to be made anew. */
export const onTables = (listener) => events.addEventListener("tables", () => listener(current));

/**
 * A refraction button, one of several over the page: every table and cube map is traced through the bent air, so
 * pressing any one recomputes them all, and every button follows.
 */
export function bindRefractionToggle(button) {
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
export const onSkyView = (listener) => events.addEventListener("skyView", (event) => listener(event.detail));
export function skyViewChanged(sky) {
    events.dispatchEvent(new CustomEvent("skyView", { detail: sky }));
    lastSky = sky;
    pendingSky = sky;
    buildEnvironment();
}

/**
 * The sky as an environment to light a scene with, rebuilt along with the sky view: its cube map, without the sun
 * disc, the irradiance pass holding its nine coefficients and irradiance cube map, the coefficients read back, the
 * sunlight at the observer in lux, the metered EV100, and the sky it was built from.
 */
export const environment = {
    size: 128,
    irradianceSize: 32,
    cubify: false,
    cube: null,
    ibl: null,
    sh: null,
    sun: [0, 0, 0],
    ev100: 14,
    sky: null,
};
export const onEnvironment = (listener) => events.addEventListener("environment", () => listener(environment));

let lastSky = null;
let pendingSky = null;
let building = false;
let retired = null;
let retiredIbl = null;

const cubifyToggles = new Set();

/** Rebuilds the environment with its cube map cubified or not: texels spread evenly over the sphere, see cube.wgsl. */
export function setEnvironmentCubify(cubify) {
    environment.cubify = cubify;
    for (const button of cubifyToggles) button.setAttribute("aria-pressed", String(cubify));
    pendingSky = lastSky;
    buildEnvironment();
}

/** A cubified button, one of several: the sky cube is built cubified, and whoever samples it follows. */
export function bindCubifyToggle(button) {
    cubifyToggles.add(button);
    button.setAttribute("aria-pressed", String(environment.cubify));
    button.addEventListener("click", () => setEnvironmentCubify(!environment.cubify));
}

/** Rebuilds the environment with an irradiance cube map of faces of `size` texels. */
export function setIrradianceSize(size) {
    environment.irradianceSize = size;
    pendingSky = lastSky;
    buildEnvironment();
}

/** Rebuilds the environment with cube map faces of `size` texels. */
export function setEnvironmentSize(size) {
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
    const { device } = gpu;
    let { cube } = environment;
    if (cube?.width !== environment.size) {
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
    let { ibl } = environment;
    if (ibl?.irradiance.width !== environment.irradianceSize) {
        // Like the cube, the old one is kept one build longer.
        retiredIbl?.destroy();
        retiredIbl = ibl;
        ibl = createIrradiancePass(device, { size: environment.irradianceSize });
    }
    const encoder = device.createCommandEncoder({ label: "sternwarte:environment" });
    const { cubify } = environment;
    sky.pass.encodeCube(encoder, cube, { samples: 8, cubify });
    ibl.encode(encoder, cube, { cubified: cubify });
    device.queue.submit([encoder.finish()]);
    const [sh, sun, ev100] = await Promise.all([ibl.readSH(), sky.pass.sunIlluminance(), sky.pass.meteredEV100()]);
    Object.assign(environment, {
        cube,
        cubified: cubify,
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
            const model = refraction ? DEFAULT_ATMOSPHERE_MODEL : { ...DEFAULT_ATMOSPHERE_MODEL, refractivity: 0 };
            const started = performance.now();
            const luts = await precomputeAtmosphere(gpu.device, { model, config });
            current = { luts, precomputeMs: performance.now() - started };
            events.dispatchEvent(new Event("tables"));
        } while (again);
    })();
    await running;
    running = null;
}

if (gpu.device) await recompute();
