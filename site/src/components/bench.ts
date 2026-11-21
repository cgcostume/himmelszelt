// What every chapter's benchmark shares, for `scripts/bench.mjs`: its options, the rounds that take the cases in turn,
// and the summary of each case's rounds. A chapter's own `bench.ts` exports `bench(options)` and returns plain JSON.

/** How often every case is measured, the cases in turn, how many frames each time after `warmup` untimed, and the cases
 *  of a run of one's own in place of the chapter's, as the runner's `--cases` reads them. */
export interface BenchOptions {
    rounds: number;
    frames: number;
    warmup: number;
    cases?: unknown[];
    progress?: (message: string) => void;
}

/** A case's rounds: their median, the 10th and 90th percentiles, and how many. */
export interface Spread {
    median: number;
    p10: number;
    p90: number;
    rounds: number;
}

export function quantile(values: number[], q: number) {
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const at = q * (sorted.length - 1);
    const below = Math.floor(at);
    return (sorted[below] ?? 0) + ((sorted[Math.ceil(at)] ?? 0) - (sorted[below] ?? 0)) * (at - below);
}

/** Four digits after the point: a tenth of a microsecond in ms, more than the GPU's clock gives. */
export const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

export const spreadOf = (values: number[]): Spread => ({
    median: round4(quantile(values, 0.5)),
    p10: round4(quantile(values, 0.1)),
    p90: round4(quantile(values, 0.9)),
    rounds: values.length,
});

/**
 * Measures every case `rounds` times, the cases in turn and every other round backwards, so what else loads the GPU
 * meanwhile, and its clocks, fall on all cases alike: an A/B within one page. Each measure returns named values; each
 * case gets each value's spread over the rounds.
 */
export async function interleaved<Case>(
    cases: readonly Case[],
    rounds: number,
    measure: (c: Case, round: number) => Promise<Record<string, number> | null>,
    progress?: (message: string) => void,
): Promise<Map<Case, Record<string, Spread>>> {
    const values = new Map<Case, Record<string, number[]>>();
    for (let r = 0; r < rounds; r++) {
        const order = r % 2 ? [...cases].reverse() : cases;
        for (const c of order) {
            const got = await measure(c, r);
            if (!got) continue;
            const kept = values.get(c) ?? {};
            for (const [name, v] of Object.entries(got)) {
                kept[name] = [...(kept[name] ?? []), v];
            }
            values.set(c, kept);
        }
        progress?.(`round ${r + 1} of ${rounds}`);
    }
    return new Map(
        [...values].map(([c, named]) => [
            c,
            Object.fromEntries(Object.entries(named).map(([name, v]) => [name, spreadOf(v)])),
        ]),
    );
}

/** A chapter's cost in one row of its "What it costs" figure: the GPU's time, the bytes it holds there, and what it
 *  downloads, each where measured. */
export interface CostRow {
    ms?: Spread;
    memory?: number;
    download?: number;
}

/** What a chapter's bench.json holds besides what `scripts/bench.mjs` adds, its rows by key. */
export interface CostsResult {
    gpu: string;
    rounds: number;
    frames: number;
    warmup: number;
    rows: Record<string, CostRow>;
    browser?: string;
    date?: string;
    machine?: { busyBefore: number[]; otherBrowsers: number; desktop?: number };
}

/** The bytes a texel takes in the formats the packages use. */
const TEXEL_BYTES: Record<string, number> = {
    r8unorm: 1,
    r16float: 2,
    rg8unorm: 2,
    r32float: 4,
    r32uint: 4,
    rg16float: 4,
    rgba8unorm: 4,
    "rgba8unorm-srgb": 4,
    bgra8unorm: 4,
    rg32float: 8,
    rgba16float: 8,
    rgba32float: 16,
    depth32float: 4,
    "bc1-rgba-unorm": 0.5,
    "bc1-rgba-unorm-srgb": 0.5,
};

/** The bytes of a texture with all its levels, a 3D one's levels shrinking in depth too. */
export function textureBytes(t: GPUTexture) {
    let texels = 0;
    const volume = t.dimension === "3d";
    for (let mip = 0; mip < t.mipLevelCount; mip++)
        texels +=
            Math.max(1, t.width >> mip) *
            Math.max(1, t.height >> mip) *
            (volume ? Math.max(1, t.depthOrArrayLayers >> mip) : t.depthOrArrayLayers);
    return texels * (TEXEL_BYTES[t.format] ?? 4);
}

/** `device` as a pass sees it, every buffer and texture it creates counted into `memory` by its label: no pass keeps an
 *  account of its own. Staging buffers, which map, are left out. */
export function counting(device: GPUDevice, memory: Record<string, number> = {}) {
    const count = (label: string | undefined, bytes: number) => {
        const name = label || "other";
        memory[name] = (memory[name] ?? 0) + bytes;
    };
    const counted = new Proxy(device, {
        get(target, property) {
            if (property === "createBuffer")
                return (descriptor: GPUBufferDescriptor) => {
                    const mapped = descriptor.usage & (GPUBufferUsage.MAP_READ | GPUBufferUsage.MAP_WRITE);
                    if (!mapped) count(descriptor.label, descriptor.size);
                    return target.createBuffer(descriptor);
                };
            if (property === "createTexture")
                return (descriptor: GPUTextureDescriptor) => {
                    const texture = target.createTexture(descriptor);
                    count(descriptor.label, textureBytes(texture));
                    return texture;
                };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    return { device: counted, memory, total: () => Object.values(memory).reduce((sum, b) => sum + b, 0) };
}

const QUERIES = 4096;

/**
 * Times `frame` on the GPU's clock: `warmup` frames untimed to bring its clocks up, then `frames` timed, a timestamp
 * written around every compute and render pass any encoder begins meanwhile, the library's own included. A frame's
 * time runs from its first pass' start to its last one's end, or, with `sum`, adds its passes' times, for work with
 * the CPU between its passes. The mean of the middle 80 percent of the frames; null without timestamps or passes.
 */
export async function timeFrames(
    device: GPUDevice,
    frame: (i: number) => void | Promise<void>,
    { warmup, frames, sum = false }: { warmup: number; frames: number; sum?: boolean },
): Promise<number | null> {
    if (!device.features.has("timestamp-query")) return null;
    // Batches of 50 submitted ahead of the one awaited, so the GPU never idles between them.
    let pending: Promise<undefined> | null = null;
    const paced = async (i: number) => {
        if (i % 50 !== 49) return;
        const done = device.queue.onSubmittedWorkDone();
        if (pending) await pending;
        pending = done;
    };
    for (let i = 0; i < warmup; i++) {
        await frame(i);
        await paced(i);
    }
    await device.queue.onSubmittedWorkDone();
    pending = null;
    const querySet = device.createQuerySet({ type: "timestamp", count: QUERIES });
    const resolved = device.createBuffer({
        size: QUERIES * 8,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    const read = device.createBuffer({ size: QUERIES * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const proto = GPUCommandEncoder.prototype;
    const { beginComputePass, beginRenderPass } = proto;
    let next = 0;
    const spans: [number, number][] = [];
    const times: number[] = [];
    function inject<D extends GPUComputePassDescriptor | GPURenderPassDescriptor>(descriptor: D | undefined) {
        if (descriptor?.timestampWrites || next + 2 > QUERIES) return descriptor;
        const at = next;
        next += 2;
        return {
            ...descriptor,
            timestampWrites: { querySet, beginningOfPassWriteIndex: at, endOfPassWriteIndex: at + 1 },
        };
    }
    proto.beginComputePass = function (this: GPUCommandEncoder, descriptor?: GPUComputePassDescriptor) {
        return beginComputePass.call(this, inject(descriptor));
    };
    proto.beginRenderPass = function (this: GPUCommandEncoder, descriptor: GPURenderPassDescriptor) {
        return beginRenderPass.call(this, inject(descriptor) as GPURenderPassDescriptor);
    };
    const flush = async () => {
        if (next === 0) return;
        const used = next;
        next = QUERIES;
        const encoder = device.createCommandEncoder();
        encoder.resolveQuerySet(querySet, 0, used, resolved, 0);
        encoder.copyBufferToBuffer(resolved, 0, read, 0, used * 8);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ, 0, used * 8);
        const ns = new BigInt64Array(read.getMappedRange(0, used * 8).slice(0));
        read.unmap();
        for (const [from, to] of spans) {
            if (to <= from) continue;
            let [first, last, total] = [ns[from] ?? 0n, ns[from + 1] ?? 0n, 0n];
            for (let q = from; q < to; q += 2) {
                const [begin, end] = [ns[q] ?? 0n, ns[q + 1] ?? 0n];
                if (begin < first) first = begin;
                if (end > last) last = end;
                total += end - begin;
            }
            times.push(Number(sum ? total : last - first) / 1e6);
        }
        spans.length = 0;
        next = 0;
    };
    try {
        let most = 0;
        for (let i = 0; i < frames; i++) {
            if (next + Math.max(most, 2) > QUERIES) await flush();
            const from = next;
            await frame(warmup + i);
            spans.push([from, next]);
            most = Math.max(most, next - from);
            await paced(i);
        }
        await flush();
    } finally {
        proto.beginComputePass = beginComputePass;
        proto.beginRenderPass = beginRenderPass;
        await device.queue.onSubmittedWorkDone();
        querySet.destroy();
        resolved.destroy();
        read.destroy();
    }
    if (times.length === 0) return null;
    times.sort((a, b) => a - b);
    const middle = times.slice(Math.floor(0.1 * times.length), Math.ceil(0.9 * times.length));
    return middle.reduce((total, t) => total + t, 0) / middle.length;
}

/** The bytes of `url` as the server sends them, compressed where it compresses; or as gzip compresses them, `gzip`. */
export async function downloadBytes(url: string, gzip = false) {
    const response = await fetch(url);
    if (!response.ok) return 0;
    const blob = await response.blob();
    if (!gzip) return Number(response.headers.get("content-length")) || blob.size;
    const compressed = blob.stream().pipeThrough(new CompressionStream("gzip"));
    return (await new Response(compressed).arrayBuffer()).byteLength;
}

/** The bytes of a package's code, gzipped, from its bundles as `import.meta.glob` loads them raw: all but a second entry,
 *  `wgsl.js` or `approx.js`, which the first already holds. */
export async function codeBytes(code: Record<string, () => Promise<unknown>>) {
    let bytes = 0;
    for (const [path, load] of Object.entries(code)) {
        if (/\/(wgsl|approx)\.js$/.test(path)) continue;
        const text = String(await load());
        const compressed = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
        bytes += (await new Response(compressed).arrayBuffer()).byteLength;
    }
    return bytes;
}
