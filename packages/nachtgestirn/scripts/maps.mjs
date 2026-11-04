#!/usr/bin/env node
// Makes the Moon's maps for a renderer from NASA's CGI Moon Kit (svs.gsfc.nasa.gov/4720): the color map of December
// 2025, from the LROC WAC Hapke-normalized mosaic, and a height map from the LOLA elevation map at 64 pixels per
// degree, each 4096, 1024 and 512 texels around (`mapWidthFor` says which a disc needs). Equirectangular, centered on
// 0° longitude, east to the right, north up. Rerunnable: `node scripts/maps.mjs <outDir> [--cache <dir>]`. Needs
// ImageMagick 7 (`magick`) with TIFF and WebP, and a few GB of memory for the elevation map. Downloads some 565 MB once
// into the cache. Prints the near side's mean color, which `createMoonMaps` takes as `meanColor`, so that the drawn
// disc averages the Moon's geometric albedo and color.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720";
const COLOR = "lroc_color_16bit_srgb_4k.tif";
const DEM = "ldem_64_uint.tif";
const SIZES = [
    ["4k", 4096],
    ["1k", 1024],
    ["512", 512],
];
const MEAN = { width: 1024, height: 512 };

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--"));
const cache = args.includes("--cache") ? args[args.indexOf("--cache") + 1] : "node_modules/.cache/nachtgestirn-maps";
if (!out) {
    console.error("usage: node scripts/maps.mjs <outDir> [--cache <dir>]");
    process.exit(1);
}
mkdirSync(out, { recursive: true });
mkdirSync(cache, { recursive: true });

function download(name) {
    const file = join(cache, name);
    if (!existsSync(file)) {
        console.log(`downloading ${name}`);
        execFileSync("curl", ["-sSL", "-o", file, `${SVS}/${name}`], { stdio: "inherit" });
    }
    return file;
}

function magick(args, input) {
    const result = spawnSync("magick", args, { input, maxBuffer: 2 ** 31 });
    if (result.status !== 0) throw new Error(`magick ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
}

const color = download(COLOR);
const dem = download(DEM);

// The color map as 8-bit sRGB WebP, lossy: the albedo map is smooth enough for it. The smaller ones averaged down in
// linear light.
for (const [name, width] of SIZES) {
    const resize = width === 4096 ? [] : ["-colorspace", "RGB", "-filter", "Box", "-resize", `${width}x${width / 2}!`];
    const back = width === 4096 ? [] : ["-colorspace", "sRGB"];
    const file = `moon-color-${name}.webp`;
    magick([color, ...resize, ...back, "-depth", "8", "-quality", "88", "-define", "webp:method=6", join(out, file)]);
    console.log(`wrote ${file}`);
}

// The near side's mean color at full moon, linear: each texel weighted by the area it shows from the sub-Earth point,
// cos(lon) cos(lat) for the slant and cos(lat) for the equirectangular stretch.
const srgb = magick([color, "-resize", `${MEAN.width}x${MEAN.height}!`, "-depth", "8", "rgb:-"]);
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const sum = [0, 0, 0];
let weights = 0;
for (let y = 0; y < MEAN.height; y++) {
    const lat = (0.5 - (y + 0.5) / MEAN.height) * Math.PI;
    for (let x = 0; x < MEAN.width; x++) {
        const lon = ((x + 0.5) / MEAN.width - 0.5) * 2 * Math.PI;
        if (Math.abs(lon) >= Math.PI / 2) continue;
        const w = Math.cos(lon) * Math.cos(lat) ** 2;
        const i = (y * MEAN.width + x) * 3;
        for (let c = 0; c < 3; c++) sum[c] += linear(srgb[i + c] / 255) * w;
        weights += w;
    }
}
const meanColor = sum.map((s) => s / weights);
// Luminance, Rec. 709.
const mean = 0.2126 * meanColor[0] + 0.7152 * meanColor[1] + 0.0722 * meanColor[2];
const meanText = `${meanColor.map((c) => c.toFixed(4)).join(", ")}, reflectance ${mean.toFixed(4)}`;
console.log(`near side mean color ${meanText}`);

// The heights as they are, LOLA's 16-bit half meters offset by 20,000 over the mean radius, averaged down from 64
// texels per degree, and stored losslessly in two 8-bit channels, red the high byte and green the low one: WebP holds
// no 16-bit gray.
const full = { width: 4096, height: 2048 };
const raw = magick([
    dem,
    "-filter",
    "Box",
    "-resize",
    `${full.width}x${full.height}!`,
    "-endian",
    "LSB",
    "-depth",
    "16",
    "gray:-",
]);
const heights = new Uint16Array(raw.buffer, raw.byteOffset, full.width * full.height);
for (const [name, width] of SIZES) {
    const height = width / 2;
    const step = full.width / width;
    const rgb = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let total = 0;
            for (let dy = 0; dy < step; dy++)
                for (let dx = 0; dx < step; dx++) total += heights[(y * step + dy) * full.width + x * step + dx];
            const v = Math.round(total / (step * step));
            const i = (y * width + x) * 3;
            rgb[i] = v >> 8;
            rgb[i + 1] = v & 255;
        }
    }
    const file = `moon-height-${name}.webp`;
    magick(
        ["-size", `${width}x${height}`, "-depth", "8", "rgb:-", "-define", "webp:lossless=true", join(out, file)],
        Buffer.from(rgb.buffer),
    );
    console.log(`wrote ${file}`);
}

writeFileSync(
    join(out, "README.md"),
    `# The Moon's maps

Made by \`pnpm --filter @himmelszelt/nachtgestirn maps\` from NASA's CGI Moon Kit (https://svs.gsfc.nasa.gov/4720),
credit NASA's Scientific Visualization Studio: the color map of December 2025, from the LROC WAC Hapke-normalized
mosaic, and a height map from the LOLA elevation map at 64 pixels per degree, LOLA's 16-bit half meters offset by
20,000 over the mean radius of 1737.4 km, red the high byte and green the low one. Each 4096, 1024 and 512 texels
around, equirectangular, centered on 0° longitude, east to the right, north up. Near side mean color, linear,
${meanText}.
`,
);
