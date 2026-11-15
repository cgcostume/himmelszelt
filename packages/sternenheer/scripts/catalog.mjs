#!/usr/bin/env node
// Makes data/brightstars.bin from data/brightstars.csv, the checked-in source of truth: a flat little-endian
// Float32Array of eight fields per star, as precise as the original C++ floats, in the order the pass reads them:
// vmag, right ascension J2000 in degrees (the CSV has hours, as the Yale catalog), declination in degrees, proper
// motion in right ascension and in declination in arcseconds per year, and the star's linear sRGB color at unit
// luminance, from the CSV's color index B-V as `colorFromColorIndex` in `src/color.ts` computes it: Ballesteros'
// temperature, Kim et al.'s Planckian locus, the IEC matrix. Rerunnable: `pnpm catalog` whenever the CSV changes.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const inPath = new URL("../data/brightstars.csv", import.meta.url);
const outPath = new URL("../data/brightstars.bin", import.meta.url);

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
}

writeFileSync(outPath, Buffer.from(values.buffer));
console.log(
    `Wrote ${rows.length} stars x ${FIELDS} fields (${values.byteLength.toLocaleString()} bytes), brightest ${brightest}, to ${fileURLToPath(outPath)}`,
);
