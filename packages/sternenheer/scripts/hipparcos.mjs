#!/usr/bin/env node
// Makes data/hipparcos.bin from data/hipparcos.csv, the checked-in source of truth: the stars of the Hipparcos
// catalogue the bright star catalog does not hold, brightest first, packed into two little-endian Uint32 a star as
// `packStars` in `src/catalog.ts` lays them out: the right ascension in 24 bits and the magnitude in 8, the declination
// in 24 and the color index B-V in 8. Rerunnable: `pnpm hipparcos` whenever the CSV changes.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const inPath = new URL("../data/hipparcos.csv", import.meta.url);
const outPath = new URL("../data/hipparcos.bin", import.meta.url);

const [header, ...rows] = readFileSync(inPath, "utf8").trim().split("\n");
if (header !== "vmag,ra,de,bv") throw new Error(`Unexpected columns: ${header}`);

const clamp = (value, top) => Math.min(Math.max(Math.round(value), 0), top);
const values = new Uint32Array(rows.length * 2);
rows.forEach((row, i) => {
    const [vmag, ra, de, bv] = row.split(",").map(Number);
    if ([vmag, ra, de, bv].some(Number.isNaN)) throw new Error(`Row ${i} did not parse: "${row}"`);
    values[i * 2] = ((Math.round((ra / 360) * 2 ** 24) % 2 ** 24) | (clamp((vmag + 2) / 0.0625, 255) << 24)) >>> 0;
    values[i * 2 + 1] =
        (clamp(((de + 90) / 180) * (2 ** 24 - 1), 2 ** 24 - 1) | (clamp((bv + 0.5) / 0.01, 255) << 24)) >>> 0;
});

writeFileSync(outPath, Buffer.from(values.buffer));
console.log(`Wrote ${rows.length} stars (${values.byteLength.toLocaleString()} bytes) to ${fileURLToPath(outPath)}`);
