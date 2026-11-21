#!/usr/bin/env node
// Makes the Milky Way's map for a renderer from NASA's Deep Star Maps 2020 (svs.gsfc.nasa.gov/4851): the "Milky Way
// background" layer, which holds the light of the stars of Gaia DR2 fainter than the Hipparcos and Tycho stars the
// bright-star layer draws, in J2000 equatorial coordinates, plate carrée, right ascension increasing to the left. Its
// stars that stand out as points are taken out and their light spread over the sky around them, since a renderer draws
// stars itself and a point in a map is a blur. Written as WebP with each channel's logarithm in 8 bits, STOPS stops
// below 1, so the dark sky between the clouds keeps as many steps as the clouds, and calibrated: the script prints the
// luminance in cd/m² a texel of value 1 stands for, found by matching the map plus the shipped catalog along the band
// of declination 35° to 45°, and the Hipparcos stars the package ships besides, to the integrated starlight Masana et
// al. (2021) give for the zenith at 40° N over a year, 75 nW/m²/sr in Johnson V, 23.2 magnitudes per square arcsecond.
//
// `--size 4k`, the default, writes the shipped maps, 4096 and 2048 texels around, and milkyway.json. `--size 8k` writes
// the larger map from NASA's own 8K file, 8192 around, which the package does not ship. NASA's texels hold the light
// that falls into them, so a texel of the finer map holds a quarter of the light: it is scaled by the texels' area, and
// a texel of value 1 stands for the same luminance in every map. Its stars are found on the map averaged down to 4096
// around, by the same rule, so the same stars are taken out at both sizes.
//
// Rerunnable: `pnpm data:milkyway [--size 4k|8k] [--out <dir>] [--cache <dir>] [--force]`, which skips the work while the
// maps are newer than the catalogs and the script. Needs sharp, for the WebP; the 4k maps also data/hipparcos.csv,
// which the repository holds, the 8k map only checks its calibration with it. Downloads 35 MB or 137 MB once into the
// cache, the asset mirror first, and decodes it in memory, 12 bytes a texel.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA, download, megabytes, notice, options, sharp, upToDate } from "./common.mjs";
import { readExr } from "./exr.mjs";

const SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851";
const SIZES = {
    "4k": { scale: 1, megabytes: 35, outputs: ["milkyway-4k.webp", "milkyway-2k.webp", "milkyway.json"] },
    "8k": { scale: 2, megabytes: 137, outputs: ["milkyway-8k.webp"] },
};
// The grid the stars are found on and their light is spread over, whatever the map's size.
const GRID_WIDTH = 4096;
const GRID_HEIGHT = 2048;
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
// A texel of the grid is a star where it is this many times brighter than the median of the 5 by 5 around it; its
// light beyond the median is spread by a Gaussian this many texels of the grid wide.
const STAR_RATIO = 2.5;
const SPREAD_TEXELS = 6;

const { out, cache, force, option } = options();
const sizeName = option("--size", "4k");
const size = SIZES[sizeName];
if (!size) throw new Error(`--size ${sizeName}: one of ${Object.keys(SIZES).join(", ")}`);
const { scale } = size;
const WIDTH = GRID_WIDTH * scale;
const HEIGHT = GRID_HEIGHT * scale;
notice("milkyway");
const hipparcos = join(DATA, "hipparcos.csv");
const inputs = [join(DATA, "brightstars.csv"), hipparcos, fileURLToPath(import.meta.url)];
const outputs = size.outputs.map((file) => join(out, file));
if (outputs.every((file) => upToDate(file, inputs, force))) {
    console.log(`${outputs.join(", ")} up to date`);
    process.exit(0);
}
if (scale === 1 && !existsSync(hipparcos)) throw new Error(`${hipparcos} is missing: the 4k maps are calibrated by it`);
const name = `milkyway_2020_${sizeName}.exr`;
const source = download(`${SVS}/${name}`, cache, name, `${size.megabytes} MB`);

// The map in memory, and a row of the grid at a time out of it.
const { data: texels } = readExr(source);
const rowFloats = WIDTH * 3 * scale;
const rows = new Float32Array(rowFloats);
// Each texel scaled by its area against the grid's, so a texel of value 1 stands for the same luminance at every size.
const unit = scale * scale;
function readRows(gy) {
    rows.set(texels.subarray(gy * rowFloats, (gy + 1) * rowFloats));
    for (let i = 0; i < rowFloats; i++) rows[i] *= unit;
}
const luminanceOf = (v, i) => 0.2126 * v[i] + 0.7152 * v[i + 1] + 0.0722 * v[i + 2];
const declinationOf = (y, height) => 90 - ((y + 0.5) / height) * 180;

// First the map averaged down to the grid, and its mean over the band and the sky, its brightest texel.
const grid = new Float32Array(GRID_WIDTH * GRID_HEIGHT * 3);
let [bandSum, bandWeight, skySum, skyWeight, peak] = [0, 0, 0, 0, 0];
for (let gy = 0; gy < GRID_HEIGHT; gy++) {
    readRows(gy);
    for (let sy = 0; sy < scale; sy++) {
        const declination = declinationOf(gy * scale + sy, HEIGHT);
        const weight = Math.cos((declination * Math.PI) / 180);
        const inBand = declination >= BAND[0] && declination <= BAND[1];
        for (let x = 0; x < WIDTH; x++) {
            const i = (sy * WIDTH + x) * 3;
            const l = luminanceOf(rows, i);
            peak = Math.max(peak, l);
            skySum += l * weight;
            skyWeight += weight;
            if (inBand) {
                bandSum += l * weight;
                bandWeight += weight;
            }
            const g = (gy * GRID_WIDTH + Math.floor(x / scale)) * 3;
            for (let c = 0; c < 3; c++) grid[g + c] += rows[i + c] / (scale * scale);
        }
    }
}
const mapBandMean = bandSum / bandWeight;

// The stars on the grid: each texel that stands out against the median around it. A texel of the map in a star's
// texel of the grid is brought down to that median, and the light it lost is summed on the grid.
const gridLuminance = new Float32Array(GRID_WIDTH * GRID_HEIGHT);
for (let i = 0; i < gridLuminance.length; i++) gridLuminance[i] = luminanceOf(grid, i * 3);
// The median where the grid's texel is a star, -1 elsewhere.
const starMedian = new Float32Array(GRID_WIDTH * GRID_HEIGHT).fill(-1);
const window = new Float32Array(25);
let stars = 0;
for (let y = 0; y < GRID_HEIGHT; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
        let n = 0;
        for (let dy = -2; dy <= 2; dy++) {
            const yy = Math.min(Math.max(y + dy, 0), GRID_HEIGHT - 1);
            for (let dx = -2; dx <= 2; dx++)
                window[n++] = gridLuminance[yy * GRID_WIDTH + ((x + dx + GRID_WIDTH) % GRID_WIDTH)];
        }
        window.sort();
        const i = y * GRID_WIDTH + x;
        if (gridLuminance[i] <= STAR_RATIO * window[12] + 1e-4) continue;
        starMedian[i] = window[12];
        stars++;
    }
}
function takeStarsOut(gy, lost) {
    for (let sy = 0; sy < scale; sy++)
        for (let x = 0; x < WIDTH; x++) {
            const g = gy * GRID_WIDTH + Math.floor(x / scale);
            const median = starMedian[g];
            if (median < 0) continue;
            const i = (sy * WIDTH + x) * 3;
            const l = luminanceOf(rows, i);
            if (l <= median) continue;
            const keep = median / l;
            for (let c = 0; c < 3; c++) {
                if (lost) lost[g * 3 + c] += (rows[i + c] * (1 - keep)) / (scale * scale);
                rows[i + c] *= keep;
            }
        }
}
const lost = new Float32Array(grid.length);
for (let gy = 0; gy < GRID_HEIGHT; gy++) {
    readRows(gy);
    takeStarsOut(gy, lost);
}
let [lostSum, gridSum] = [0, 0];
for (let y = 0; y < GRID_HEIGHT; y++) {
    const weight = Math.cos((declinationOf(y, GRID_HEIGHT) * Math.PI) / 180);
    for (let x = 0; x < GRID_WIDTH; x++) {
        lostSum += luminanceOf(lost, (y * GRID_WIDTH + x) * 3) * weight;
        gridSum += gridLuminance[y * GRID_WIDTH + x] * weight;
    }
}

// The lost light spread over the grid by a Gaussian, along the rows and then the columns.
const kernel = [];
for (let k = -3 * SPREAD_TEXELS; k <= 3 * SPREAD_TEXELS; k++)
    kernel.push(Math.exp((-0.5 * k * k) / SPREAD_TEXELS ** 2));
const kernelSum = kernel.reduce((a, b) => a + b, 0);
const reach = 3 * SPREAD_TEXELS;
const pass = new Float32Array(grid.length);
for (let y = 0; y < GRID_HEIGHT; y++)
    for (let x = 0; x < GRID_WIDTH; x++)
        for (let c = 0; c < 3; c++) {
            let sum = 0;
            for (let k = -reach; k <= reach; k++)
                sum += lost[(y * GRID_WIDTH + ((x + k + GRID_WIDTH) % GRID_WIDTH)) * 3 + c] * kernel[k + reach];
            pass[(y * GRID_WIDTH + x) * 3 + c] = sum / kernelSum;
        }
const spread = lost;
for (let y = 0; y < GRID_HEIGHT; y++)
    for (let x = 0; x < GRID_WIDTH; x++)
        for (let c = 0; c < 3; c++) {
            let sum = 0;
            for (let k = -reach; k <= reach; k++)
                sum +=
                    pass[(Math.min(Math.max(y + k, 0), GRID_HEIGHT - 1) * GRID_WIDTH + x) * 3 + c] * kernel[k + reach];
            spread[(y * GRID_WIDTH + x) * 3 + c] = sum / kernelSum;
        }
console.log(
    `${stars.toLocaleString()} texels of the grid were stars, ${((100 * lostSum) / gridSum).toFixed(1)}% of the light, spread over ${SPREAD_TEXELS} texels`,
);

// The calibration, from the shipped catalog's and the Hipparcos stars' light over the band, which the map lacks.
function bandLux(file) {
    let lux = 0;
    for (const row of readFileSync(file, "utf8").trim().split("\n").slice(1)) {
        const [vmag, , de] = row.split(",").map(Number);
        if (de >= BAND[0] && de <= BAND[1]) lux += MAGNITUDE_ZERO_LUX * 10 ** (-0.4 * vmag);
    }
    return lux;
}
const bandSolidAngle = 2 * Math.PI * (Math.sin((BAND[1] * Math.PI) / 180) - Math.sin((BAND[0] * Math.PI) / 180));
const magnitudesPerArcsecond = -2.5 * Math.log10(ISL_RADIANCE / REFERENCE_RADIANCE);
const starlight = (MAGNITUDE_ZERO_LUX * 10 ** (-0.4 * magnitudesPerArcsecond)) / ARCSECOND ** 2;
let luminance;
console.log(
    `map mean over the band ${mapBandMean.toExponential(4)}, over the sky ${(skySum / skyWeight).toExponential(4)}, peak ${peak.toFixed(3)}`,
);
if (existsSync(hipparcos)) {
    const catalogBandMean = bandLux(join(DATA, "brightstars.csv")) / bandSolidAngle;
    const faintBandMean = bandLux(hipparcos) / bandSolidAngle;
    luminance = (starlight - catalogBandMean - faintBandMean) / mapBandMean;
    console.log(
        `integrated starlight ${magnitudesPerArcsecond.toFixed(2)} mag/arcsec², ${starlight.toExponential(3)} cd/m²; over the band the catalog gives ${catalogBandMean.toExponential(3)} cd/m², Hipparcos ${faintBandMean.toExponential(3)}`,
    );
    console.log(`a texel of value 1 is ${luminance.toExponential(4)} cd/m²`);
}

// The map written: each channel's logarithm in 8 bits, a row of the grid at a time, the stars taken out and their light
// added back from the grid between its texels' centers. The 4k map also averaged down to 2048 around.
const toByte = (v) => (v <= 0 ? 0 : Math.min(Math.max(Math.round((Math.log2(v) / STOPS + 1) * 255), 0), 255));
const map = Buffer.alloc(WIDTH * HEIGHT * 3);
const small = scale === 1 ? new Float32Array((WIDTH / 2) * (HEIGHT / 2) * 3) : null;
const at = (x, y, c) => spread[(y * GRID_WIDTH + ((x + GRID_WIDTH) % GRID_WIDTH)) * 3 + c];
for (let gy = 0; gy < GRID_HEIGHT; gy++) {
    readRows(gy);
    takeStarsOut(gy, null);
    for (let sy = 0; sy < scale; sy++) {
        const y = gy * scale + sy;
        const v = Math.min(Math.max((y + 0.5) / scale - 0.5, 0), GRID_HEIGHT - 1);
        const [y0, fy] = [Math.floor(v), v - Math.floor(v)];
        const y1 = Math.min(y0 + 1, GRID_HEIGHT - 1);
        for (let x = 0; x < WIDTH; x++) {
            const u = (x + 0.5) / scale - 0.5;
            const [x0, fx] = [Math.floor(u), u - Math.floor(u)];
            const i = (sy * WIDTH + x) * 3;
            const p = (y * WIDTH + x) * 3;
            for (let c = 0; c < 3; c++) {
                const added =
                    (1 - fy) * ((1 - fx) * at(x0, y0, c) + fx * at(x0 + 1, y0, c)) +
                    fy * ((1 - fx) * at(x0, y1, c) + fx * at(x0 + 1, y1, c));
                const value = rows[i + c] + added;
                map[p + c] = toByte(value);
                if (small) small[((y >> 1) * (WIDTH / 2) + (x >> 1)) * 3 + c] += value / 4;
            }
        }
    }
}

async function encode(bytes, width, height, file) {
    const image = (await sharp())(bytes, { raw: { width, height, channels: 3 }, limitInputPixels: false });
    await image.webp({ quality: 95, effort: 6 }).toFile(join(out, file));
    console.log(`wrote ${file}, ${width} by ${height}`);
}
if (small) {
    await encode(map, WIDTH, HEIGHT, "milkyway-4k.webp");
    const bytes = Buffer.alloc(small.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = toByte(small[i]);
    await encode(bytes, WIDTH / 2, HEIGHT / 2, "milkyway-2k.webp");
    writeFileSync(
        join(out, "milkyway.json"),
        `${JSON.stringify({ source: `${SVS}/${name}`, luminance, stops: STOPS, magnitudesPerArcsecond, bandDeclination: BAND }, null, 4)}\n`,
    );
} else {
    await encode(map, WIDTH, HEIGHT, size.outputs[0]);
    console.log(
        `${megabytes(readFileSync(outputs[0]).length)}; on the GPU ${Math.round((WIDTH * HEIGHT * 4 * 4) / 3 / 2 ** 20)} MB with its mipmaps`,
    );
}
