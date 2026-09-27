import { DEFAULT_ATMOSPHERE_MODEL, DEFAULT_TEXTURE_CONFIG, precomputeAtmosphere } from "@himmelszelt/dunstkreis";

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

/** What the tables are computed with: refraction on or off, and their sizes and sample counts. */
export const quality = { refraction: true, config: structuredClone(DEFAULT_TEXTURE_CONFIG) };

const events = new EventTarget();
let current = null;
let running = null;
let again = false;

/** The tables computed last, with how long that took: `{ luts, precomputeMs }`. */
export const tables = () => current;

/** Calls `listener` whenever new tables are in. */
export const onTables = (listener) => events.addEventListener("tables", () => listener(current));

/** Calls `listener(pass)` whenever the sky pass may have rebuilt its sky-view table. */
export const onSkyView = (listener) => events.addEventListener("skyView", (event) => listener(event.detail));
export const skyViewChanged = (pass) => events.dispatchEvent(new CustomEvent("skyView", { detail: pass }));

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
