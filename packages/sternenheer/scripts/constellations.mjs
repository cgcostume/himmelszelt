#!/usr/bin/env node
// Makes data/constellations.bin from data/constellations.csv, the checked-in source of truth: the constellations'
// lines as little-endian Uint16 triples, the constellation's index among the abbreviations in sorted order, as
// `CONSTELLATIONS` in `src/constellations.ts` lists them, and the two stars a line joins, as rows of
// data/brightstars.csv counted from 0. Rerunnable: `pnpm constellations [--out <dir>] [--force]`, which skips the work
// while the file is newer than the CSV and the script.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA, notice, options, upToDate } from "./common.mjs";

const { out, force } = options();
const inPath = join(DATA, "constellations.csv");
const outPath = join(out, "constellations.bin");
notice("constellations");
if (upToDate(outPath, [inPath, fileURLToPath(import.meta.url)], force)) {
    console.log(`${outPath} is up to date`);
    process.exit(0);
}

const [header, ...rows] = readFileSync(inPath, "utf8").trim().split("\n");
if (header !== "constellation,from,to") throw new Error(`Unexpected columns: ${header}`);

const lines = rows.map((row) => row.split(","));
const abbreviations = [...new Set(lines.map(([abbreviation]) => abbreviation))].sort();
const values = new Uint16Array(lines.length * 3);
lines.forEach(([abbreviation, from, to], i) => {
    const stars = [Number(from), Number(to)];
    if (stars.some((star) => !Number.isInteger(star) || star < 0))
        throw new Error(`Row ${i} did not parse: "${rows[i]}"`);
    values.set([abbreviations.indexOf(abbreviation), ...stars], i * 3);
});

writeFileSync(outPath, Buffer.from(values.buffer));
console.log(
    `Wrote ${lines.length} lines of ${abbreviations.length} constellations (${values.byteLength.toLocaleString()} bytes) to ${outPath}`,
);
