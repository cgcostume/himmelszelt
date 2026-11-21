// Bins the stars the stars chapter draws by their color index B-V for its histogram of the stars' colors, one JSON per
// pick of the catalog, each holding the ones before it as the figures draw them: the Yale Bright Star Catalogue, then
// the Hipparcos stars it lacks, then the Tycho-2 stars neither holds. Per bin of 0.05 and class of magnitude the stars
// and their share of the light, per bin its brightest five, the median, and the magnitude and B-V of the film stars.
// The Yale stars from sternenheer's brightstars.csv; the others from the catalogues as NASA's HEASARC serves them, in
// the cache sternenheer's `pnpm data:hipparcos` and `pnpm data:tycho` download them to, cut as those scripts cut them. A star
// without a measured index is left out, where the renderer gives it the typical one; Tycho-2's two bands become
// Johnson's V and B-V by the conversion of the Hipparcos and Tycho Catalogues (ESA 1997, vol. 1, sect. 1.3).
//
//     pnpm --filter @himmelszelt/sternwarte data:star-colors [--force]
//
// Writes public/stars/colors-yale.json, colors-hipparcos.json and colors-tycho.json, some 9 kB each. The ESA data come
// under CC BY-NC 3.0 IGO, credit "ESA". Downloads 215 MB once, from the asset mirror first.
import { execFileSync } from "node:child_process";
import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { download, notice, upToDate } from "../../packages/sternenheer/scripts/common.mjs";
import { FILM_STARS } from "../src/components/sternenheer/filmstars.ts";

const SITE = fileURLToPath(new URL("../", import.meta.url));
const DATA = fileURLToPath(new URL("../../packages/sternenheer/data/", import.meta.url));
const CACHE = fileURLToPath(new URL("../../packages/sternenheer/node_modules/.cache/sternenheer/", import.meta.url));
const HEASARC = "https://heasarc.gsfc.nasa.gov/FTP/heasarc/dbase/tdat_files";
const OUT = (catalog) => join(SITE, `public/stars/colors-${catalog}.json`);
const CATALOGS = ["yale", "hipparcos", "tycho"];

// The bins: from -0.4, 0.05 wide, the last holding every redder star too; the magnitudes the bars are split at.
const BINS = { start: -0.4, width: 0.05, count: 49 };
const SPLITS = [2, 4, 6];
const LISTED = 5;
// As sternenheer's hipparcos.mjs: a Hipparcos entry is a Yale star within half an arcminute of one, or within 1.5
// arcminutes and 0.3 magnitudes; its position moved by its proper motion from J1991.25 to J2000.0 first.
const SAME = 0.5 / 60;
const NEAR = 1.5 / 60;
const NEAR_MAGNITUDES = 0.3;
const YEARS = 2000 - 1991.25;
// As sternenheer's tycho.mjs: a Tycho-2 entry is drawn already where it has a Hipparcos number or stands within 5
// arcseconds of a Yale or Hipparcos star.
const SAME_STAR = 5 / 3600;
// The Yale catalog's HR numbers brightstars.csv leaves out, the 14 entries for novae, clusters and galaxies and three
// more, found by matching its rows in order to BSC5 as the Harvard CfA serves it.
const MISSING_HR = [92, 95, 182, 423, 1057, 1607, 1841, 2472, 2496, 3515, 3671, 6309, 6515, 7189, 7220, 7539, 8296];

const inputs = [fileURLToPath(import.meta.url), join(DATA, "brightstars.csv"), join(DATA, "hipparcos.csv")];
inputs.push(fileURLToPath(new URL("../src/components/sternenheer/filmstars.ts", import.meta.url)));
if (CATALOGS.every((c) => upToDate(OUT(c), inputs, process.argv.includes("--force")))) {
    console.log("The star colors are up to date");
    process.exit(0);
}
notice("hipparcos");
notice("tycho");

const hrOfRow = (row) => MISSING_HR.reduce((hr, missing) => (missing <= hr ? hr + 1 : hr), row + 1);
const binOf = (bv) => Math.max(0, Math.min(BINS.count - 1, Math.floor((bv - BINS.start) / BINS.width + 1e-6)));
const round = (value, digits) => Number(value.toFixed(digits));

/** A histogram over B-V by class of magnitude, its median from bins of a thousandth, its brightest stars per bin. */
function histogram() {
    const count = Array.from({ length: BINS.count }, () => SPLITS.map(() => 0).concat(0));
    const light = count.map((classes) => classes.map(() => 0));
    const top = count.map(() => []);
    const fine = new Map();
    let [total, flux, below, sunlike] = [0, 0, 0, 0];
    return {
        add(name, vmag, bv) {
            const [bin, cls] = [binOf(bv), SPLITS.filter((split) => vmag >= split).length];
            const f = 10 ** (-0.4 * vmag);
            count[bin][cls]++;
            light[bin][cls] += f;
            [total, flux] = [total + 1, flux + f];
            if (bv < BINS.start) below++;
            if (bv >= 0.6 && bv < 0.8) sunlike++;
            const key = Math.round(bv * 1000);
            fine.set(key, (fine.get(key) ?? 0) + 1);
            const list = top[bin];
            if (list.length < LISTED || vmag < list[list.length - 1][1]) {
                list.push([name, round(vmag, 2)]);
                list.sort((a, b) => a[1] - b[1]);
                list.length = Math.min(list.length, LISTED);
            }
        },
        result(skipped) {
            let [seen, median] = [0, 0];
            for (const key of [...fine.keys()].sort((a, b) => a - b)) {
                seen += fine.get(key);
                if (seen >= total / 2) {
                    median = key / 1000;
                    break;
                }
            }
            const redder = [...fine].reduce((n, [key, k]) => n + (key > 1400 ? k : 0), 0);
            console.log(
                `${total.toLocaleString()} stars, ${skipped.toLocaleString()} without an index left out, median ${median}, ` +
                    `1 in ${(total / sunlike).toFixed(1)} from 0.6 to 0.8, 1 in ${(total / redder).toFixed(1)} over 1.4, ${below} under ${BINS.start}`,
            );
            const share = (n) => round(n / flux, 6);
            return { total, skipped, median, count, light: light.map((classes) => classes.map(share)), top };
        },
    };
}

// The rows of a HEASARC table, each a function from a column's name to its text.
async function* heasarc(file) {
    const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
    let columns = null;
    let inData = false;
    for await (const line of lines) {
        if (!inData) {
            if (line.startsWith("line[1] = "))
                columns = new Map(
                    line
                        .slice(10)
                        .trim()
                        .split(/\s+/)
                        .map((c, i) => [c, i]),
                );
            inData = line === "<DATA>";
            continue;
        }
        if (line.startsWith("<END>")) break;
        const fields = line.split("|");
        yield (name) => fields[columns.get(name)] ?? "";
    }
}
const numberOf = (text) => (text === "" ? Number.NaN : Number(text));

// Stars by position, in cells of a twentieth of a degree.
function grid() {
    const cells = new Map();
    const key = (d, r) => `${d} ${(r + 7200) % 7200}`;
    return {
        add(ra, de, extra) {
            const k = key(Math.floor(de * 20), Math.floor(ra * 20));
            if (!cells.has(k)) cells.set(k, []);
            cells.get(k).push([ra, de, extra]);
        },
        // Whether a star within `radius` degrees passes `test(apart, extra)`.
        any(ra, de, radius, test) {
            const cos = Math.max(Math.cos((de * Math.PI) / 180), 0.01);
            for (let d = Math.floor((de - radius) * 20); d <= Math.floor((de + radius) * 20); d++)
                for (let r = Math.floor((ra - radius / cos) * 20); r <= Math.floor((ra + radius / cos) * 20); r++)
                    for (const [sra, sde, extra] of cells.get(key(d, r)) ?? []) {
                        const apart = Math.hypot((((sra - ra + 540) % 360) - 180) * cos, sde - de);
                        if (test(apart, extra)) return true;
                    }
            return false;
        },
    };
}

const csv = (file) =>
    readFileSync(join(DATA, file), "utf8")
        .trim()
        .split("\n")
        .slice(1)
        .map((row) => row.split(",").map(Number));
const histograms = Object.fromEntries(CATALOGS.map((c) => [c, histogram()]));
const skipped = { yale: 0, hipparcos: 0, tycho: 0 };
const add = (catalogs, name, vmag, bv) => {
    for (const c of catalogs) histograms[c].add(name, vmag, bv);
};

// The Yale stars, every one: the 310 without an index carry their spectral type's typical one.
const yale = grid();
const drawn = grid();
const bright = csv("brightstars.csv");
bright.forEach(([vmag, hours, de, , , bv], row) => {
    add(CATALOGS, `HR ${hrOfRow(row)}`, vmag, bv);
    yale.add(hours * 15, de, vmag);
    drawn.add(hours * 15, de);
});
for (const [, ra, de] of csv("hipparcos.csv")) drawn.add(ra, de);

const hipparcos = download(
    `${HEASARC}/heasarc_hipparcos.tdat.gz`,
    join(CACHE, "hipparcos"),
    "heasarc_hipparcos.tdat.gz",
    "15 MB",
);
for await (const text of heasarc(hipparcos)) {
    const [ra0, de0, vmag] = [numberOf(text("ra")), numberOf(text("dec")), numberOf(text("vmag"))];
    if ([ra0, de0, vmag, numberOf(text("ra_deg"))].some(Number.isNaN)) continue;
    const [pmRa, pmDe] = [numberOf(text("pm_ra")) || 0, numberOf(text("pm_dec")) || 0];
    const de = de0 + (pmDe * YEARS) / 3.6e6;
    const ra = (ra0 + (pmRa * YEARS) / 3.6e6 / Math.max(Math.cos((de0 * Math.PI) / 180), 1e-6) + 360) % 360;
    if (
        yale.any(
            ra,
            de,
            NEAR,
            (apart, ymag) => apart < SAME || (apart < NEAR && Math.abs(ymag - vmag) < NEAR_MAGNITUDES),
        )
    )
        continue;
    const bv = numberOf(text("bv_color"));
    if (Number.isNaN(bv)) for (const c of ["hipparcos", "tycho"]) skipped[c]++;
    else add(["hipparcos", "tycho"], `HIP ${text("hip_number")}`, vmag, bv);
}

const tycho = download(`${HEASARC}/heasarc_tycho2.tdat.gz`, join(CACHE, "tycho2"), "heasarc_tycho2.tdat.gz", "200 MB");
for await (const text of heasarc(tycho)) {
    if (text("hip_number") !== "") continue;
    const mean = text("mean_ra") !== "";
    const [ra, de] = [numberOf(text(mean ? "mean_ra" : "ra")), numberOf(text(mean ? "mean_dec" : "dec"))];
    if (drawn.any(ra, de, SAME_STAR, (apart) => apart < SAME_STAR)) continue;
    const [bt, vt] = [numberOf(text("bt_mag")), numberOf(text("vt_mag"))];
    if (Number.isNaN(bt) || Number.isNaN(vt)) skipped.tycho++;
    else add(["tycho"], text("name"), vt - 0.09 * (bt - vt), 0.85 * (bt - vt));
}

const films = Object.fromEntries(FILM_STARS.map(({ hr, row }) => [hr, [bright[row][0], bright[row][5]]]));
for (const c of CATALOGS) {
    process.stdout.write(`${c}: `);
    const data = { bins: BINS, splits: SPLITS, ...histograms[c].result(skipped[c]), films };
    writeFileSync(OUT(c), JSON.stringify(data));
}
// As the repository's formatter lays them out, so that a rerun changes nothing it would not.
execFileSync("npx", ["biome", "format", "--write", ...CATALOGS.map(OUT)], { stdio: "ignore" });
for (const c of CATALOGS) console.log(`Wrote ${OUT(c)}, ${(statSync(OUT(c)).size / 1000).toFixed(1)} kB`);
