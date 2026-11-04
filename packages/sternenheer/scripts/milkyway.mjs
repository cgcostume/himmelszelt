#!/usr/bin/env node
// Makes the Milky Way's map for a renderer from NASA's Deep Star Maps 2020 (svs.gsfc.nasa.gov/4851): the "Milky Way
// background" layer, which holds the light of the stars of Gaia DR2 fainter than the Hipparcos and Tycho stars the
// bright-star layer draws, in J2000 equatorial coordinates, plate carrée, right ascension increasing to the left.
// Written 4096 and 2048 texels around as sRGB-encoded WebP, and calibrated: the script prints the luminance in cd/m²
// a texel of value 1 stands for, found by matching the map plus the shipped catalog along the band of declination
// 35° to 45° to the integrated starlight Masana et al. (2021) give for the zenith at 40° N over a year, 75 nW/m²/sr in
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
const bandSolidAngle = 2 * Math.PI * (Math.sin((BAND[1] * Math.PI) / 180) - Math.sin((BAND[0] * Math.PI) / 180));
const catalogBandMean = catalogLux / bandSolidAngle;

// Masana's starlight as a luminance: magnitudes per square arcsecond, then a magnitude-0 star per square arcsecond.
const magnitudesPerArcsecond = -2.5 * Math.log10(ISL_RADIANCE / REFERENCE_RADIANCE);
const starlight = (MAGNITUDE_ZERO_LUX * 10 ** (-0.4 * magnitudesPerArcsecond)) / ARCSECOND ** 2;
const luminance = (starlight - catalogBandMean) / mapBandMean;
console.log(
    `integrated starlight ${magnitudesPerArcsecond.toFixed(2)} mag/arcsec², ${starlight.toExponential(3)} cd/m²`,
);
console.log(`the catalog's share over the band ${catalogBandMean.toExponential(3)} cd/m²`);
console.log(
    `map mean over the band ${mapBandMean.toExponential(4)}, over the sky ${(skySum / skyWeight).toExponential(4)}, peak ${peak.toFixed(3)}`,
);
console.log(`a texel of value 1 is ${luminance.toExponential(4)} cd/m²`);

// The map as 8-bit sRGB WebP, the smaller one averaged down in linear light; the clip at 1 is the source's own.
for (const [name, width] of [
    ["4k", 4096],
    ["2k", 2048],
]) {
    const resize = width === WIDTH ? [] : ["-filter", "Box", "-resize", `${width}x${width / 2}!`];
    const file = `milkyway-${name}.webp`;
    magick([
        source,
        "-set",
        "colorspace",
        "RGB",
        ...resize,
        "-colorspace",
        "sRGB",
        "-depth",
        "8",
        "-quality",
        "90",
        "-define",
        "webp:method=6",
        join(out, file),
    ]);
    console.log(`wrote ${file}`);
}
writeFileSync(
    join(out, "milkyway.json"),
    `${JSON.stringify({ source: `${SVS}/${SOURCE}`, luminance, magnitudesPerArcsecond, bandDeclination: BAND }, null, 4)}\n`,
);
