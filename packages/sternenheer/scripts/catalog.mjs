#!/usr/bin/env node
// Makes data/brightstars.bin from data/brightstars.csv, the checked-in source of truth: a flat little-endian
// Float32Array of eight fields per star, as precise as the original C++ floats, in the order the pass reads them:
// vmag, right ascension J2000 in degrees (the CSV has hours, as the Yale catalog), declination in degrees, proper
// motion in right ascension and in declination in arcseconds per year, and the star's linear sRGB color at unit
// luminance. Rerunnable: `pnpm catalog` whenever the CSV changes.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const inPath = new URL("../data/brightstars.csv", import.meta.url);
const outPath = new URL("../data/brightstars.bin", import.meta.url);

const [header, ...rows] = readFileSync(inPath, "utf8").trim().split("\n");
const columns = header.split(",");
if (columns.join() !== "vmag,ra,de,pmRa,pmDe,sRgbR,sRgbG,sRgbB") throw new Error(`Unexpected columns: ${header}`);

const values = new Float32Array(rows.length * columns.length);
let brightest = Number.POSITIVE_INFINITY;
for (let i = 0; i < rows.length; i++) {
    const parts = rows[i].split(",").map(Number);
    if (parts.length !== columns.length || parts.some(Number.isNaN)) {
        throw new Error(`Row ${i} did not parse into ${columns.length} numbers: "${rows[i]}"`);
    }
    // Hours of right ascension to degrees; everything else as listed.
    parts[1] *= 15;
    values.set(parts, i * columns.length);
    brightest = Math.min(brightest, parts[0]);
}

writeFileSync(outPath, Buffer.from(values.buffer));
console.log(
    `Wrote ${rows.length} stars x ${columns.length} fields (${values.byteLength.toLocaleString()} bytes), brightest ${brightest}, to ${fileURLToPath(outPath)}`,
);
