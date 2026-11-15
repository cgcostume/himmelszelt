#!/usr/bin/env node
// Makes the Milky Way's map for a renderer from NASA's Deep Star Maps 2020 (svs.gsfc.nasa.gov/4851): the "Milky Way
// background" layer, which holds the light of the stars of Gaia DR2 fainter than the Hipparcos and Tycho stars the
// bright-star layer draws, in J2000 equatorial coordinates, plate carrée, right ascension increasing to the left.
// Its stars that stand out as points are taken out and their light spread over the sky around them, since a renderer
// draws stars itself and a point in a map is a blur. Written 4096 and 2048 texels around as WebP with each channel's
// logarithm in 8 bits, STOPS stops below 1, so the dark sky between the clouds keeps as many steps as the clouds, and
// calibrated: the script prints the luminance in cd/m²
// a texel of value 1 stands for, found by matching the map plus the shipped catalog along the band of declination
// 35° to 45°, and the Hipparcos stars the package ships besides, to the integrated starlight Masana et al. (2021) give for the zenith at 40° N over a year, 75 nW/m²/sr in
// Johnson V, 23.2 magnitudes per square arcsecond. Rerunnable: `node scripts/milkyway.mjs <outDir> [--cache <dir>]`.
// Needs ImageMagick 7 (`magick`) with OpenEXR and WebP. Downloads 35 MB once into the cache.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851";
const SOURCE = "milkyway_2020_4k.exr";
const WIDTH = 4096;
const HEIGHT = 2048;
// Masana et al. 2021, table 4: the integrated starlight at the zenith of 40° N, a yearly mean, against their reference
// radiance of table 2 for 0 magnitudes per square arcsecond.
const ISL_RADIANCE = 75e-9;
const REFERENCE_RADIANCE = 143.1685;
// A star of magnitude 0 above the air, in lux: the Sun's 128,000 lux at -26.74.
const MAGNITUDE_ZERO_LUX = 128_000 * 10 ** (0.4 * -26.74);
const ARCSECOND = Math.PI / 180 / 3600;
const BAND = [35, 45];
// The stops below 1 a channel's 8 bits span, 255 steps of 3.3% each; darker is black. As `MILKY_WAY_STOPS`.
const STOPS = 12;
// A texel is a star where it is this many times brighter than the median of the 5 by 5 around it; its light beyond
// the median is spread by a Gaussian this many texels wide.
const STAR_RATIO = 2.5;
const SPREAD_TEXELS = 6;

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--"));
const cache = args.includes("--cache") ? args[args.indexOf("--cache") + 1] : "node_modules/.cache/sternenheer";
if (!out) {
    console.error("usage: node scripts/milkyway.mjs <outDir> [--cache <dir>]");
    process.exit(1);
}
mkdirSync(out, { recursive: true });
mkdirSync(cache, { recursive: true });

const source = join(cache, SOURCE);
if (!existsSync(source)) {
    console.log(`downloading ${SOURCE}`);
    execFileSync("curl", ["-sSL", "-o", source, `${SVS}/${SOURCE}`], { stdio: "inherit" });
}

function magick(args, input) {
    const result = spawnSync("magick", args, { input, maxBuffer: 2 ** 31 });
    if (result.status !== 0) throw new Error(`magick ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
}

// The map as linear floats, for the calibration.
const raw = magick([source, "-define", "quantum:format=floating-point", "-depth", "32", "-endian", "LSB", "rgb:-"]);
const values = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const luminanceOf = (i) => 0.2126 * values[i] + 0.7152 * values[i + 1] + 0.0722 * values[i + 2];
let bandSum = 0;
let bandWeight = 0;
let skySum = 0;
let skyWeight = 0;
let peak = 0;
for (let y = 0; y < HEIGHT; y++) {
    const declination = 90 - ((y + 0.5) / HEIGHT) * 180;
    const weight = Math.cos((declination * Math.PI) / 180);
    const inBand = declination >= BAND[0] && declination <= BAND[1];
    for (let x = 0; x < WIDTH; x++) {
        const l = luminanceOf((y * WIDTH + x) * 3);
        peak = Math.max(peak, l);
        skySum += l * weight;
        skyWeight += weight;
        if (inBand) {
            bandSum += l * weight;
            bandWeight += weight;
        }
    }
}
const mapBandMean = bandSum / bandWeight;

// The stars out: each texel that stands out against the median around it down to the median, and what it lost blurred
// back in, so the map keeps its light.
const lum = new Float32Array(WIDTH * HEIGHT);
for (let i = 0; i < lum.length; i++) lum[i] = luminanceOf(i * 3);
const lost = new Float32Array(values.length);
const window = new Float32Array(25);
let stars = 0;
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
        stars++;
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
console.log(`${stars.toLocaleString()} texels were stars, their light spread over ${SPREAD_TEXELS} texels`);

// The shipped catalog's light over the same band, as a luminance.
const rows = readFileSync(new URL("../data/brightstars.csv", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .slice(1);
let catalogLux = 0;
for (const row of rows) {
    const [vmag, , de] = row.split(",").map(Number);
    if (de >= BAND[0] && de <= BAND[1]) catalogLux += MAGNITUDE_ZERO_LUX * 10 ** (-0.4 * vmag);
}
// And the Hipparcos stars', which the map does not hold either.
let faintLux = 0;
for (const row of readFileSync(new URL("../data/hipparcos.csv", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .slice(1)) {
    const [vmag, , de] = row.split(",").map(Number);
    if (de >= BAND[0] && de <= BAND[1]) faintLux += MAGNITUDE_ZERO_LUX * 10 ** (-0.4 * vmag);
}
const bandSolidAngle = 2 * Math.PI * (Math.sin((BAND[1] * Math.PI) / 180) - Math.sin((BAND[0] * Math.PI) / 180));
const catalogBandMean = catalogLux / bandSolidAngle;

// Masana's starlight as a luminance: magnitudes per square arcsecond, then a magnitude-0 star per square arcsecond.
const magnitudesPerArcsecond = -2.5 * Math.log10(ISL_RADIANCE / REFERENCE_RADIANCE);
const starlight = (MAGNITUDE_ZERO_LUX * 10 ** (-0.4 * magnitudesPerArcsecond)) / ARCSECOND ** 2;
const faintBandMean = faintLux / bandSolidAngle;
const luminance = (starlight - catalogBandMean - faintBandMean) / mapBandMean;
const luminanceAlone = (starlight - catalogBandMean) / mapBandMean;
console.log(
    `integrated starlight ${magnitudesPerArcsecond.toFixed(2)} mag/arcsec², ${starlight.toExponential(3)} cd/m²`,
);
console.log(
    `over the band the catalog gives ${catalogBandMean.toExponential(3)} cd/m², Hipparcos ${faintBandMean.toExponential(3)}; without Hipparcos a texel of value 1 were ${luminanceAlone.toExponential(4)} cd/m²`,
);
console.log(
    `map mean over the band ${mapBandMean.toExponential(4)}, over the sky ${(skySum / skyWeight).toExponential(4)}, peak ${peak.toFixed(3)}`,
);
console.log(`a texel of value 1 is ${luminance.toExponential(4)} cd/m²`);

// The map as WebP, each channel's logarithm in 8 bits; the smaller one averaged down in linear light first.
function encode(linear, width, height, file) {
    const bytes = Buffer.alloc(width * height * 3);
    for (let i = 0; i < bytes.length; i++) {
        const v = linear[i];
        bytes[i] = v <= 0 ? 0 : Math.min(Math.max(Math.round((Math.log2(v) / STOPS + 1) * 255), 0), 255);
    }
    magick(
        [
            "-size",
            `${width}x${height}`,
            "-depth",
            "8",
            "rgb:-",
            "-quality",
            "95",
            "-define",
            "webp:method=6",
            join(out, file),
        ],
        bytes,
    );
    console.log(`wrote ${file}`);
}
encode(values, WIDTH, HEIGHT, "milkyway-4k.webp");
const half = new Float32Array((WIDTH / 2) * (HEIGHT / 2) * 3);
for (let y = 0; y < HEIGHT / 2; y++)
    for (let x = 0; x < WIDTH / 2; x++)
        for (let c = 0; c < 3; c++) {
            const at = (yy, xx) => values[((2 * y + yy) * WIDTH + 2 * x + xx) * 3 + c];
            half[(y * (WIDTH / 2) + x) * 3 + c] = (at(0, 0) + at(0, 1) + at(1, 0) + at(1, 1)) / 4;
        }
encode(half, WIDTH / 2, HEIGHT / 2, "milkyway-2k.webp");
writeFileSync(
    join(out, "milkyway.json"),
    `${JSON.stringify({ source: `${SVS}/${SOURCE}`, luminance, stops: STOPS, magnitudesPerArcsecond, bandDeclination: BAND }, null, 4)}\n`,
);
