import {
    adaptEV100,
    type BloomPass,
    createBloomPass,
    createMeterPass,
    ev100FromLuminance,
    type MeterAdaptation,
    type MeterAverage,
    type MeterFocus,
    type MeterHistogram,
    meteredLuminance,
    type ToneCurve,
    wgsl,
} from "@himmelszelt/helldunkel";
import { decodeRgbe, wgsl as rundbild } from "@himmelszelt/rundbild";
import { configureCanvas, displayOutput, gpu, gpuDevice, onDisplay, SDR } from "../dunstkreis/atmosphere";

/**
 * The HDRI this chapter's figures share: one panorama, its exposure, and how to draw it. The list comes from Poly Haven's
 * API, and the site hosts no file of them: what was fetched stays in the browser's private
 * file system, where it has one.
 */
const API = "https://api.polyhaven.com";
const CDN = "https://cdn.polyhaven.com/asset_img/primary";

export type Entry = {
    id: string;
    name: string;
    thumbnail: string;
    downloads: number;
    categories: string[];
    tags: string[];
    authors: string[];
};

const cacheDirectory = async () =>
    (await navigator.storage.getDirectory()).getDirectoryHandle("himmelszelt-hdri", { create: true });
/** How much the files may take: past it, those used longest ago go. */
const CACHE_BYTES = 1024 ** 3;
const USED_KEY = "himmelszelt-hdri-used";
function usedAt(): Record<string, number> {
    try {
        return JSON.parse(localStorage.getItem(USED_KEY) ?? "{}");
    } catch {
        return {};
    }
}
function setUsed(used: Record<string, number>) {
    try {
        localStorage.setItem(USED_KEY, JSON.stringify(used));
    } catch {}
}
const touch = (name: string) => setUsed({ ...usedAt(), [name]: Date.now() });

async function evict(keeping: string) {
    const directory = await cacheDirectory();
    const handles = directory as unknown as { values(): AsyncIterable<FileSystemHandle> };
    const used = usedAt();
    const files: { name: string; size: number; at: number }[] = [];
    for await (const { name } of handles.values()) {
        if (!name.endsWith(".hdr")) continue;
        const file = await (await directory.getFileHandle(name)).getFile();
        files.push({ name, size: file.size, at: used[name] ?? file.lastModified });
    }
    let total = files.reduce((sum, { size }) => sum + size, 0);
    for (const { name, size } of files.sort((a, b) => a.at - b.at)) {
        if (total <= CACHE_BYTES) break;
        if (name === keeping) continue;
        await directory.removeEntry(name);
        delete used[name];
        total -= size;
    }
    setUsed(used);
}

async function cached(name: string) {
    try {
        const bytes = await (await (await (await cacheDirectory()).getFileHandle(name)).getFile()).arrayBuffer();
        touch(name);
        return bytes;
    } catch {
        return null;
    }
}
function keep(name: string, bytes: ArrayBuffer) {
    // Where a browser has no such file system, or no room, it is fetched again next time.
    cacheDirectory()
        .then((directory) => directory.getFileHandle(name, { create: true }))
        .then((handle) => handle.createWritable())
        .then(async (writable) => {
            await writable.write(bytes);
            await writable.close();
            touch(name);
            await evict(name);
        })
        .catch(() => {});
}

/** Every HDRI there is, downloaded most first: the latest list if there is a connection, the one kept if not. */
export async function catalog(): Promise<Entry[]> {
    let bytes: ArrayBuffer;
    try {
        bytes = await (await fetch(`${API}/assets?t=hdris`)).arrayBuffer();
        keep("assets.json", bytes);
    } catch (error) {
        const kept = await cached("assets.json");
        if (!kept) throw error;
        bytes = kept;
    }
    const assets: Record<
        string,
        {
            name: string;
            download_count: number;
            categories?: string[];
            tags?: string[];
            authors?: Record<string, string>;
        }
    > = JSON.parse(new TextDecoder().decode(bytes));
    return (
        Object.entries(assets)
            .sort(([, a], [, b]) => b.download_count - a.download_count)
            // The panorama alone, without the spheres of its `thumbnail_url`, which a square crops out of.
            .map(([id, asset]) => ({
                id,
                name: asset.name,
                thumbnail: `${CDN}/${id}.png?height=128`,
                downloads: asset.download_count,
                categories: asset.categories ?? [],
                tags: asset.tags ?? [],
                authors: Object.keys(asset.authors ?? {}),
            }))
    );
}

/** The first `count` of those in a category and matching every word of a search, by name, category or tag. */
export function filtered(entries: Entry[], category: string, search: string, count = 8) {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    return entries
        .filter((entry) => category === "all" || entry.categories.includes(category))
        .filter((entry) => {
            const text = [entry.name, ...entry.categories, ...entry.tags].join(" ").toLowerCase();
            return words.every((word) => text.includes(word));
        })
        .slice(0, count);
}

/** A file of the list at a resolution, from the cache if it is there. */
async function fileOf(id: string, resolution: Resolution, progress: (loaded: number, total: number) => void) {
    const name = `${id}_${resolution}.hdr`;
    const kept = await cached(name);
    if (kept) return kept;
    const files = await (await fetch(`${API}/files/${id}`)).json();
    const { url, size } = files.hdri[resolution].hdr as { url: string; size: number };
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`rundbild: ${url} gave ${response.status}`);
    // Read piece by piece, for how far it has come: the API says how large the file is.
    const bytes = new Uint8Array(size);
    let loaded = 0;
    const reader = response.body.getReader();
    for (let piece = await reader.read(); !piece.done; piece = await reader.read()) {
        bytes.set(piece.value, loaded);
        loaded += piece.value.length;
        progress(loaded, size);
    }
    return keepAndReturn(name, bytes.buffer);
}

function keepAndReturn(name: string, bytes: ArrayBuffer) {
    keep(name, bytes);
    return bytes;
}

/** What a first visit starts with. */
export const DEFAULT_HDRI = "golden_gate_hills";

export type Resolution = "1k" | "2k" | "4k" | "8k";

export const hdri = {
    // Sharp through a full screen's view, some 20 MB once; less where that is too much to ask.
    resolution: (innerWidth < 800 ||
    (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData
        ? "1k"
        : "4k") as Resolution,
    id: "",
    name: "",
    /** Who made it, for its credit; empty for a file of the reader's own. */
    authors: [] as string[],
    width: 0,
    height: 0,
    /** What the meter counted, every texel, by how much it weighs in the metering chosen. */
    histogram: null as MeterHistogram | null,
    /** The same of the whole image, whatever the meter weighs, for reference. */
    whole: null as MeterHistogram | null,
    wholeCounts: null as GPUBuffer | null,
    texture: null as GPUTexture | null,
    /** The exposure chosen, and what the meter read. The file's values are relative, so both are too. */
    ev100: 0,
    metered: 0,
    /** Whether the exposure stands on the reading and follows it, until the reader sets one by hand. */
    following: true,
};
export type Metering = "average" | "center" | "spot" | "sky" | "ground";
const DEG = Math.PI / 180;
const [YAW_DEG, PITCH_DEG, FOV_DEG] = [279, 31, 97];
/** How every figure shows it, one choice for the page: as stored or from inside, and where that view looks. */
export const view = {
    projected: true,
    clipped: false,
    /** How the meter weighs the sphere: all of it evenly, the middle of the view, a spot at its center, or a mask. */
    metering: "average" as Metering,
    /** How it averages what it weighs. */
    average: {} as MeterAverage,
    /** How many texels across it counts while it follows the view; the whole image's reference counts them all. */
    meterSize: 2048 as number | undefined,
    /** How fast the exposure follows the reading, or at once. */
    adaptation: null as MeterAdaptation | null,
    /** What exposed light the output still tells apart: above `white` it clips to white, below `black` to black. */
    white: 1,
    black: 1 / 255 / 12.92,
    yaw: YAW_DEG * DEG,
    pitch: PITCH_DEG * DEG,
    fov: FOV_DEG * DEG,
};
const events = new EventTarget();
export const onHdri = (listener: () => void) => events.addEventListener("change", listener);
export const changed = () => events.dispatchEvent(new Event("change"));

const buffer = new ArrayBuffer(4);
const asFloat = new Float32Array(buffer);
const asBits = new Uint32Array(buffer);
/** A float as half float bits, what lies above their range at their largest: filterable on any device, unlike floats. */
function half(value: number) {
    asFloat[0] = Math.min(Math.max(value, 0), 65504);
    const bits = asBits[0] as number;
    const exponent = ((bits >> 23) & 255) - 112;
    if (exponent <= 0) return 0;
    return (exponent << 10) | ((bits >> 13) & 1023);
}

/** A camera's circles, as a share of half the frame's height: a center-weighted meter's, fading out by the frame's corner, and a spot's. */
export const METERING_RADIUS = { center: 0.5, spot: 0.26 };
const FRAME_CORNER = 2;

export function meterFocus(): MeterFocus | undefined {
    if (view.metering !== "center" && view.metering !== "spot") return undefined;
    const { yaw, pitch, fov } = view;
    const reach = (share: number) => Math.atan(share * Math.tan(fov / 2));
    const inner = reach(METERING_RADIUS[view.metering]);
    return {
        direction: [Math.cos(pitch) * Math.sin(yaw), Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch)],
        innerAngle: inner,
        outerAngle: view.metering === "center" ? reach(FRAME_CORNER) : inner * 1.1,
    };
}

let meter: ReturnType<typeof createMeterPass> | null = null;
let loading = 0;
let readings: Promise<unknown> = Promise.resolve();

/** Counts a texture as the metering says, one reading after the other: a buffer maps for one at a time. */
const masks = new Map<Metering, GPUTexture>();
/** A mask of the upper or the lower half of a panorama: the horizon lies across its middle. */
function meterMask(device: GPUDevice) {
    if (view.metering !== "sky" && view.metering !== "ground") return undefined;
    let mask = masks.get(view.metering);
    if (!mask) {
        mask = device.createTexture({
            size: [1, 2],
            format: "r8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        const half = new Uint8Array(view.metering === "sky" ? [255, 0] : [0, 255]);
        device.queue.writeTexture({ texture: mask }, half, { bytesPerRow: 1 }, [1, 2]);
        masks.set(view.metering, mask);
    }
    return mask;
}

function measure(texture: GPUTexture) {
    const device = gpuDevice();
    meter ??= createMeterPass(device, { source: "equirectangular" });
    const reading = readings.then(async () => {
        const pass = await (meter as NonNullable<typeof meter>);
        const encoder = device.createCommandEncoder({ label: "sternwarte:hdriMeter" });
        const [focus, mask] = [meterFocus(), meterMask(device)];
        pass.encode(encoder, texture, {
            ...(focus && { focus }),
            ...(mask && { mask }),
            ...(view.meterSize && { maxSize: view.meterSize }),
            ...view.average,
        });
        device.queue.submit([encoder.finish()]);
        const histogram = await pass.readHistogram();
        const luminance = meteredLuminance(histogram, view.average);
        return { histogram, metered: luminance > 0 ? ev100FromLuminance(luminance) : 0 };
    });
    readings = reading.catch(() => {});
    return reading;
}

/** Counts all of a texture evenly into a buffer of its own, which later readings leave alone. */
function measureWhole(texture: GPUTexture) {
    const device = gpuDevice();
    meter ??= createMeterPass(device, { source: "equirectangular" });
    const reading = readings.then(async () => {
        const pass = await (meter as NonNullable<typeof meter>);
        hdri.wholeCounts ??= device.createBuffer({
            label: "sternwarte:hdriWhole",
            size: pass.counts.size,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        const encoder = device.createCommandEncoder({ label: "sternwarte:hdriMeterWhole" });
        pass.encode(encoder, texture);
        encoder.copyBufferToBuffer(pass.counts, 0, hdri.wholeCounts, 0, pass.counts.size);
        device.queue.submit([encoder.finish()]);
        return pass.readHistogram();
    });
    readings = reading.catch(() => {});
    return reading;
}

/** The meter's buffer, for a figure to draw from. */
export const meterCounts = async () => (await meter)?.counts ?? null;

/** Takes a file's bytes over as the shared HDRI, and meters it. */
export async function show(id: string, name: string, file: ArrayBuffer, authors: string[] = []) {
    const { width, height, pixels } = decodeRgbe(file);
    const device = gpuDevice();
    const halves = new Uint16Array(pixels.length);
    for (let i = 0; i < pixels.length; ++i) halves[i] = half(pixels[i] as number);
    const texture = device.createTexture({
        label: "sternwarte:hdri",
        size: [width, height],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, halves, { bytesPerRow: width * 8 }, [width, height]);
    const whole = await measureWhole(texture);
    const { histogram, metered } = await measure(texture);
    hdri.whole = whole;
    hdri.texture?.destroy();
    Object.assign(hdri, {
        id,
        name,
        authors,
        width,
        height,
        histogram,
        texture,
        metered,
        ev100: metered,
        following: true,
    });
    changed();
}

let adapting: number | null = null;
let adaptedAt = 0;
/** Moves the exposure towards the reading, frame by frame while there is a way to go, and then rests. */
function adapt(now: number) {
    adapting = null;
    if (!hdri.following) return;
    const seconds = Math.min((now - adaptedAt) / 1000, 0.1);
    adaptedAt = now;
    const { adaptation } = view;
    const next = adaptation ? adaptEV100(hdri.ev100, hdri.metered, seconds, adaptation) : hdri.metered;
    hdri.ev100 = Math.abs(next - hdri.metered) < 0.01 ? hdri.metered : next;
    changed();
    if (hdri.ev100 !== hdri.metered) adapting = requestAnimationFrame(adapt);
}
function followReading() {
    if (adapting !== null || !hdri.following) return;
    adaptedAt = performance.now();
    adapting = requestAnimationFrame(adapt);
}

let reading = false;
let again = false;
/** The metering or where it looks has changed: reads again, the newest asked for, as fast as the readings come. */
export async function remeter() {
    const { texture } = hdri;
    if (!texture) return;
    if (reading) {
        again = true;
        return;
    }
    reading = true;
    const { histogram, metered } = await measure(texture);
    reading = false;
    if (texture === hdri.texture) {
        Object.assign(hdri, { histogram, metered });
        changed();
        followReading();
    }
    if (again) {
        again = false;
        remeter();
    }
}

/**
 * What is on its way, an entry's id or "file", or the first list and HDRI until they come. Every figure showing the HDRI
 * says so, by `data-needs-hdri`, as does the box's thumbnail, with the same small bar.
 */
export const pending = { id: "first" as string | null, loaded: 0, total: 0 };
const loadingEvents = new EventTarget();
export const onLoading = (listener: () => void) => loadingEvents.addEventListener("change", listener);
/** Every figure's bar, and whatever else reads `--progress`, from 0 to 1. Unknown yet, there is no bar at all. */
function showProgress() {
    const share = pending.total > 0 ? String(Math.min(pending.loaded / pending.total, 1)) : "";
    for (const figure of document.querySelectorAll<HTMLElement>("[data-needs-hdri]")) {
        figure.style.setProperty("--progress", share || "0");
        figure.toggleAttribute("data-progress", share !== "");
    }
}
export function setPending(id: string | null) {
    Object.assign(pending, { id, loaded: 0, total: 0 });
    showProgress();
    for (const figure of document.querySelectorAll("[data-needs-hdri]")) {
        figure.toggleAttribute("data-loading", id !== null);
        figure.setAttribute("aria-busy", String(id !== null));
    }
    loadingEvents.dispatchEvent(new Event("change"));
}

let current: Pick<Entry, "id" | "name" | "authors"> | null = null;

/** Takes the current entry at another resolution; a file of the reader's own has only its one. */
export function setResolution(resolution: Resolution) {
    hdri.resolution = resolution;
    changed();
    if (current) load(current);
}

/** Loads an entry of the list; the latest asked for wins. */
export async function load(entry: Pick<Entry, "id" | "name" | "authors">) {
    current = entry;
    const ticket = ++loading;
    setPending(entry.id);
    try {
        const file = await fileOf(entry.id, hdri.resolution, (loaded, total) => {
            if (ticket !== loading) return;
            Object.assign(pending, { loaded, total });
            showProgress();
            loadingEvents.dispatchEvent(new Event("change"));
        });
        if (ticket === loading) await show(entry.id, entry.name, file, entry.authors);
    } finally {
        if (ticket === loading) setPending(null);
    }
}

// The panorama exposed and linear, as stored or through a camera from inside: what bloom goes over.
const SAMPLE = /* wgsl */ `
${rundbild.panorama}
struct Params { right: vec3f, tx: f32, up: vec3f, ty: f32, forward: vec3f, exposure: f32, projected: u32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var image: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;
@group(0) @binding(3) var output: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(output);
    if (any(id.xy >= size)) {
        return;
    }
    var uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    if (params.projected != 0u) {
        let across = (uv.x * 2.0 - 1.0) * params.tx;
        let down = (1.0 - uv.y * 2.0) * params.ty;
        uv = rbEquirectangularUv(normalize(params.forward + params.right * across + params.up * down), 0.0);
    }
    let light = textureSampleLevel(image, imageSampler, uv, 0.0).rgb * params.exposure;
    textureStore(output, vec2i(id.xy), vec4f(min(light, vec3f(1e4)), 1.0));
}`;

// Then through a tone curve, with what the exposure pushes past white marked if asked.
const SHOW = (format: GPUTextureFormat) => /* wgsl */ `
${wgsl.tonemap}
struct Params { curve: u32, clipped: u32, headroom: f32, dither: u32, white: f32, black: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var light: texture_2d<f32>;
@group(0) @binding(2) var output: texture_storage_2d<${format}, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(output))) {
        return;
    }
    let exposed = textureLoad(light, id.xy, 0).rgb;
    var color: vec3f;
    switch params.curve {
        case 2u: { color = hdToneMapAgx(exposed); }
        case 3u: { color = hdToneMapAces(exposed); }
        case 4u: { color = hdToneMapClipHdr(exposed, params.headroom); }
        default: { color = hdToneMapNeutralHdr(exposed, params.headroom); }
    }
    // Half floats need none: their steps are far finer than 8 bits'.
    if (params.dither != 0u) {
        color = hdDither(color, id.xy, 255.0);
    }
    let peak = max(exposed.r, max(exposed.g, exposed.b));
    if (params.clipped != 0u && ((id.x + id.y) / 4u) % 2u == 0u) {
        if (peak >= params.white) {
            color = vec3f(1.0, 0.0, 0.3);
        } else if (peak < params.black) {
            color = vec3f(0.1, 0.45, 1.0);
        }
    }
    textureStore(output, vec2i(id.xy), vec4f(color, 1.0));
}`;

let sampling: GPUComputePipeline | null = null;
const showing = new Map<GPUTextureFormat, GPUComputePipeline>();
let sampler: GPUSampler | null = null;
// Per canvas, by its size: the linear image, and what bloom writes. And the bloom passes per size, their chains kept.
const targets = new WeakMap<HTMLCanvasElement, [GPUTexture, GPUTexture]>();
const blooms = new Map<string, BloomPass | null>();

export function context(canvas: HTMLCanvasElement) {
    const made = canvas.getContext("webgpu");
    if (made) configureCanvas(made, SDR);
    return made;
}

// The HDR choice is the page's, made in the sky figure: every figure follows it.
onDisplay(changed);

function uniform(device: GPUDevice, data: ArrayBuffer) {
    const buffer = device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.UNIFORM,
        mappedAtCreation: true,
    });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data));
    buffer.unmap();
    return buffer;
}

function targetsFor(device: GPUDevice, canvas: HTMLCanvasElement, width: number, height: number) {
    let made = targets.get(canvas);
    if (made?.[0].width !== width || made[0].height !== height) {
        for (const texture of made ?? []) texture.destroy();
        const target = () =>
            device.createTexture({
                label: "sternwarte:hdriLinear",
                size: [width, height],
                format: "rgba16float",
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            });
        made = [target(), target()];
        targets.set(canvas, made);
    }
    return made;
}

/** The bloom pass for a size, or null until it is compiled, which redraws. */
function bloomFor(device: GPUDevice, width: number, height: number) {
    const key = `${width}x${height}`;
    if (!blooms.has(key)) {
        blooms.set(key, null);
        createBloomPass(device).then((pass) => {
            blooms.set(key, pass);
            changed();
        });
    }
    return blooms.get(key) ?? null;
}

/** Draws the shared HDRI into a canvas, as the page's switches and exposure say, through a tone curve. */
export function draw(
    canvas: HTMLCanvasElement,
    target: GPUCanvasContext,
    { curve = "clip", bloom: strength = 0 }: { curve?: ToneCurve; bloom?: number } = {},
) {
    if (!hdri.texture || gpu.error) return;
    const device = gpuDevice();
    const dpr = window.devicePixelRatio || 1;
    const [width, height] = [canvas.clientWidth * dpr, canvas.clientHeight * dpr].map((n) =>
        Math.max(1, Math.round(n)),
    ) as [number, number];
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    sampling ??= device.createComputePipeline({
        label: "sternwarte:hdriSample",
        layout: "auto",
        compute: { module: device.createShaderModule({ code: SAMPLE }), entryPoint: "main" },
    });
    const { format, headroom } = displayOutput();
    if (target.getConfiguration()?.format !== format) configureCanvas(target, format);
    let show = showing.get(format);
    if (!show) {
        show = device.createComputePipeline({
            label: "sternwarte:hdriShow",
            layout: "auto",
            compute: { module: device.createShaderModule({ code: SHOW(format) }), entryPoint: "main" },
        });
        showing.set(format, show);
    }
    sampler ??= device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "repeat" });

    const { yaw, pitch, fov } = view;
    const forward = [Math.cos(pitch) * Math.sin(yaw), Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch)];
    const right = [Math.cos(yaw), -Math.sin(yaw), 0];
    const up = [-Math.sin(pitch) * Math.sin(yaw), -Math.sin(pitch) * Math.cos(yaw), Math.cos(pitch)];
    const ty = Math.tan(fov / 2);
    const sample = new ArrayBuffer(64);
    new Float32Array(sample).set([...right, ty * (width / height), ...up, ty, ...forward, 1 / (1.2 * 2 ** hdri.ev100)]);
    new Uint32Array(sample)[12] = view.projected ? 1 : 0;
    const showData = new ArrayBuffer(32);
    new Uint32Array(showData).set([
        { neutral: 1, agx: 2, aces: 3, clip: 4 }[curve],
        view.clipped ? 1 : 0,
        0,
        format === SDR ? 1 : 0,
    ]);
    new Float32Array(showData)[2] = headroom;
    new Float32Array(showData).set([view.white, view.black], 4);
    const sampleParams = uniform(device, sample);
    const showParams = uniform(device, showData);

    const [linear, bloomed] = targetsFor(device, canvas, width, height);
    const bloom = strength > 0 ? bloomFor(device, width, height) : null;
    const encoder = device.createCommandEncoder({ label: "sternwarte:hdriDisplay" });
    const dispatch = (pipeline: GPUComputePipeline, entries: GPUBindGroupEntry[]) => {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.end();
    };
    dispatch(sampling, [
        { binding: 0, resource: { buffer: sampleParams } },
        { binding: 1, resource: hdri.texture.createView() },
        { binding: 2, resource: sampler },
        { binding: 3, resource: linear.createView() },
    ]);
    bloom?.encode(encoder, linear, bloomed, strength);
    dispatch(show, [
        { binding: 0, resource: { buffer: showParams } },
        { binding: 1, resource: (bloom ? bloomed : linear).createView() },
        { binding: 2, resource: target.getCurrentTexture().createView() },
    ]);
    device.queue.submit([encoder.finish()]);
    sampleParams.destroy();
    showParams.destroy();
}
