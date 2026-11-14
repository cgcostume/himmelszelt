#!/usr/bin/env node
// Makes the Moon's roughness map from Rosenburg et al. 2011's LOLA maps (PDS, LRO LOLA RDR, extras/fractal): red the
// median absolute slope over 57 m in tenths of a degree (MAS_57M_16), green the Hurst exponent from 57 m to 2.7 km
// (HE_8), 0.5 to 1 over 0 to 255, together how steep the ground is below what the relief map resolves. 1024, 2048 and
// 4096 texels around, equirectangular, centered on 0° longitude, east to the right, north up, as the other maps. Rerunnable:
// `node scripts/roughness.mjs <outDir> [--cache <dir>]`. Needs ImageMagick 7 (`magick`) with WebP. Downloads 39 MiB once.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PDS = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/extras/fractal/img";
// Each 16-bit little endian, from 0° east round to 360°, north to south; value = DN * scale + offset, as the labels say.
const SLOPE = { file: "MAS_57M_16.IMG", width: 5760, height: 2880, scale: 0.0015, offset: 45 };
const HURST = { file: "HE_8.IMG", width: 2880, height: 1440, scale: 0.000025, offset: 0.5 };
const SIZES = { "1k": 1024, "2k": 2048, "4k": 4096 };

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--"));
const cache = args.includes("--cache") ? args[args.indexOf("--cache") + 1] : "node_modules/.cache/nachtgestirn-maps";
if (!out) {
    console.error("usage: node scripts/roughness.mjs <outDir> [--cache <dir>]");
    process.exit(1);
}
mkdirSync(out, { recursive: true });
mkdirSync(cache, { recursive: true });

function load({ file, width, height, scale, offset }) {
    const path = join(cache, file);
    if (!existsSync(path)) {
        console.log(`downloading ${file}`);
        execFileSync("curl", ["-sSL", "-o", path, `${PDS}/${file}`], { stdio: "inherit" });
    }
    const bytes = readFileSync(path);
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
for (const [name, width] of Object.entries(SIZES)) {
    const OUT = { width, height: width / 2 };
    const [slope, hurst] = sources.map((source) => resample(source, OUT));
    const rgb = new Uint8Array(OUT.width * OUT.height * 3);
    for (let i = 0; i < slope.length; i++) {
        rgb[i * 3] = Math.max(0, Math.min(255, Math.round(slope[i] * 10)));
        rgb[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(((hurst[i] - 0.5) / 0.5) * 255)));
    }
    const file = `moon-roughness-${name}.webp`;
    const result = spawnSync(
        "magick",
        [
            "-size",
            `${OUT.width}x${OUT.height}`,
            "-depth",
            "8",
            "rgb:-",
            "-define",
            "webp:lossless=true",
            join(out, file),
        ],
        { input: Buffer.from(rgb.buffer), maxBuffer: 2 ** 28 },
    );
    if (result.status !== 0) throw new Error(`magick: ${result.stderr}`);
    console.log(
        `wrote ${file}: median slope ${median(slope).toFixed(2)}°, median Hurst exponent ${median(hurst).toFixed(3)}`,
    );
}
