// What the map scripts share: their options, the download cache, skipping work already done, reading and writing images
// with sharp, ImageMagick's resize filters, the maps' names, and the fade that gives the part of the Moon no libration
// ever shows that part's own mean.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSource } from "./mirror.mjs";

/** The package's own maps directory, next to the scripts, wherever the package is installed. */
export const MAPS = fileURLToPath(new URL("../maps/", import.meta.url));

/** The suffix, before the size, of the maps that hold only what Earth sees: `moon-color-seen-1k.webp`. */
export const SEEN = "seen";

/** The sizes by name, in texels around. */
export const WIDTHS = { 512: 512, "1k": 1024, "2k": 2048, "4k": 4096, "8k": 8192 };

/** The sizes the package ships, of the seen maps alone. */
export const SHIPPED = ["512", "1k"];

/** A map's file name: its kind, color, height or roughness, whether seen, and its size. */
export const mapFile = (kind, size, seen) => `moon-${kind}-${seen ? `${SEEN}-` : ""}${size}.webp`;

/**
 * The options every script takes: `--out <dir>`, the package's maps directory by default; `--cache <dir>`, where
 * downloads are kept, `node_modules/.cache/nachtgestirn-maps` of the directory it is run from; `--force` to redo the work
 * even where the output is newer than its inputs; `--size 512,1k,...`, the shipped sizes by default, of `sizes`; and
 * `--whole` and `--seen`, which maps, the seen ones alone by default.
 */
export function options(sizes, argv = process.argv.slice(2)) {
    const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
    const out = resolve(option("--out", MAPS));
    const cache = resolve(option("--cache", join("node_modules", ".cache", "nachtgestirn-maps")));
    const asked = option("--size", SHIPPED.join(",")).split(",");
    const unknown = asked.filter((size) => !sizes.includes(size));
    if (unknown.length > 0) throw new Error(`no size ${unknown.join(", ")}: ${sizes.join(", ")}`);
    const whole = argv.includes("--whole");
    const variants = [...(whole ? [false] : []), ...(argv.includes("--seen") || !whole ? [true] : [])];
    mkdirSync(out, { recursive: true });
    mkdirSync(cache, { recursive: true });
    return { out, cache, force: argv.includes("--force"), sizes: asked, variants };
}

/** Whether every output exists and is newer than every input: then the script has nothing to do. */
export function upToDate(outputs, inputs, force = false) {
    if (force || !outputs.every((output) => existsSync(output))) return false;
    const made = Math.min(...outputs.map((output) => statSync(output).mtimeMs));
    return inputs.every((input) => !existsSync(input) || statSync(input).mtimeMs <= made);
}

/** Downloads `url` into the cache once, from the asset mirror first, and returns the file's path. */
export function download(url, cache, size) {
    const file = join(cache, basename(url));
    if (existsSync(file)) return file;
    mkdirSync(dirname(file), { recursive: true });
    fetchSource(ASSETS, url, file, size);
    return file;
}

/** The files the package's scripts download or build, as the asset mirror holds them. */
export const ASSETS = fileURLToPath(new URL("../assets.json", import.meta.url));

/** sharp, which reads the TIFFs and writes the WebPs: a peer dependency, installed with the package or on its own. */
export async function sharp() {
    try {
        return (await import("sharp")).default;
    } catch {
        throw new Error("the maps need sharp: npm install sharp");
    }
}

/** A TIFF's 16-bit samples as stored, its ICC profile ignored, as `{ data, width, height, channels }`. */
export async function readTiff16(file, grey = false) {
    const image = (await sharp())(file, { ignoreIcc: true, limitInputPixels: false });
    const { data, info } = await image
        .toColourspace(grey ? "grey16" : "rgb16")
        .raw({ depth: "ushort" })
        .toBuffer({ resolveWithObject: true });
    const samples = new Uint16Array(data.buffer, data.byteOffset, data.length / 2);
    return { data: samples, width: info.width, height: info.height, channels: info.channels };
}

const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
/** ImageMagick's filters by name: support in source texels at scale 1, and weight. */
const FILTERS = { box: [0.5, () => 1], lanczos: [3, (x) => sinc(x) * sinc(x / 3)] };

/** For each output texel along an axis, the first source texel and the normalized weights, as ImageMagick's resize. */
function contributions(from, to, [support, weight]) {
    const factor = to / from;
    const scale = Math.max(1 / factor, 1);
    const reach = Math.max(scale * support, 0.5);
    return Array.from({ length: to }, (_, x) => {
        const bisect = (x + 0.5) / factor + 1e-12;
        const start = Math.trunc(Math.max(bisect - reach + 0.5, 0));
        const stop = Math.trunc(Math.min(bisect + reach + 0.5, from));
        const weights = Array.from({ length: stop - start }, (_, n) => weight((start + n - bisect + 0.5) / scale));
        const density = weights.reduce((a, b) => a + b, 0);
        return { start, weights: Float64Array.from(weights, (w) => w / density) };
    });
}

/**
 * Resizes interleaved samples, `channels` a texel, as ImageMagick's `-filter <filter> -resize` does with its float
 * pixels: rows first, then columns, each from a window of whole source texels. Returns float samples.
 */
export function resize(data, width, height, channels, toWidth, toHeight, filter = "box") {
    const rows = contributions(height, toHeight, FILTERS[filter]);
    const columns = contributions(width, toWidth, FILTERS[filter]);
    const line = width * channels;
    const middle = new Float32Array(line * toHeight);
    const sums = new Float64Array(line);
    for (let y = 0; y < toHeight; y++) {
        const { start, weights } = rows[y];
        sums.fill(0);
        for (let n = 0; n < weights.length; n++)
            for (let i = 0, from = (start + n) * line; i < line; i++) sums[i] += weights[n] * data[from + i];
        middle.set(sums, y * line);
    }
    const out = new Float32Array(toWidth * toHeight * channels);
    const sum = new Float64Array(channels);
    for (let y = 0; y < toHeight; y++)
        for (let x = 0; x < toWidth; x++) {
            const { start, weights } = columns[x];
            sum.fill(0);
            for (let n = 0; n < weights.length; n++)
                for (let c = 0; c < channels; c++) sum[c] += weights[n] * middle[y * line + (start + n) * channels + c];
            out.set(sum, (y * toWidth + x) * channels);
        }
    return out;
}

/** WebP from 8-bit RGB `width` by `height`, lossless or lossy at the color map's quality, without metadata. */
export async function writeWebp(rgb, width, height, path, lossless) {
    const image = (await sharp())(rgb, { raw: { width, height, channels: 3 }, limitInputPixels: false });
    await image.webp(lossless ? { lossless: true } : { quality: 88, effort: 6 }).toFile(path);
    wrote(path);
}

export const wrote = (path) => console.log(`wrote ${basename(path)}, ${(statSync(path).size / 1e6).toFixed(2)} MB`);

const DEG = Math.PI / 180;
// How far the librations reach, in longitude and latitude, as the site's maps figure draws the edge of what is ever seen.
const REACH = { longitude: 7.9, latitude: 6.7 };
// Past that edge: the diurnal libration and the cap's shortfall from 90°, which the investigation measured within it.
const SLACK = 1.25;
// The fade to the mean begins this far past the edge and takes this long.
const MARGIN = 2;
const FEATHER = 4;

/**
 * How much of the never seen part's mean each texel of an equirectangular map `width` texels around takes, 0 where any
 * libration shows it, 1 well past: a smoothstep over the angle by which it lies beyond the edge of what is ever seen. That
 * edge lies a quarter turn from the mean sub-Earth point plus the librations' reach towards the texel, the support of a
 * rectangle, as `site/src/components/nachtgestirn/maps.ts` draws it.
 */
export function seenFade(width) {
    const height = width / 2;
    const fade = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        const lat = (0.5 - (y + 0.5) / height) * Math.PI;
        for (let x = 0; x < width; x++) {
            const lon = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
            const [px, py, pz] = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
            const psi = Math.atan2(pz, py);
            const reach = REACH.longitude * Math.abs(Math.cos(psi)) + REACH.latitude * Math.abs(Math.sin(psi));
            const beyond = Math.acos(Math.max(-1, Math.min(1, px))) / DEG - 90 - reach - SLACK;
            const t = Math.max(0, Math.min(1, (beyond - MARGIN) / FEATHER));
            fade[y * width + x] = t * t * (3 - 2 * t);
        }
    }
    return fade;
}

/**
 * Each channel, `width` texels around, faded towards its own mean over the part `fade` fully replaces, each texel
 * weighted by its area, cos(latitude). Returns the faded channels, new arrays of the same type, and the means.
 */
export function towardsMean(channels, fade, width) {
    const height = width / 2;
    const means = channels.map(() => 0);
    let area = 0;
    for (let y = 0; y < height; y++) {
        const a = Math.cos((0.5 - (y + 0.5) / height) * Math.PI);
        for (let i = y * width; i < (y + 1) * width; i++) {
            if (fade[i] < 1) continue;
            for (let k = 0; k < channels.length; k++) means[k] += channels[k][i] * a;
            area += a;
        }
    }
    for (let k = 0; k < means.length; k++) means[k] /= area;
    const faded = channels.map((channel, k) => channel.map((v, i) => v + (means[k] - v) * fade[i]));
    return { faded, means };
}

/** Each channel faded towards a fixed value, `values` one per channel, over the part `fade` replaces: new arrays. */
export const towards = (channels, fade, values) =>
    channels.map((c, k) => c.map((v, i) => v + (values[k] - v) * fade[i]));
