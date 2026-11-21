#!/usr/bin/env node
// Makes the Moon's roughness maps from Rosenburg et al. 2011's LOLA maps (PDS, LRO LOLA RDR, extras/fractal): red the
// median absolute slope over 57 m in tenths of a degree (MAS_57M_16), green the Hurst exponent from 57 m to 2.7 km
// (HE_8), 0.5 to 1 over 0 to 255, together how steep the ground is below what the relief map resolves. 512 to 4096 texels
// around, beyond which the source holds no more, equirectangular, centered on 0° longitude, east to the right, north up,
// as the other maps, seen and whole as `maps.mjs` makes them. Rerunnable: `node scripts/roughness.mjs [--size
// 512,1k,2k,4k] [--whole] [--seen] [--out <dir>] [--cache <dir>] [--force]`, the seen 512 and 1K by default. Needs
// sharp. Downloads 41 MB once.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { download, mapFile, options, seenFade, towards, upToDate, WIDTHS, writeWebp } from "./common.mjs";

const PDS = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/extras/fractal/img";
// Each 16-bit little endian, from 0° east round to 360°, north to south; value = DN * scale + offset, as the labels say.
const SLOPE = { file: "MAS_57M_16.IMG", size: "33 MB", width: 5760, height: 2880, scale: 0.0015, offset: 45 };
const HURST = { file: "HE_8.IMG", size: "8 MB", width: 2880, height: 1440, scale: 0.000025, offset: 0.5 };

const { out, cache, force, sizes, variants } = options(["512", "1k", "2k", "4k"]);
const outputs = sizes.flatMap((size) => variants.map((seen) => join(out, mapFile("roughness", size, seen))));
const scripts = ["roughness.mjs", "common.mjs"].map((file) => fileURLToPath(new URL(file, import.meta.url)));
if (upToDate(outputs, [...[SLOPE, HURST].map(({ file }) => join(cache, file)), ...scripts], force)) {
    console.log("the roughness maps are up to date; --force remakes them");
    process.exit(0);
}

function load({ file, size, width, height, scale, offset }) {
    const bytes = readFileSync(download(`${PDS}/${file}`, cache, size));
    const values = new Float32Array(width * height);
    for (let i = 0; i < values.length; i++) values[i] = bytes.readInt16LE(i * 2) * scale + offset;
    return { values, width, height };
}

// Recentered from 0°-360° to -180°-180°, `OUT` texels across: where the source is finer, the mean over each output texel,
// every source texel adding to the one its center falls in (cos(latitude) cancels within a row); where it is coarser,
// read bilinearly, so no output texel is left empty.
function resample({ values, width, height }, OUT) {
    if (width < OUT.width) {
        const out = new Float32Array(OUT.width * OUT.height);
        const at = (x, y) => values[Math.min(height - 1, Math.max(0, y)) * width + (((x % width) + width) % width)];
        for (let oy = 0; oy < OUT.height; oy++) {
            const sy = ((oy + 0.5) / OUT.height) * height - 0.5;
            const y0 = Math.floor(sy);
            for (let ox = 0; ox < OUT.width; ox++) {
                const lon = (((ox + 0.5) / OUT.width) * 360 + 180) % 360;
                const sx = (lon / 360) * width - 0.5;
                const x0 = Math.floor(sx);
                const [fx, fy] = [sx - x0, sy - y0];
                const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
                const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
                out[oy * OUT.width + ox] = top * (1 - fy) + bottom * fy;
            }
        }
        return out;
    }
    const sum = new Float64Array(OUT.width * OUT.height);
    const count = new Float64Array(OUT.width * OUT.height);
    for (let y = 0; y < height; y++) {
        const oy = Math.floor(((y + 0.5) / height) * OUT.height);
        for (let x = 0; x < width; x++) {
            const lon = ((x + 0.5) / width) * 360;
            const ox = Math.floor((((lon + 180) % 360) / 360) * OUT.width);
            const i = oy * OUT.width + ox;
            sum[i] += values[y * width + x];
            count[i] += 1;
        }
    }
    return sum.map((s, i) => s / count[i]);
}

const sources = [load(SLOPE), load(HURST)];
const sorted = (a) => Float64Array.from(a).sort();
const median = (a) => sorted(a)[a.length >> 1];
for (const size of sizes) {
    const OUT = { width: WIDTHS[size], height: WIDTHS[size] / 2 };
    const resampled = sources.map((source) => resample(source, OUT));
    console.log(
        `${size}: median slope ${median(resampled[0]).toFixed(2)}°, median Hurst exponent ${median(resampled[1]).toFixed(3)}`,
    );
    for (const seen of variants) {
        // Past what Earth sees, smooth: no slope, and the Hurst exponent its least, 0.5.
        const [slope, hurst] = seen ? towards(resampled, seenFade(OUT.width), [0, 0.5]) : resampled;
        const rgb = new Uint8Array(OUT.width * OUT.height * 3);
        for (let i = 0; i < slope.length; i++) {
            rgb[i * 3] = Math.max(0, Math.min(255, Math.round(slope[i] * 10)));
            rgb[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(((hurst[i] - 0.5) / 0.5) * 255)));
        }
        await writeWebp(rgb, OUT.width, OUT.height, join(out, mapFile("roughness", size, seen)), true);
    }
}
