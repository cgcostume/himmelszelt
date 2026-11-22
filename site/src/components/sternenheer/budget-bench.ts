import { airTable, createAirTexture, DEFAULT_ATMOSPHERE_MODEL, seeingUniformData } from "@himmelszelt/dunstkreis";
import type { CatalogVariant, MilkyWay, StarsPass } from "@himmelszelt/sternenheer";
import {
    BRIGHT_STARS,
    CONSTELLATION_LINES,
    createStarsPass,
    HIPPARCOS,
    loadCatalog,
    loadConstellations,
    loadDeepStars,
    loadFaintStars,
    loadMilkyWay,
    MILKY_WAY_MAPS,
    TYCHO,
} from "@himmelszelt/sternenheer";
import { fromDate, julianEphemerisDay, stars } from "@himmelszelt/sternzeit";
import { cameraBasis } from "../dunstkreis/skycamera";
import type { BudgetMeasure, BudgetRow, FileName, RowMeasure } from "./budget-rows";
import { inverseViewProjection } from "./renderer";

// The benchmark behind the chapter's costs (bench.ts): every row's pass drawn into an offscreen target, timed pass by
// pass on the GPU's clock.

// The sky every row draws: the chapter's own experiment, a new moon in August over Berlin, the Milky Way from Cygnus
// overhead to Sagittarius on the horizon, through the view the chapter's sky opens with, at a moonless night's
// exposure, where every star of both catalogs passes the cut-off.
export const BENCH_SKY = {
    date: "2026-08-12T22:00:00Z",
    latitude: 52.52,
    longitude: 13.405,
    heightM: 1,
    yaw: 180,
    pitch: 35,
    fov: 120,
    ev100: -9,
} as const;
const DEG = Math.PI / 180;

export interface BenchOptions {
    /** How often every row is measured, the rows in turn, and how many frames each time, after `warmup` untimed. */
    rounds: number;
    frames: number;
    warmup: number;
    /** The milliseconds the measure may take: on a slow GPU, fewer rounds than `rounds`, three at least. */
    within?: number;
    /** Also the bytes every pass holds on the GPU, and the shipped files' sizes. */
    account?: boolean;
    progress?: (done: number) => void;
    signal?: AbortSignal;
}

// Timestamps a frame: its start, then a pair for each of up to seven passes.
const SLOTS = 8;
const TEXEL_BYTES: Record<string, number> = { rgba8unorm: 4, "rgba8unorm-srgb": 4, rgba16float: 8, rgba32float: 16 };

const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));
const median = (values: number[]) => quantile(values, 0.5);
const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);
function quantile(values: number[], q: number) {
    const sorted = [...values].sort((a, b) => a - b);
    const at = q * (sorted.length - 1);
    const low = Math.floor(at);
    return (sorted[low] ?? 0) + ((sorted[Math.min(low + 1, sorted.length - 1)] ?? 0) - (sorted[low] ?? 0)) * (at - low);
}

/** The bytes of a texture with all its levels. */
function textureBytes(width: number, height: number, format: string, levels: number) {
    let texels = 0;
    for (let mip = 0; mip < levels; mip++) texels += Math.max(1, width >> mip) * Math.max(1, height >> mip);
    return texels * (TEXEL_BYTES[format] ?? 4);
}

/** `device` as the pass sees it, every buffer and texture it creates counted into `memory` by its label: the pass keeps
 *  no account of its own. */
function counting(device: GPUDevice, memory: Record<string, number>): GPUDevice {
    const count = (label: string | undefined, bytes: number) => {
        const name = (label ?? "other").replace(/^sternenheer:/, "");
        memory[name] = (memory[name] ?? 0) + bytes;
    };
    return new Proxy(device, {
        get(target, property) {
            if (property === "createBuffer")
                return (descriptor: GPUBufferDescriptor) => {
                    count(descriptor.label, descriptor.size);
                    return target.createBuffer(descriptor);
                };
            if (property === "createTexture")
                return (descriptor: GPUTextureDescriptor) => {
                    const texture = target.createTexture(descriptor);
                    count(
                        descriptor.label,
                        textureBytes(texture.width, texture.height, texture.format, texture.mipLevelCount),
                    );
                    return texture;
                };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

/** `encoder` as the pass sees it, timestamps written around each compute pass it begins, into the frame's slots in the
 *  order they begin, their labels into `names`: the pass takes timestamps for its last pass only. */
function timing(encoder: GPUCommandEncoder, querySet: GPUQuerySet, frame: number, names: string[]): GPUCommandEncoder {
    let slot = 1;
    return new Proxy(encoder, {
        get(target, property) {
            if (property === "beginComputePass")
                return (descriptor: GPUComputePassDescriptor = {}) => {
                    if (slot >= SLOTS) return target.beginComputePass(descriptor);
                    names[slot] = (descriptor.label ?? "pass").replace(/^sternenheer:/, "");
                    const at = (frame * SLOTS + slot++) * 2;
                    const timestampWrites = { querySet, beginningOfPassWriteIndex: at, endOfPassWriteIndex: at + 1 };
                    return target.beginComputePass({ ...descriptor, timestampWrites });
                };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

/**
 * Measures `rows` on `device`: each row's pass made as a renderer would for it, drawn into an offscreen target of the
 * row's size over a black background, the rows in turn round after round, so what else loads the GPU meanwhile falls
 * on all of them alike. A frame's time is from its first pass' start to its last one's end, the clearing of the tile
 * lists and the halos' grid between them included. Per round the median over the frames, or their mean where the
 * browser rounds the timestamps, which the mean evens out; then the median over the rounds. Without the GPU's clock,
 * from submitting to done, a frame as a whole. Null when stopped by `signal`.
 */
export async function measureBudget(
    device: GPUDevice,
    rows: readonly BudgetRow[],
    gpu: string,
    { rounds, frames, warmup, within, account = false, progress, signal }: BenchOptions,
): Promise<BudgetMeasure | null> {
    const time = fromDate(new Date(BENCH_SKY.date));
    const model = DEFAULT_ATMOSPHERE_MODEL;
    const table = airTable(model, BENCH_SKY.heightM);
    const air = { texture: createAirTexture(device, table), horizon: table.horizon };
    const seeing = seeingUniformData();
    const maps = new Map<string, Promise<MilkyWay>>();
    const map = (size: "small" | "large") => {
        const loading = maps.get(size) ?? loadMilkyWay(device, MILKY_WAY_MAPS[size]);
        maps.set(size, loading);
        return loading;
    };
    const targets = new Map<string, { target: GPUTexture; background: GPUTexture }>();
    function targetsFor(width: number, height: number) {
        const made = targets.get(`${width} ${height}`) ?? {
            target: device.createTexture({
                label: "sternwarte:starsBudget",
                size: [width, height],
                format: "rgba8unorm",
                usage: GPUTextureUsage.STORAGE_BINDING,
            }),
            background: device.createTexture({
                label: "sternwarte:starsBudgetBackground",
                size: [width, height],
                format: "rgba16float",
                usage: GPUTextureUsage.TEXTURE_BINDING,
            }),
        };
        targets.set(`${width} ${height}`, made);
        return made;
    }
    type Setup = {
        row: BudgetRow;
        pass: StarsPass;
        memory: Record<string, number>;
        target: GPUTexture;
        background: GPUTexture;
    };
    const setups: Setup[] = [];
    const timestamps = device.features.has("timestamp-query");
    const pool = timestamps
        ? [0, 1].map(() => {
              const size = frames * SLOTS * 16;
              return {
                  querySet: device.createQuerySet({ type: "timestamp", count: frames * SLOTS * 2 }),
                  resolved: device.createBuffer({
                      size,
                      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
                  }),
                  read: device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
              };
          })
        : [];
    let pending: Promise<unknown> | null = null;
    // A pass that fails validation draws nothing, in no time: an error instead of a measure.
    device.pushErrorScope("validation");
    let failed: Promise<GPUError | null> | null = null;
    const validated = async () => {
        failed ??= device.popErrorScope();
        const error = await failed;
        if (error) throw new Error(error.message.split("\n")[0]);
    };
    try {
        // Each layout the rows ask for, the compact one by default, as the package loads it.
        const layouts = [...new Set(rows.map((row): CatalogVariant => (row.full ? "full" : "compact")))];
        const loaded = await Promise.all(
            layouts.map(async (variant) => {
                const [catalog, faintStars] = await Promise.all([
                    loadCatalog(variant),
                    loadFaintStars(variant).catch(() => null),
                ]);
                // The faint and the deep stars only where their files are there: the package ships neither of ESA's
                // catalogues.
                const deep = rows.some((row) => row.deepStars && (row.full ? "full" : "compact") === variant);
                return {
                    variant,
                    catalog,
                    faintStars,
                    deepStars: deep ? await loadDeepStars(variant).catch(() => null) : null,
                };
            }),
        );
        const catalogs = (row: BudgetRow) => loaded.find(({ variant }) => variant === (row.full ? "full" : "compact"));
        const constellations = await loadConstellations();
        const deepStars = loaded.find((layout) => layout.deepStars)?.deepStars ?? null;
        for (const row of rows) {
            const { catalog, faintStars, deepStars } = catalogs(row) ?? {};
            if (!catalog || (row.deepStars && !deepStars) || (row.faintStars && !faintStars)) continue;
            const memory: Record<string, number> = {};
            const milkyWay = row.milkyWay ? await map(row.milkyWay) : null;
            const texture = milkyWay?.texture;
            if (texture)
                memory.milkyway = textureBytes(texture.width, texture.height, texture.format, texture.mipLevelCount);
            const pass = await createStarsPass(counting(device, memory), {
                format: "rgba8unorm",
                catalog,
                faintStars: row.faintStars ? faintStars : null,
                deepStars: row.deepStars ? deepStars : null,
                constellations: row.constellations ? constellations : null,
                milkyWay,
                capacity: row.capacity,
            });
            const basis = cameraBasis(
                { yaw: BENCH_SKY.yaw * DEG, pitch: BENCH_SKY.pitch * DEG, fov: BENCH_SKY.fov * DEG },
                row.width / row.height,
            );
            pass.update({
                skyRotation: stars.horizontalMatrix(time, BENCH_SKY),
                years: (julianEphemerisDay(time) - 2451545) / 365.25,
                inverseViewProjection: inverseViewProjection(basis.f, basis.r, basis.u, basis.tx, basis.ty),
                projectionDistance: basis.d,
                ev100: BENCH_SKY.ev100,
                horizonZ: 0,
                air: row.air ? air : null,
                halo: row.halo ? 1 : 0,
                seeing: row.twinkle ? seeing : null,
                constellations: row.constellations ? null : [],
            });
            setups.push({ row, pass, memory, ...targetsFor(row.width, row.height) });
            if (signal?.aborted) return null;
        }

        // A frame, the twinkling a 60th of a second on; with `queries`, timed.
        let clock = 0;
        function draw(
            { pass, target, background }: Setup,
            queries?: { querySet: GPUQuerySet; frame: number; names: string[] },
        ) {
            pass.update({ time: clock++ / 60 });
            const encoder = device.createCommandEncoder({ label: "sternwarte:starsBudget" });
            if (queries) {
                const start = { querySet: queries.querySet, beginningOfPassWriteIndex: queries.frame * SLOTS * 2 };
                encoder.beginComputePass({ label: "sternwarte:starsBudgetStart", timestampWrites: start }).end();
                pass.encode(timing(encoder, queries.querySet, queries.frame, queries.names), target, { background });
            } else pass.encode(encoder, target, { background });
            device.queue.submit([encoder.finish()]);
        }

        // A round of a row on the GPU's clock: per pass and for the frame, the milliseconds of each of its frames.
        let quantum = 0;
        async function timed(setup: Setup, { querySet, resolved, read }: (typeof pool)[number]) {
            const names: string[] = [];
            for (let i = 0; i < warmup; i++) draw(setup);
            for (let frame = 0; frame < frames; frame++) draw(setup, { querySet, frame, names });
            const encoder = device.createCommandEncoder({ label: "sternwarte:starsBudgetResolve" });
            encoder.resolveQuerySet(querySet, 0, frames * SLOTS * 2, resolved, 0);
            encoder.copyBufferToBuffer(resolved, 0, read, 0, read.size);
            device.queue.submit([encoder.finish()]);
            await read.mapAsync(GPUMapMode.READ);
            const ns = new BigInt64Array(read.getMappedRange());
            const ms = (from: number, to: number) => Number((ns[to] ?? 0n) - (ns[from] ?? 0n)) / 1e6;
            const passes: Record<string, number[]> = {};
            const frame: number[] = [];
            for (let f = 0; f < frames; f++) {
                const base = f * SLOTS * 2;
                for (let slot = 1; slot < names.length; slot++) {
                    const name = names[slot] ?? "pass";
                    const times = passes[name] ?? new Array<number>(frames).fill(0);
                    passes[name] = times;
                    times[f] = (times[f] ?? 0) + ms(base + slot * 2, base + slot * 2 + 1);
                    quantum = gcd(quantum, Number((ns[base + slot * 2] ?? 0n) - (ns[0] ?? 0n)));
                }
                frame.push(ms(base, base + (names.length - 1) * 2 + 1));
            }
            read.unmap();
            return { passes, frame };
        }
        // Without the clock: the frames submitted and awaited as one, a frame its share.
        async function awaited(setup: Setup) {
            for (let i = 0; i < warmup; i++) draw(setup);
            await device.queue.onSubmittedWorkDone();
            const started = performance.now();
            for (let i = 0; i < frames; i++) draw(setup);
            await device.queue.onSubmittedWorkDone();
            return { passes: {}, frame: [(performance.now() - started) / frames] };
        }

        // Every pass' buffers allocated and the GPU's clocks up before anything is timed; and from how long that took,
        // as many rounds as fit into `within`, three at least.
        for (let i = 0; i < 2; i++) for (const setup of setups) draw(setup);
        await device.queue.onSubmittedWorkDone();
        const started = performance.now();
        for (let i = 0; i < 16; i++) for (const setup of setups) draw(setup);
        await device.queue.onSubmittedWorkDone();
        const roundMs = ((performance.now() - started) / 16) * (frames + warmup);
        if (within) rounds = Math.max(3, Math.min(rounds, Math.floor(within / roundMs)));

        type Round = Awaited<ReturnType<typeof timed>>;
        const measured = new Map<Setup, Round[]>(setups.map((setup) => [setup, []]));
        // Each round starts a row further on and runs the other way, so no row always follows the same one; and a
        // round's frames are queued behind the one awaited, so the GPU never idles in between.
        let job = 0;
        for (let round = 0; round < rounds; round++) {
            for (let k = 0; k < setups.length; k++) {
                if (signal?.aborted) return null;
                const at = (round + (round % 2 ? setups.length - 1 - k : k)) % setups.length;
                const setup = setups[at] as Setup;
                const resources = pool[job++ % 2];
                const done = (resources ? timed(setup, resources) : awaited(setup)).then((result) =>
                    measured.get(setup)?.push(result),
                );
                if (resources && pending) await pending;
                if (!resources) await done;
                pending = done;
                progress?.(job / (rounds * setups.length));
            }
        }
        await pending;
        await validated();

        // A clock in steps of a microsecond and more is a rounded one, Chromium's of 0.066 ms: most passes then take
        // none or one of its steps, and only their mean says how long.
        const quantized = quantum >= 1000;
        const over = timestamps && !quantized ? median : mean;
        const result: Record<string, RowMeasure> = {};
        for (const [setup, all] of measured) {
            const passes: Record<string, number> = {};
            for (const name of Object.keys(all[0]?.passes ?? {}))
                passes[name] = median(all.map((round) => over(round.passes[name] ?? [])));
            const frame = all.map((round) => over(round.frame));
            result[setup.row.id] = {
                passes,
                frame: median(frame),
                spread: { p10: quantile(frame, 0.1), p90: quantile(frame, 0.9) },
                ...(account ? { memory: setup.memory } : {}),
            };
        }
        const files: Partial<Record<FileName, number>> = {};
        if (account) {
            const urls: Partial<Record<FileName, string | URL>> = {
                catalog: BRIGHT_STARS.compact,
                faintStars: HIPPARCOS.compact,
                catalogFull: BRIGHT_STARS.full,
                faintStarsFull: HIPPARCOS.full,
                ...(deepStars ? { deepStars: TYCHO.compact, deepStarsFull: TYCHO.full } : {}),
                constellations: CONSTELLATION_LINES,
                small: MILKY_WAY_MAPS.small.url,
                large: MILKY_WAY_MAPS.large.url,
            };
            // As sent: a server may undo the catalogs' gzip on the way, by its content encoding, as Vite's does.
            for (const [name, url] of Object.entries(urls) as [FileName, string | URL][]) {
                const response = await fetch(url);
                const bytes = (await response.arrayBuffer()).byteLength;
                files[name] = Number(response.headers.get("content-length")) || bytes;
            }
        }
        return {
            gpu,
            timestamps,
            quantized: timestamps && quantized,
            ...(timestamps && quantized ? { quantum: quantum / 1e6 } : {}),
            rounds,
            frames,
            rows: result,
            ...(account ? { files } : {}),
        };
    } finally {
        await pending?.catch(() => {});
        await validated().catch(() => {});
        await device.queue.onSubmittedWorkDone();
        for (const { pass } of setups) pass.destroy();
        air.texture.destroy();
        for (const { target, background } of targets.values()) {
            target.destroy();
            background.destroy();
        }
        for (const loading of maps.values())
            loading.then(
                (loaded) => loaded.destroy(),
                () => {},
            );
        for (const { querySet, resolved, read } of pool) {
            querySet.destroy();
            resolved.destroy();
            read.destroy();
        }
    }
}
