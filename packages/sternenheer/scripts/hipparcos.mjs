#!/usr/bin/env node
// Makes data/hipparcos.bin.gz and data/hipparcos-compact.bin.gz: the stars of the Hipparcos catalogue (ESA 1997) the
// bright star catalog does not hold. The full file lists them brightest first, two little-endian Uint32 a star as
// `packStars` in `src/catalog.ts` lays them out, the right ascension in 24 bits and the magnitude in 8, the declination
// in 24 and the color index B-V in 8; the compact one sorts them into cells as `tycho.mjs` does Tycho-2's, 6 bytes a
// star, so one decoder reads all faint stars. Written as byte planes, gzip compressed, as `loadFaintStars` reads them. ESA's terms, CC BY-NC 3.0 IGO, keep the file out of
// the MIT package: each user makes it, here or by `npx @himmelszelt/sternenheer data hipparcos`.
//
// From data/hipparcos.csv where it is there, the repository's source of truth; else, as in an installed package, from
// the catalogue as NASA's HEASARC serves it, 15 MB downloaded once into the cache, reduced as the CSV was: the entries
// with astrometry and a magnitude, moved from the epoch J1991.25 to J2000.0 by their proper motion, B-V 0.65 where
// none is given, and none within half an arcminute of a star of data/brightstars.csv, or within 1.5 arcminutes and 0.3
// magnitudes of one. `--csv` writes that reduction to data/hipparcos.csv.
// Rerunnable: `pnpm hipparcos [--out <dir>] [--cache <dir>] [--download] [--csv] [--force]`.
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { DATA, download, fullWords, megabytes, notice, options, packCells, upToDate, writePlanes } from "./common.mjs";

const HEASARC = "https://heasarc.gsfc.nasa.gov/FTP/heasarc/dbase/tdat_files/heasarc_hipparcos.tdat.gz";
const TYPICAL_BV = 0.65;
// From the catalogue's epoch to J2000.0, in years.
const YEARS = 2000 - 1991.25;
// A Hipparcos entry is a star of the bright star catalog where it stands this close to one, in degrees, or this close
// and as bright as it within this many magnitudes.
const SAME = 0.5 / 60;
const NEAR = 1.5 / 60;
const NEAR_MAGNITUDES = 0.3;

const { out, cache, force, flag } = options();
const csvPath = join(DATA, "hipparcos.csv");
const outPath = join(out, "hipparcos.bin.gz");
const outCompact = join(out, "hipparcos-compact.bin.gz");
const fromCsv = existsSync(csvPath) && !flag("--download");
notice("hipparcos");
const inputs = [
    fromCsv ? csvPath : outPath,
    fileURLToPath(import.meta.url),
    fileURLToPath(new URL("common.mjs", import.meta.url)),
];
if (!flag("--csv") && upToDate(outPath, inputs, force) && upToDate(outCompact, inputs, force)) {
    console.log(`${outPath} and ${outCompact} are up to date`);
    process.exit(0);
}

const rows = fromCsv ? fromTheCsv() : await fromHeasarc();
if (flag("--csv")) {
    // To the nearest, an exact half to even, as the CSV was first written.
    const fixed = (x, digits) => {
        const long = Math.abs(x).toFixed(digits + 60);
        if (!long.endsWith(`5${"0".repeat(59)}`)) return x.toFixed(digits);
        const down = long.slice(0, long.length - 60);
        const odd = Number(down.at(-1)) % 2 === 1;
        return (Math.sign(x) * (Number(down) + (odd ? 10 ** -digits : 0))).toFixed(digits);
    };
    const text = rows.map(([v, ra, de, bv]) => [fixed(v, 2), fixed(ra, 6), fixed(de, 6), fixed(bv, 2)].join(","));
    writeFileSync(csvPath, `vmag,ra,de,bv\n${text.join("\n")}\n`);
    console.log(`Wrote ${rows.length.toLocaleString()} stars to ${csvPath}`);
}

// Full: brightest first, two words a star. Compact: in the deep stars' cells, 6 bytes a star, as `packCells` sorts them.
const values = new Uint32Array(rows.length * 2);
rows.forEach(([vmag, ra, de, bv], i) => {
    values.set(fullWords(ra, de, Math.min(Math.max(Math.round((vmag + 2) / 0.0625), 0), 255), bv), i * 2);
});
const size = writePlanes(outPath, new Uint8Array(values.buffer), 8);
const cells = packCells(
    rows.map(([vmag, ra, de, bv]) => ({ vmag, ra, de, bv })),
    true,
);
const compactSize = writePlanes(outCompact, cells.bytes, cells.stride);
console.log(
    `Wrote ${rows.length.toLocaleString()} stars (${megabytes(values.byteLength)}, ${megabytes(size)} packed) to ${outPath}, ` +
        `and in ${cells.blocks.toLocaleString()} blocks (${megabytes(cells.bytes.length)}, ${megabytes(compactSize)} packed) to ${outCompact}`,
);

function fromTheCsv() {
    const [header, ...lines] = readFileSync(csvPath, "utf8").trim().split("\n");
    if (header !== "vmag,ra,de,bv") throw new Error(`Unexpected columns: ${header}`);
    return lines.map((line, i) => {
        const row = line.split(",").map(Number);
        if (row.length !== 4 || row.some(Number.isNaN)) throw new Error(`Row ${i} did not parse: "${line}"`);
        return row;
    });
}

async function fromHeasarc() {
    const source = download(HEASARC, join(cache, "hipparcos"), "heasarc_hipparcos.tdat.gz", "15 MB");
    // The bright star catalog's stars, in cells of a twentieth of a degree, to find the entries it holds already.
    const cellOf = (ra, de) => `${Math.floor(de * 20)} ${Math.floor(ra * 20)}`;
    const bright = new Map();
    for (const line of readFileSync(join(DATA, "brightstars.csv"), "utf8").trim().split("\n").slice(1)) {
        const [vmag, hours, de] = line.split(",").map(Number);
        const key = cellOf(hours * 15, de);
        if (!bright.has(key)) bright.set(key, []);
        bright.get(key).push([hours * 15, de, vmag]);
    }
    const isBright = (ra, de, vmag) => {
        const cos = Math.max(Math.cos((de * Math.PI) / 180), 0.01);
        for (let d = Math.floor((de - NEAR) * 20); d <= Math.floor((de + NEAR) * 20); d++)
            for (let r = Math.floor((ra - NEAR / cos) * 20); r <= Math.floor((ra + NEAR / cos) * 20); r++)
                for (const [bra, bde, bmag] of bright.get(`${d} ${(r + 7200) % 7200}`) ?? []) {
                    const apart = Math.hypot((((bra - ra + 540) % 360) - 180) * cos, bde - de);
                    if (apart < SAME || (apart < NEAR && Math.abs(bmag - vmag) < NEAR_MAGNITUDES)) return true;
                }
        return false;
    };
    const lines = createInterface({ input: createReadStream(source).pipe(createGunzip()), crlfDelay: Infinity });
    let columns = null;
    let inData = false;
    const rows = [];
    for await (const line of lines) {
        if (!inData) {
            if (line.startsWith("line[1] = ")) columns = line.slice(10).trim().split(/\s+/);
            inData = line === "<DATA>";
            continue;
        }
        if (line.startsWith("<END>")) break;
        const fields = line.split("|");
        const number = (name) => {
            const text = fields[columns.indexOf(name)];
            return text === "" || text === undefined ? Number.NaN : Number(text);
        };
        const [ra0, de0, vmag] = [number("ra"), number("dec"), number("vmag")];
        if ([ra0, de0, vmag, number("ra_deg")].some(Number.isNaN)) continue;
        const [pmRa, pmDe] = [number("pm_ra") || 0, number("pm_dec") || 0];
        const de = de0 + (pmDe * YEARS) / 3.6e6;
        const ra = (ra0 + (pmRa * YEARS) / 3.6e6 / Math.max(Math.cos((de0 * Math.PI) / 180), 1e-6) + 360) % 360;
        if (isBright(ra, de, vmag)) continue;
        const bv = number("bv_color");
        rows.push([vmag, ra, de, Number.isNaN(bv) ? TYPICAL_BV : bv]);
    }
    if (!columns || rows.length === 0) throw new Error("No stars found: has the table's format changed?");
    return rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
