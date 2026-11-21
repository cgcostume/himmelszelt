#!/usr/bin/env node
// Makes the Moon's maps for a renderer from NASA's CGI Moon Kit (svs.gsfc.nasa.gov/4720): the color map of December
// 2025, from the LROC WAC Hapke-normalized mosaic, and a height map from the LOLA elevation map at 64 pixels per degree,
// 512 to 8192 texels around (`mapWidthFor` says which a disc needs). Equirectangular, centered on 0° longitude, east to
// the right, north up. The seen maps hold only what Earth ever sees: past the edge of what any libration shows, the color
// fades into that part's own mean and the heights to none, which makes them a third smaller. Rerunnable: `node scripts/maps.mjs [--size 512,1k,2k,4k,8k]
// [--whole] [--seen] [--out <dir>] [--cache <dir>] [--force]`, the seen 512 and 1K by default, which the package ships.
// Needs sharp, and a few GB of memory for the elevation map; resizes as ImageMagick's box and Lanczos filters did. Downloads 590 MB once
// into the cache, the 8K another 240 MB. Prints the near side's mean color, which `createMoonMaps` takes as `meanColor`,
// so that the drawn disc averages the Moon's geometric albedo and color.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    download,
    mapFile,
    options,
    readTiff16,
    resize,
    seenFade,
    towards,
    towardsMean,
    upToDate,
    WIDTHS,
    writeWebp,
} from "./common.mjs";

const SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720";
const colorSource = (size) => `${SVS}/lroc_color_16bit_srgb_${size === "8k" ? "8k" : "4k"}.tif`;
const DEM = `${SVS}/ldem_64_uint.tif`;
const MEAN = { width: 1024, height: 512 };

const { out, cache, force, sizes, variants } = options(Object.keys(WIDTHS));
const outputs = sizes.flatMap((size) =>
    variants.flatMap((seen) => ["color", "height"].map((kind) => join(out, mapFile(kind, size, seen)))),
);
const sources = [...new Set([...sizes.map(colorSource), DEM])].map((url) => join(cache, url.split("/").pop() ?? ""));
const scripts = ["maps.mjs", "common.mjs"].map((file) => fileURLToPath(new URL(file, import.meta.url)));
if (upToDate(outputs, [...sources, ...scripts], force)) {
    console.log("the maps are up to date; --force remakes them");
    process.exit(0);
}

const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const srgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const LINEAR16 = Float32Array.from({ length: 65536 }, (_, i) => linear(i / 65535));
// ImageMagick's float pixels, 0 to 65535, in linear light, and their rounding to 16 and 8 bits.
const QUANTUM_LINEAR = LINEAR16.map((v) => 65535 * v);
const to16 = (v) => Math.min(65535, Math.max(0, Math.trunc(v + 0.5)));
const to8 = (v) => Math.min(255, Math.max(0, Math.trunc(v / 257 + 0.5)));
const tiffs = new Map();
const tiff = async (file) => tiffs.get(file) ?? tiffs.set(file, await readTiff16(file)).get(file);

// The color map as 8-bit sRGB WebP, lossy: the albedo map is smooth enough for it. The smaller ones averaged down in
// linear light, and so the seen ones faded into their mean.
for (const size of sizes) {
    const source = await tiff(download(colorSource(size), cache, size === "8k" ? "240 MB" : "62 MB"));
    const width = WIDTHS[size];
    const height = width / 2;
    const u16 =
        source.width === width
            ? source.data
            : Uint16Array.from(
                  resize(
                      Float32Array.from(source.data, (v) => QUANTUM_LINEAR[v]),
                      source.width,
                      source.height,
                      3,
                      width,
                      height,
                  ),
                  (v) => to16(65535 * srgb(v / 65535)),
              );
    for (const seen of variants) {
        const file = join(out, mapFile("color", size, seen));
        if (!seen) {
            await writeWebp(Uint8Array.from(u16, to8), width, height, file, false);
            continue;
        }
        const channels = [0, 1, 2].map((k) =>
            Float32Array.from({ length: width * height }, (_, i) => LINEAR16[u16[i * 3 + k]]),
        );
        const { faded } = towardsMean(channels, seenFade(width), width);
        const rgb = new Uint8Array(width * height * 3);
        for (let i = 0; i < width * height; i++)
            for (let k = 0; k < 3; k++) rgb[i * 3 + k] = Math.round(srgb(faded[k][i]) * 255);
        await writeWebp(rgb, width, height, file, false);
    }
}

// The near side's mean color at full moon, linear: each texel weighted by the area it shows from the sub-Earth point,
// cos(lon) cos(lat) for the slant and cos(lat) for the equirectangular stretch.
const four = await tiff(download(colorSource("4k"), cache, "62 MB"));
const near = Uint8Array.from(resize(four.data, four.width, four.height, 3, MEAN.width, MEAN.height, "lanczos"), to8);
const sum = [0, 0, 0];
let weights = 0;
for (let y = 0; y < MEAN.height; y++) {
    const lat = (0.5 - (y + 0.5) / MEAN.height) * Math.PI;
    for (let x = 0; x < MEAN.width; x++) {
        const lon = ((x + 0.5) / MEAN.width - 0.5) * 2 * Math.PI;
        if (Math.abs(lon) >= Math.PI / 2) continue;
        const w = Math.cos(lon) * Math.cos(lat) ** 2;
        const i = (y * MEAN.width + x) * 3;
        for (let c = 0; c < 3; c++) sum[c] += linear(near[i + c] / 255) * w;
        weights += w;
    }
}
const meanColor = sum.map((s) => s / weights);
// Luminance, Rec. 709.
const mean = 0.2126 * meanColor[0] + 0.7152 * meanColor[1] + 0.0722 * meanColor[2];
console.log(`near side mean color ${meanColor.map((c) => c.toFixed(4)).join(", ")}, reflectance ${mean.toFixed(4)}`);

// The heights as they are, LOLA's 16-bit half meters offset by 20,000 over the mean radius, averaged down from 64
// texels per degree, and stored losslessly in two 8-bit channels, red the high byte and green the low one: WebP holds
// no 16-bit gray. Up to 4K from one resampling to 4096, box averaged; the 8K resampled on its own.
// Past what Earth sees, the mean radius: no height, 0 m.
const ZERO = 20000;
const dem = await readTiff16(download(DEM, cache, "530 MB"), true);
const gray = (width) => Uint16Array.from(resize(dem.data, dem.width, dem.height, 1, width, width / 2), to16);
let base;
for (const size of sizes) {
    const width = WIDTHS[size];
    const height = width / 2;
    let values;
    if (width > 4096) {
        values = Float32Array.from(gray(width));
    } else {
        base ??= gray(4096);
        const step = 4096 / width;
        values = new Float32Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let total = 0;
                for (let dy = 0; dy < step; dy++)
                    for (let dx = 0; dx < step; dx++) total += base[(y * step + dy) * 4096 + x * step + dx];
                values[y * width + x] = Math.round(total / (step * step));
            }
        }
    }
    for (const seen of variants) {
        const heights = seen ? towards([values], seenFade(width), [ZERO])[0] : values;
        const rgb = new Uint8Array(width * height * 3);
        for (let i = 0; i < width * height; i++) {
            const v = Math.round(heights[i]);
            rgb[i * 3] = v >> 8;
            rgb[i * 3 + 1] = v & 255;
        }
        await writeWebp(rgb, width, height, join(out, mapFile("height", size, seen)), true);
    }
}
