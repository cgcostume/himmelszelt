#!/usr/bin/env node
// Makes the Moon's maps for a renderer from NASA's CGI Moon Kit (svs.gsfc.nasa.gov/4720): the color map of December
// 2025, from the LROC WAC Hapke-normalized mosaic, at 4096 x 2048, and a normal map at 2048 x 1024 from the LOLA
// elevation map at 16 pixels per degree. Both equirectangular, centered on 0° longitude, east to the right, north up.
// Rerunnable: `node scripts/maps.mjs <outDir> [--cache <dir>]`. Needs ImageMagick 7 (`magick`) with TIFF and WebP.
// Downloads some 95 MB once into the cache. Prints the near side's mean reflectance, which `createMoonMaps` takes as
// `meanReflectance`, so that the drawn disc averages the Moon's geometric albedo.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720";
const COLOR = "lroc_color_16bit_srgb_4k.tif";
const DEM = "ldem_16_uint.tif";
const MOON_RADIUS_M = 1_737_400;
// The elevation map's values: half meters, offset by 10 km, over a sphere of 1727.4 km, so 20,000 is the mean radius.
const DEM_OFFSET = 20_000;
const DEM_SCALE_M = 0.5;
const NORMALS = { width: 2048, height: 1024 };
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
    const result = spawnSync("magick", args, { input, maxBuffer: 1 << 30 });
    if (result.status !== 0) throw new Error(`magick ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
}

const color = download(COLOR);
const dem = download(DEM);

// The color map as 8-bit sRGB WebP, lossy: the albedo map is smooth enough for it.
magick([color, "-depth", "8", "-quality", "88", "-define", "webp:method=6", join(out, "moon-color-4k.webp")]);
console.log("wrote moon-color-4k.webp");

// The near side's mean reflectance at full moon, linear: each texel weighted by the area it shows from the sub-Earth
// point, cos(lon) cos(lat) for the slant and cos(lat) for the equirectangular stretch.
const srgb = magick([color, "-resize", `${MEAN.width}x${MEAN.height}!`, "-depth", "8", "rgb:-"]);
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
let sum = 0;
let weights = 0;
for (let y = 0; y < MEAN.height; y++) {
    const lat = (0.5 - (y + 0.5) / MEAN.height) * Math.PI;
    for (let x = 0; x < MEAN.width; x++) {
        const lon = ((x + 0.5) / MEAN.width - 0.5) * 2 * Math.PI;
        if (Math.abs(lon) >= Math.PI / 2) continue;
        const w = Math.cos(lon) * Math.cos(lat) ** 2;
        const i = (y * MEAN.width + x) * 3;
        // Luminance, Rec. 709.
        const l =
            0.2126 * linear(srgb[i] / 255) + 0.7152 * linear(srgb[i + 1] / 255) + 0.0722 * linear(srgb[i + 2] / 255);
        sum += l * w;
        weights += w;
    }
}
const mean = sum / weights;
console.log(`near side mean reflectance ${mean.toFixed(4)} (linear luminance)`);

// Normals from the elevation map: slopes in meters per meter, east and north, over a sphere of the Moon's mean radius.
const { width, height } = NORMALS;
const raw = magick([
    dem,
    "-filter",
    "Triangle",
    "-resize",
    `${width}x${height}!`,
    "-endian",
    "LSB",
    "-depth",
    "16",
    "gray:-",
]);
const heights = new Uint16Array(raw.buffer, raw.byteOffset, width * height);
const h = (x, y) =>
    (heights[Math.min(Math.max(y, 0), height - 1) * width + ((x + width) % width)] - DEM_OFFSET) * DEM_SCALE_M;
const normals = new Uint8Array(width * height * 3);
const metersY = (Math.PI * MOON_RADIUS_M) / height;
for (let y = 0; y < height; y++) {
    const lat = (0.5 - (y + 0.5) / height) * Math.PI;
    const metersX = (2 * Math.PI * MOON_RADIUS_M * Math.max(Math.cos(lat), 0.05)) / width;
    for (let x = 0; x < width; x++) {
        const east = (h(x + 1, y) - h(x - 1, y)) / (2 * metersX);
        // Image rows run south, so the slope northward is the negative of the one down the image.
        const north = (h(x, y - 1) - h(x, y + 1)) / (2 * metersY);
        const length = Math.hypot(east, north, 1);
        const i = (y * width + x) * 3;
        normals[i] = Math.round(((-east / length) * 0.5 + 0.5) * 255);
        normals[i + 1] = Math.round(((-north / length) * 0.5 + 0.5) * 255);
        normals[i + 2] = Math.round((1 / length) * 255);
    }
}
const normalsFile = join(out, "moon-normals-2k.webp");
magick(
    ["-size", `${width}x${height}`, "-depth", "8", "rgb:-", "-define", "webp:lossless=true", normalsFile],
    Buffer.from(normals.buffer),
);
console.log("wrote moon-normals-2k.webp");
writeFileSync(
    join(out, "README.md"),
    `# The Moon's maps

Made by \`pnpm --filter @himmelszelt/nachtgestirn maps\` from NASA's CGI Moon Kit (https://svs.gsfc.nasa.gov/4720),
credit NASA's Scientific Visualization Studio: the color map of December 2025, from the LROC WAC Hapke-normalized
mosaic, and a normal map from the LOLA elevation map. Equirectangular, centered on 0° longitude, east to the right,
north up. Near side mean reflectance ${mean.toFixed(4)}.
`,
);
