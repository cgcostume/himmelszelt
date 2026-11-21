#!/usr/bin/env node
// Makes data/brightstars.bin.gz from data/brightstars.csv, the checked-in source of truth: a flat little-endian
// Float32Array of eight fields per star, as precise as the original C++ floats, in the order the pass reads them:
// vmag, right ascension J2000 in degrees (the CSV has hours, as the Yale catalog), declination in degrees, proper
// motion in right ascension and in declination in arcseconds per year, and the star's linear sRGB color at unit
// luminance, from the CSV's color index B-V as `colorFromColorIndex` in `src/color.ts` computes it: Ballesteros'
// temperature, Kang et al.'s Planckian locus, the IEC matrix. Written as byte planes, gzip compressed, as
// `loadCatalog` reads them. And data/brightstars-compact.bin.gz, three little-endian Uint32 a star, 12 bytes: the right
// ascension in 22 bits, a third of an arcsecond, and the magnitude in 10, hundredths from -2; the declination in 23
// bits, a 13th of an arcsecond, and B-V in 9, hundredths from -0.5; the two proper motions as Int16 in milliarcseconds a
// year. The CSV's magnitudes, colors and proper motions to the last digit, its positions to a sixth of an arcsecond,
// under the catalog's own rounding of a second. Rerunnable: `pnpm catalog [--out <dir>] [--force]`, which skips the
// work while the files are newer than the CSV and the script.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA, megabytes, notice, options, upToDate, writePlanes } from "./common.mjs";

const { out, force } = options();
const inPath = join(DATA, "brightstars.csv");
const outPath = join(out, "brightstars.bin.gz");
const outCompact = join(out, "brightstars-compact.bin.gz");
notice("yale");
const inputs = [inPath, fileURLToPath(import.meta.url)];
if (upToDate(outPath, inputs, force) && upToDate(outCompact, inputs, force)) {
    console.log(`${outPath} and ${outCompact} are up to date`);
    process.exit(0);
}

const [header, ...rows] = readFileSync(inPath, "utf8").trim().split("\n");
const columns = header.split(",");
if (columns.join() !== "vmag,ra,de,pmRa,pmDe,bv") throw new Error(`Unexpected columns: ${header}`);

function colorFromColorIndex(bv) {
    const t = Math.min(Math.max(4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62)), 1667), 25000);
    const o = 1 / t;
    const x =
        t <= 4000
            ? 0.17991 + o * (877.6956 + o * (-234358.0 + o * -266123900.0))
            : 0.24039 + o * (222.6347 + o * (2107037.9 + o * -3025846900.0));
    const y =
        t <= 2222
            ? -0.20219683 + x * (2.18555832 + x * (-1.3481102 + x * -1.1063814))
            : t <= 4000
              ? -0.16748867 + x * (2.09137015 + x * (-1.3741859 + x * -0.9549476))
              : -0.37001483 + x * (3.75112997 + x * (-5.8733867 + x * 3.081758));
    const X = x / y;
    const Z = (1 - x - y) / y;
    return [3.2406 * X - 1.5372 - 0.4986 * Z, -0.9689 * X + 1.8758 + 0.0415 * Z, 0.0557 * X - 0.204 + 1.057 * Z];
}

const FIELDS = 8;
const values = new Float32Array(rows.length * FIELDS);
const compact = new Uint32Array(rows.length * 3);
const code = (value, step, bits) => {
    const n = Math.round(value / step);
    if (n < 0 || n >= 2 ** bits) throw new Error(`${value} does not fit ${bits} bits of ${step}`);
    return n;
};
let brightest = Number.POSITIVE_INFINITY;
for (let i = 0; i < rows.length; i++) {
    const parts = rows[i].split(",").map(Number);
    if (parts.length !== columns.length || parts.some(Number.isNaN)) {
        throw new Error(`Row ${i} did not parse into ${columns.length} numbers: "${rows[i]}"`);
    }
    // Hours of right ascension to degrees; everything else as listed.
    parts[1] *= 15;
    values.set([...parts.slice(0, 5), ...colorFromColorIndex(parts[5])], i * FIELDS);
    brightest = Math.min(brightest, parts[0]);
    const [vmag, ra, de, pmRa, pmDe, bv] = parts;
    compact[i * 3] = ((Math.round((ra / 360) * 2 ** 22) % 2 ** 22) | (code(vmag + 2, 0.01, 10) << 22)) >>> 0;
    compact[i * 3 + 1] = (Math.round(((de + 90) / 180) * (2 ** 23 - 1)) | (code(bv + 0.5, 0.01, 9) << 23)) >>> 0;
    // Signed, as two's complement Int16: offset by half the range, then the sign bit flipped.
    const mas = (pm) => code(pm + 32.768, 0.001, 16) ^ 0x8000;
    compact[i * 3 + 2] = (mas(pmRa) | (mas(pmDe) << 16)) >>> 0;
}

const size = writePlanes(outPath, new Uint8Array(values.buffer), FIELDS * 4);
console.log(
    `Wrote ${rows.length} stars x ${FIELDS} fields (${megabytes(values.byteLength)}, ${megabytes(size)} packed), brightest ${brightest}, to ${outPath}`,
);
const compactSize = writePlanes(outCompact, new Uint8Array(compact.buffer), 12);
console.log(
    `Wrote them in 12 bytes a star (${megabytes(compact.byteLength)}, ${megabytes(compactSize)} packed) to ${outCompact}`,
);
