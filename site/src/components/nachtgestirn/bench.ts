// The benchmark behind Figure 17 and the configurator, for `scripts/bench.mjs nachtgestirn`: every case's pass drawn
// offscreen and timed on the GPU's clock, the cases in turn round after round, and every set of maps decoded and
// uploaded, the sets in turn.
import { createMoonMaps, MOON_MAPS, MOON_MAPS_WHOLE, moonEV100 } from "@himmelszelt/nachtgestirn";
import { type BenchOptions, interleaved, type Spread } from "../bench";
import { gpu, gpuDevice, tables } from "../dunstkreis/atmosphere";
import { state } from "../sternzeit/state";
import {
    BENCH_VIEW,
    type BenchResult,
    BUDGET_ROWS,
    CONFIGS,
    type Config,
    frameKey,
    type Maps,
    type Variant,
} from "./budget-rows";
import { FINE_MAPS, moonAt, type ToneCurveName } from "./renderer";
import { createTiles, type TileFrame } from "./tiles";

/** A case: its key, the disc's size, the maps, the Moon's age in days, and the frame's options besides the defaults. */
export interface FrameCase {
    id: string;
    disc: number;
    maps: Maps;
    age?: number;
    feature?: Partial<TileFrame>;
}

const SIZES: readonly Maps[] = ["512", "1k", "2k", "4k", "8k"];

/** Figure 17's cases: each row with the defaults and with everything on. */
export const BUDGET_CASES: FrameCase[] = BUDGET_ROWS.flatMap((row) =>
    (Object.keys(CONFIGS) as Config[]).map((config, i) => ({
        id: frameKey(row.disc, config),
        disc: row.disc,
        maps: row.maps[i] ?? row.maps[0],
        feature: CONFIGS[config],
    })),
);

// The files of a set: the package's, the site's own whole 8K, and the seen 8K beside the package's maps, where made.
function filesOf(variant: Variant, size: Maps): [string, string] {
    if (size === "8k") {
        const whole = FINE_MAPS["8k"];
        if (variant === "whole") return [whole.color, whole.heights];
        const at = (kind: string) =>
            String(MOON_MAPS["4k"].color).replace("moon-color-seen-4k", `moon-${kind}-seen-8k`);
        return [at("color"), at("height")];
    }
    const files = variant === "whole" ? MOON_MAPS_WHOLE[size] : MOON_MAPS[size];
    return [String(files.color), String(files.heights)];
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function frameTimes(cases: readonly FrameCase[], options: BenchOptions) {
    for (let i = 0; i < 400 && !tables(); i++) await wait(100);
    const luts = tables()?.luts;
    if (!luts) throw new Error("bench: no atmosphere tables");
    // One renderer per set of maps, so going from case to case binds no maps and makes no pass anew.
    const renderers = new Map<Maps, NonNullable<ReturnType<typeof createTiles>>>();
    const rendererFor = (maps: Maps) => {
        let tiles = renderers.get(maps);
        if (!tiles) {
            tiles = createTiles(document.createElement("canvas"), () => {}) ?? undefined;
            if (!tiles) throw new Error("bench: no WebGPU");
            renderers.set(maps, tiles);
        }
        return tiles;
    };
    const { width, height, newMoon } = BENCH_VIEW;
    const measured = await interleaved(
        cases,
        options.rounds,
        async (c) => {
            const m = moonAt(newMoon + (c.age ?? BENCH_VIEW.age), { ...state, geocentric: true }, luts.model);
            const frame: TileFrame = {
                moon: m,
                luts: luts as never,
                toneMap: "neutral" as ToneCurveName,
                maps: c.maps,
                ev100: moonEV100(m.phaseAngle, m.lit),
                albedo: true,
                relief: true,
                shadows: true,
                roughness: false,
                earthshine: true,
                eclipse: false,
                law: "hapke2012",
                darkAdapted: false,
                ...c.feature,
            };
            const degrees = (m.geocentricDiameter * width) / c.disc;
            const r = await rendererFor(c.maps).measure(
                width,
                height,
                degrees,
                frame,
                undefined,
                options.warmup,
                options.frames,
            );
            if (r) options.progress?.(`${c.id} ${r.ms.toFixed(4)} ms`);
            return r ? { ms: r.ms } : null;
        },
        options.progress,
    );
    return Object.fromEntries(cases.map((c) => [c.id, measured.get(c) as { ms: Spread }]).filter(([, v]) => v));
}

async function loads(options: BenchOptions) {
    const device = gpuDevice();
    const blobs = new Map<string, Blob[]>();
    const sets: { variant: Variant; size: Maps }[] = [];
    for (const size of SIZES)
        for (const variant of ["seen", "whole"] as const) {
            const responses = await Promise.all(filesOf(variant, size).map((url) => fetch(url)));
            // A set not made on this machine is left out.
            if (responses.some((r) => !r.ok || r.headers.get("content-type")?.startsWith("text/html"))) {
                options.progress?.(`${variant} ${size} maps missing, left out`);
                continue;
            }
            blobs.set(`${variant} ${size}`, await Promise.all(responses.map((r) => r.blob())));
            sets.push({ variant, size });
        }
    const decoded = (blob: Blob) => createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const { meanReflectance, meanColor } = MOON_MAPS["4k"];
    const once = async ({ variant, size }: (typeof sets)[number]) => {
        const files = blobs.get(`${variant} ${size}`) ?? [];
        const started = performance.now();
        const [color, heights] = await Promise.all(files.map(decoded));
        const done = performance.now();
        if (!color || !heights) return null;
        const maps = createMoonMaps(device, { color, heights, meanReflectance, meanColor });
        await device.queue.onSubmittedWorkDone();
        const uploaded = performance.now();
        maps.destroy();
        color.close();
        heights.close();
        return { decode: done - started, upload: uploaded - done };
    };
    // The pipelines made and the decoder warm.
    for (const set of sets.slice(0, 2)) await once(set);
    const measured = await interleaved(sets, options.rounds, once, options.progress);
    const result: BenchResult["loads"] = { seen: {}, whole: {} };
    for (const set of sets) {
        const [color, heights] = blobs.get(`${set.variant} ${set.size}`) ?? [];
        const spread = measured.get(set);
        if (!color || !heights || !spread?.decode || !spread.upload) continue;
        result[set.variant][set.size] = {
            color: color.size,
            heights: heights.size,
            decode: spread.decode,
            upload: spread.upload,
        };
    }
    return result;
}

/** Runs the chapter's benchmark: the frame times of `options.cases` or Figure 17's, and, for Figure 17's, the loads. */
export async function bench(options: BenchOptions): Promise<Omit<BenchResult, "browser" | "date" | "machine">> {
    const own = options.cases as FrameCase[] | undefined;
    const frames = await frameTimes(own ?? BUDGET_CASES, options);
    return {
        gpu: gpu.adapterName ?? "unknown",
        rounds: options.rounds,
        frames: options.frames,
        warmup: options.warmup,
        frameTimes: frames,
        loads: own ? { seen: {}, whole: {} } : await loads({ ...options, rounds: Math.max(9, options.rounds) }),
    };
}
