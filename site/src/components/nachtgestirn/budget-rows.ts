// What Figure 17 measures, the same list for the figure, the configurator and `scripts/bench.mjs nachtgestirn`, which
// writes the measures into bench.json: a disc for each size of the maps, as large as it gets before they give less than
// a texel to a pixel at its middle, drawn with the pass' defaults and with everything on, the next finer maps.

export type Maps = "512" | "1k" | "2k" | "4k" | "8k";
export type Variant = "seen" | "whole";

export interface BudgetRow {
    /** Pixels across the disc, in a view 1920 by 1080 pixels. */
    disc: number;
    /** The maps the defaults draw it with, and everything on. */
    maps: readonly [Maps, Maps];
}

export const BUDGET_ROWS: readonly BudgetRow[] = [
    { disc: 162, maps: ["512", "1k"] },
    { disc: 325, maps: ["1k", "2k"] },
    { disc: 651, maps: ["2k", "4k"] },
    { disc: 1303, maps: ["4k", "8k"] },
    { disc: 2607, maps: ["4k", "8k"] },
];

/** The two configurations: the pass' defaults, and everything on, shadows and displacement at any size. */
export const CONFIGS = { defaults: {}, everything: { shadowsFrom: 0, displacementFrom: 0 } } as const;
export type Config = keyof typeof CONFIGS;

/** A row's key in bench.json's `frames`. */
export const frameKey = (disc: number, config: Config) => `${disc} ${config}`;

/** The view: a full HD screen, and the Moon waxing gibbous, ten days after the new moon of 2026-11-09, JD 2461353.79,
 *  seen from Earth's center. */
export const BENCH_VIEW = { width: 1920, height: 1080, newMoon: 2461353.79, age: 10 } as const;

/** What bench.json holds, as `scripts/bench.mjs` writes it. */
export interface BenchResult {
    gpu: string;
    browser: string;
    date: string;
    rounds: number;
    frames: number;
    warmup: number;
    /** The GPU's load before the run, in percent, and other Chromium GPU processes then: what might have shared it. */
    machine?: { busyBefore: number[]; otherBrowsers: number; desktop?: number };
    /** Per case, the ms a frame on the GPU: the mean of the middle 80 percent of a round's frames, over the rounds. */
    frameTimes: Record<string, { ms: Spread }>;
    /** Per set and size: the files' bytes, and the ms to decode both and to upload them, over the rounds. */
    loads: Record<Variant, Partial<Record<Maps, { color: number; heights: number; decode: Spread; upload: Spread }>>>;
}

interface Spread {
    median: number;
    p10: number;
    p90: number;
    rounds: number;
}
