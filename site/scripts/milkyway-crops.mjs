#!/usr/bin/env node
// Cuts the stars chapter's "Three ways to store the dark" out of NASA's Milky Way map (SVS 4851): two patches of 384
// texels, one around the north galactic pole and one across the band in Cygnus, each three ways. As half floats, byte
// planes gzip compressed as sternenheer's data files are; as 8-bit sRGB; and as sternenheer's logarithm over 12 stops.
// The map goes through sternenheer's `scripts/milkyway.mjs` first, its stars taken out as there, and both 8-bit maps are
// encoded whole as that script writes them, WebP at quality 95, and the patches cut from their decoded pixels, so they
// hold what a renderer gets. Writes them losslessly, as WebP, and the whole maps' sizes into the figure's JSON.
// Rerunnable: `pnpm data:milkyway-crops [--force]` from site/, skipped while its outputs are newer than the script and the
// EXR. Needs sharp, and the EXR in sternenheer's download cache, where `pnpm data:milkyway` puts it, or downloads it, 35 MB.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { download, upToDate, writePlanes } from "../../packages/sternenheer/scripts/common.mjs";
import { readExr } from "../../packages/sternenheer/scripts/exr.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "../public/milkyway");
const JSON_OUT = join(here, "../src/components/sternenheer/storedark.json");
const CACHE = join(here, "../../packages/sternenheer/node_modules/.cache/sternenheer");
const SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851";
const SOURCE = "milkyway_2020_4k.exr";
const WIDTH = 4096;
const HEIGHT = 2048;
const SIZE = 384;
// As sternenheer's MILKY_WAY_STOPS, and its star removal's ratio and spread.
const STOPS = 12;
const STAR_RATIO = 2.5;
const SPREAD_TEXELS = 6;
// The patches' centers, right ascension and declination in degrees: the north galactic pole, and the band in Cygnus
// with the Great Rift's dark lanes and the star clouds beside them.
const PATCHES = { pole: [192.86, 27.13], band: [300, 36] };

const force = process.argv.includes("--force");
const outputs = [JSON_OUT, ...Object.keys(PATCHES).map((name) => join(OUT, `${name}-float.bin.gz`))];
const source = download(`${SVS}/${SOURCE}`, CACHE, SOURCE, "35 MB");
if (outputs.every((file) => upToDate(file, [source, fileURLToPath(import.meta.url)], force))) {
    console.log(`${OUT} is up to date`);
    process.exit(0);
}
mkdirSync(OUT, { recursive: true });

const rgb = (bytes, width, height) => sharp(bytes, { raw: { width, height, channels: 3 } });
const values = readExr(source).data;
const luminanceOf = (i) => 0.2126 * values[i] + 0.7152 * values[i + 1] + 0.0722 * values[i + 2];

// The stars out, as sternenheer's milkyway.mjs takes them out.
const lum = new Float32Array(WIDTH * HEIGHT);
for (let i = 0; i < lum.length; i++) lum[i] = luminanceOf(i * 3);
const lost = new Float32Array(values.length);
const window = new Float32Array(25);
for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
        let n = 0;
        for (let dy = -2; dy <= 2; dy++) {
            const yy = Math.min(Math.max(y + dy, 0), HEIGHT - 1);
            for (let dx = -2; dx <= 2; dx++) window[n++] = lum[yy * WIDTH + ((x + dx + WIDTH) % WIDTH)];
        }
        window.sort();
        const median = window[12];
        const i = y * WIDTH + x;
        if (lum[i] <= STAR_RATIO * median + 1e-4) continue;
        const keep = median / lum[i];
        for (let c = 0; c < 3; c++) {
            lost[i * 3 + c] = values[i * 3 + c] * (1 - keep);
            values[i * 3 + c] *= keep;
        }
    }
}
const kernel = [];
for (let k = -3 * SPREAD_TEXELS; k <= 3 * SPREAD_TEXELS; k++)
    kernel.push(Math.exp((-0.5 * k * k) / SPREAD_TEXELS ** 2));
const kernelSum = kernel.reduce((a, b) => a + b, 0);
const reach = 3 * SPREAD_TEXELS;
const pass = new Float32Array(values.length);
for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++)
        for (let c = 0; c < 3; c++) {
            let sum = 0;
            for (let k = -reach; k <= reach; k++)
                sum += lost[(y * WIDTH + ((x + k + WIDTH) % WIDTH)) * 3 + c] * kernel[k + reach];
            pass[(y * WIDTH + x) * 3 + c] = sum / kernelSum;
        }
for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++)
        for (let c = 0; c < 3; c++) {
            let sum = 0;
            for (let k = -reach; k <= reach; k++)
                sum += pass[(Math.min(Math.max(y + k, 0), HEIGHT - 1) * WIDTH + x) * 3 + c] * kernel[k + reach];
            values[(y * WIDTH + x) * 3 + c] += sum / kernelSum;
        }

// Both 8-bit maps whole, as WebP at milkyway.mjs' settings, and back to their pixels.
const srgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const encodings = {
    srgb: (v) => Math.round(srgb(Math.min(Math.max(v, 0), 1)) * 255),
    log: (v) => (v <= 0 ? 0 : Math.min(Math.max(Math.round((Math.log2(v) / STOPS + 1) * 255), 0), 255)),
};
const decoded = {};
const sizes = { exr: statSync(source).size };
for (const [name, encode] of Object.entries(encodings)) {
    const bytes = Buffer.alloc(values.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = encode(values[i]);
    const webp = join(CACHE, `storedark-${name}-4k.webp`);
    await rgb(bytes, WIDTH, HEIGHT).webp({ quality: 95, effort: 6 }).toFile(webp);
    sizes[name] = statSync(webp).size;
    decoded[name] = await sharp(webp).raw().toBuffer();
}

// Each patch's texels, the map wrapping around in right ascension.
async function cut(name, [rightAscension, declination]) {
    const u = (((0.5 - rightAscension / 360) % 1) + 1) % 1;
    const x0 = Math.round(u * WIDTH) - SIZE / 2;
    const y0 = Math.round(((90 - declination) / 180) * HEIGHT) - SIZE / 2;
    const at = (x, y) => ((y0 + y) * WIDTH + ((x0 + x + WIDTH) % WIDTH)) * 3;
    const half = new Float16Array(SIZE * SIZE * 3);
    const stops = [];
    for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE; x++) {
            const i = at(x, y);
            half.set(values.subarray(i, i + 3), (y * SIZE + x) * 3);
            stops.push(Math.log2(Math.max(luminanceOf(i), 1e-12)));
        }
    const floatBytes = writePlanes(join(OUT, `${name}-float.bin.gz`), new Uint8Array(half.buffer), 6);
    for (const encoding of Object.keys(encodings)) {
        const bytes = Buffer.alloc(SIZE * SIZE * 3);
        for (let y = 0; y < SIZE; y++)
            for (let x = 0; x < SIZE; x++) decoded[encoding].copy(bytes, (y * SIZE + x) * 3, at(x, y), at(x, y) + 3);
        const file = join(OUT, `${name}-${encoding}.webp`);
        await rgb(bytes, SIZE, SIZE).webp({ lossless: true, quality: 100, effort: 6 }).toFile(file);
    }
    stops.sort((a, b) => a - b);
    const percentile = (p) => Number(stops[Math.floor(p * (stops.length - 1))].toFixed(2));
    const range = { low: percentile(0.02), median: percentile(0.5), high: percentile(0.98) };
    console.log(`${name}: at x ${x0}, y ${y0}; luminance in stops below 1, ${JSON.stringify(range)}; ${floatBytes} B`);
    return { x: x0, y: y0, rightAscension, declination, ...range };
}
const patches = {};
for (const [name, at] of Object.entries(PATCHES)) patches[name] = await cut(name, at);
console.log(`whole map: EXR ${sizes.exr} B, sRGB WebP ${sizes.srgb} B, logarithm WebP ${sizes.log} B`);
writeFileSync(JSON_OUT, `${JSON.stringify({ size: SIZE, stops: STOPS, sizes, patches }, null, 4)}\n`);
