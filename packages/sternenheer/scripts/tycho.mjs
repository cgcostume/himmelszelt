#!/usr/bin/env node
// Makes data/tycho.bin.gz and data/tycho-compact.bin.gz from the Tycho-2 catalogue (Høg et al. 2000) as NASA's HEASARC
// serves it: the stars the bright star catalog and the Hipparcos stars do not hold, some 2.4 million to magnitude 12 or
// so, sorted for a renderer by `packCells` in `common.mjs`: by the cell of the sky they stand in, a face of a cube cut 8
// by 8, and brightest first within it, each cell filled up to whole blocks of 64 with empty stars, so a pass over the
// blocks of the cells in view, as deep as the exposure asks, reads nothing else. The full file packs a star into two
// little-endian Uint32 as `packStars` in `src/catalog.ts` lays them out, 8 bytes; the compact one into 6, its place in
// its cell to 0.4 arcseconds. A header names the cells: `deepStarsFromBuffer` reads it. Written as byte planes, gzip
// compressed, as `loadDeepStars` reads them. ESA's terms, CC BY-NC 3.0 IGO, keep the file out of the MIT package: each
// user makes it, here or by `npx @himmelszelt/sternenheer data tycho`, after `data hipparcos`, whose stars it leaves
// out. Rerunnable: `pnpm data:tycho [--limit <magnitude>] [--out <dir>] [--cache <dir>] [--force]`. Downloads 200 MB once
// into the cache. No CSV is kept: the catalogue is the source of truth, and 60 MB of it are too much for the repository.
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createGunzip, gunzipSync } from "node:zlib";
import {
    CELLS,
    DATA,
    download,
    megabytes,
    notice,
    options,
    PLANES_MAGIC,
    packCells,
    upToDate,
    writePlanes,
} from "./common.mjs";

const HEASARC = "https://heasarc.gsfc.nasa.gov/FTP/heasarc/dbase/tdat_files/heasarc_tycho2.tdat.gz";
// A star of the catalogue is one the package draws already where it has a Hipparcos number, or stands this close to
// one of the stars drawn, in degrees: 5 arcseconds.
const SAME_STAR = 5 / 3600;
// The color index of a star measured in one band only, the typical star's, as for the Hipparcos stars.
const TYPICAL_BV = 0.65;
// As `scripts/milkyway.mjs`: the band the Milky Way's map is calibrated over, and a star of magnitude 0 in lux.
const BAND = [35, 45];
const MAGNITUDE_ZERO_LUX = 128_000 * 10 ** (0.4 * -26.74);
const RAD = Math.PI / 180;

const { out: outDir, cache, force, option } = options();
const limit = Number(option("--limit", "99"));
const out = join(outDir, "tycho.bin.gz");
const outCompact = join(outDir, "tycho-compact.bin.gz");
notice("tycho");
const hipparcosCsv = join(DATA, "hipparcos.csv");
const hipparcosBin = join(outDir, "hipparcos.bin.gz");
const inputs = [
    hipparcosCsv,
    hipparcosBin,
    join(DATA, "brightstars.csv"),
    fileURLToPath(import.meta.url),
    fileURLToPath(new URL("common.mjs", import.meta.url)),
];
if (upToDate(out, inputs, force) && upToDate(outCompact, inputs, force)) {
    console.log(`${out} and ${outCompact} are up to date`);
    process.exit(0);
}
const source = download(HEASARC, join(cache, "tycho2"), "heasarc_tycho2.tdat.gz", "200 MB");

// The stars the package draws already, in a grid of a twentieth of a degree by declination and right ascension.
const cellOf = (ra, de) => `${Math.floor(de * 20)} ${Math.floor(ra * 20)}`;
const drawn = new Map();
function draw(ra, de) {
    const key = cellOf(ra, de);
    if (!drawn.has(key)) drawn.set(key, []);
    drawn.get(key).push(ra, de);
}
const csv = (path) =>
    readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .slice(1)
        .map((row) => row.split(",").map(Number));
const bright = csv(join(DATA, "brightstars.csv"));
const faint = existsSync(hipparcosCsv) ? csv(hipparcosCsv) : hipparcosStars();

/** The Hipparcos stars as `scripts/hipparcos.mjs` packed them, where no CSV is at hand: magnitude, degrees, B-V. */
function hipparcosStars() {
    if (!existsSync(hipparcosBin)) throw new Error(`${hipparcosBin} is missing: make the Hipparcos stars first`);
    const planes = gunzipSync(readFileSync(hipparcosBin));
    const view = new DataView(planes.buffer, planes.byteOffset, planes.byteLength);
    if (view.getUint32(0, true) !== PLANES_MAGIC || view.getUint32(4, true) !== 8) throw new Error("not packed stars");
    const count = (planes.length - 8) / 8;
    const byte = (star, k) => planes[8 + k * count + star];
    const word = (star, w) => (byte(star, w * 4) | (byte(star, w * 4 + 1) << 8) | (byte(star, w * 4 + 2) << 16)) >>> 0;
    return Array.from({ length: count }, (_, i) => [
        byte(i, 3) * 0.0625 - 2,
        (word(i, 0) / 2 ** 24) * 360,
        (word(i, 1) / (2 ** 24 - 1)) * 180 - 90,
        byte(i, 7) * 0.01 - 0.5,
    ]);
}
for (const [, ra, de] of bright) draw(ra * 15, de);
for (const [, ra, de] of faint) draw(ra, de);
function isDrawn(ra, de) {
    const reach = SAME_STAR / Math.max(Math.cos((de * Math.PI) / 180), 0.01);
    for (let d = de - SAME_STAR; d <= de + SAME_STAR + 1e-9; d += SAME_STAR)
        for (let r = ra - reach; r <= ra + reach + 1e-9; r += reach) {
            const stars = drawn.get(cellOf((r + 360) % 360, d));
            if (!stars) continue;
            for (let i = 0; i < stars.length; i += 2) {
                const dRa = (((stars[i] - ra + 540) % 360) - 180) * Math.cos((de * Math.PI) / 180);
                if (Math.hypot(dRa, stars[i + 1] - de) < SAME_STAR) return true;
            }
        }
    return false;
}

// The table: its columns by the names its header gives them.
const lines = createInterface({ input: createReadStream(source).pipe(createGunzip()), crlfDelay: Infinity });
let columns = null;
let inData = false;
const stars = [];
const counts = { rows: 0, hipparcos: 0, same: 0, fainter: 0 };
for await (const line of lines) {
    if (!inData) {
        if (line.startsWith("line[1] = ")) columns = line.slice(10).trim().split(/\s+/);
        inData = line === "<DATA>";
        continue;
    }
    if (line.startsWith("<END>")) break;
    const fields = line.split("|");
    const text = (name) => fields[columns.indexOf(name)];
    const number = (name) => (text(name) === "" ? Number.NaN : Number(text(name)));
    counts.rows++;
    if (text("hip_number") !== "") {
        counts.hipparcos++;
        continue;
    }
    // The mean position at J2000.0 where the catalogue has one, else the one observed around 1991.5.
    const mean = text("mean_ra") !== "";
    const ra = number(mean ? "mean_ra" : "ra");
    const de = number(mean ? "mean_dec" : "dec");
    const bt = number("bt_mag");
    const vt = number("vt_mag");
    // Johnson's V and B-V from Tycho's two bands, as the catalogue's guide gives them.
    const btVt = Number.isNaN(bt) || Number.isNaN(vt) ? TYPICAL_BV / 0.85 : bt - vt;
    const vmag = (Number.isNaN(vt) ? bt - btVt : vt) - 0.09 * btVt;
    if ([ra, de, vmag].some(Number.isNaN)) throw new Error(`Row ${counts.rows} did not parse: "${line}"`);
    if (vmag > limit) {
        counts.fainter++;
        continue;
    }
    if (isDrawn(ra, de)) {
        counts.same++;
        continue;
    }
    stars.push({ vmag, ra, de, bv: 0.85 * btVt });
}
if (!columns || stars.length === 0) throw new Error("No stars found: has the table's format changed?");

// Both layouts, `packCells`: the full one as the Hipparcos stars' words, the compact one by the place in the cell.
const mb = megabytes;
const written = [false, true].map((compact) => {
    const { bytes, stride, blocks, count } = packCells(stars, compact);
    const path = compact ? outCompact : out;
    const size = writePlanes(path, bytes, stride);
    console.log(
        `Wrote ${count.toLocaleString()} stars in ${blocks.toLocaleString()} blocks of ${CELLS} cells, ${mb(bytes.length)}, ${mb(size)} packed, to ${path}`,
    );
    return size;
});
console.log(
    `${counts.rows.toLocaleString()} stars in the catalogue: ${counts.hipparcos.toLocaleString()} are Hipparcos stars, ` +
        `${counts.same.toLocaleString()} more stand where a star is drawn already, ${counts.fainter.toLocaleString()} are fainter than ${limit}; ` +
        `compact ${((100 * written[1]) / written[0]).toFixed(0)}% of full`,
);

// What the stars add to the light the Milky Way's map was calibrated with, over the band of its calibration.
const inBand = (de) => de >= BAND[0] && de <= BAND[1];
const lux = (vmag) => MAGNITUDE_ZERO_LUX * 10 ** (-0.4 * vmag);
const bandSolidAngle = 2 * Math.PI * (Math.sin(BAND[1] * RAD) - Math.sin(BAND[0] * RAD));
const bandMean = (rows) => rows.reduce((sum, [vmag, , de]) => sum + (inBand(de) ? lux(vmag) : 0), 0) / bandSolidAngle;
const calibration = JSON.parse(readFileSync(new URL("../data/milkyway.json", import.meta.url), "utf8"));
const starlight = (MAGNITUDE_ZERO_LUX * 10 ** (-0.4 * calibration.magnitudesPerArcsecond)) / (RAD / 3600) ** 2;
const [brightMean, faintMean] = [bandMean(bright), bandMean(faint)];
const map = starlight - brightMean - faintMean;
console.log(
    `over declination ${BAND[0]}° to ${BAND[1]}° the integrated starlight is ${starlight.toExponential(3)} cd/m²: ` +
        `the catalog gives ${brightMean.toExponential(3)}, Hipparcos ${faintMean.toExponential(3)}, which leaves the map ${map.toExponential(3)}`,
);
console.log("to magnitude   stars       cd/m² over the band   of the starlight   of the map's light");
for (const to of [8, 9, 10, 10.5, 11, 11.5, 12, 99]) {
    const upTo = stars.filter(({ vmag }) => vmag <= to);
    const mean = bandMean(upTo.map(({ vmag, de }) => [vmag, 0, de]));
    console.log(
        `${(to === 99 ? "all" : to.toFixed(1)).padStart(12)}   ${upTo.length.toLocaleString().padStart(9)}   ${mean.toExponential(3).padStart(19)}   ` +
            `${((100 * mean) / starlight).toFixed(1).padStart(15)}%   ${((100 * mean) / map).toFixed(1).padStart(17)}%`,
    );
}
