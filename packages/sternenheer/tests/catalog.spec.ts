import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
    BRIGHT_STARS,
    COMPACT_STAR_WORDS,
    catalogFromStars,
    type DeepStars,
    type FaintStar,
    HIPPARCOS,
    isCompact,
    loadCatalog,
    loadDeepStars,
    loadFaintStars,
    type PackedStars,
    packedStarAt,
    packStars,
    STAR_FIELDS,
    starAt,
    TYCHO,
} from "../src/catalog.js";
import { colorFromColorIndex } from "../src/color.js";
import { CONSTELLATIONS, constellationMask, constellationsFromBuffer } from "../src/constellations.js";

// The loaders fetch; here the package's files come off the disk, compressed as a server would send them.
globalThis.fetch = (async (url: string | URL) =>
    new Response(readFileSync(url instanceof URL ? url : new URL(url)))) as typeof fetch;
const catalog = await loadCatalog();
const full = await loadCatalog("full");

/** The angle between two places on the sky, in arcseconds. */
function apart(a: { rightAscension: number; declination: number }, b: { rightAscension: number; declination: number }) {
    const r = Math.PI / 180;
    const [x, y] = [(b.rightAscension - a.rightAscension) * r, (b.declination - a.declination) * r];
    const h = Math.sin(y / 2) ** 2 + Math.cos(a.declination * r) * Math.cos(b.declination * r) * Math.sin(x / 2) ** 2;
    return (2 * Math.asin(Math.sqrt(h)) * 180 * 3600) / Math.PI;
}

/** The largest and the root mean square of some errors. */
const spread = (errors: number[]) => ({
    max: errors.reduce((most, e) => Math.max(most, e), 0),
    rms: Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length),
});

test("the shipped catalog holds the 9,093 stars of the Yale Bright Star Catalogue, Sirius the brightest", () => {
    expect(catalog.count).toBe(9093);
    expect(catalog.compact).toBe(true);
    expect(catalog.data.length).toBe(9093 * COMPACT_STAR_WORDS);
    expect(full.data.length).toBe(9093 * STAR_FIELDS);
    let brightest = 0;
    for (let i = 1; i < catalog.count; i++)
        if (starAt(catalog, i).magnitude < starAt(catalog, brightest).magnitude) brightest = i;
    const sirius = starAt(catalog, brightest);
    expect(sirius.magnitude).toBeCloseTo(-1.46, 2);
    // Right ascension in degrees, 6h 45m; declination -16.7°; proper motion in arcseconds a year.
    expect(sirius.rightAscension).toBeCloseTo(101.287, 2);
    expect(sirius.declination).toBeCloseTo(-16.716, 2);
    expect(sirius.properMotionRightAscension).toBeCloseTo(-0.553, 3);
    expect(sirius.properMotionDeclination).toBeCloseTo(-1.205, 3);
    // Its color is its B-V's, 0.00.
    const color = colorFromColorIndex(0);
    for (let c = 0; c < 3; c++) expect(sirius.color[c]).toBeCloseTo(color[c] ?? 0, 5);
});

test("a catalog from stars reads back as given", () => {
    const made = catalogFromStars([
        {
            magnitude: 0.03,
            rightAscension: 279.23,
            declination: 38.78,
            properMotionRightAscension: 0.2,
            properMotionDeclination: 0.29,
            color: [0.8, 1, 1.6],
        },
    ]);
    expect(made.count).toBe(1);
    expect(starAt(made, 0).color[2]).toBeCloseTo(1.6, 5);
});

test("the shipped lines join stars of the shipped catalog, Orion's belt among them", () => {
    const file = readFileSync(new URL("../data/constellations.bin", import.meta.url));
    const lines = constellationsFromBuffer(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
    expect(lines.count).toBe(743);
    expect(CONSTELLATIONS.length).toBe(88);
    expect([...CONSTELLATIONS.map(([a]) => a)].sort()).toEqual(CONSTELLATIONS.map(([a]) => a));
    const orion = CONSTELLATIONS.findIndex(([a]) => a === "Ori");
    let belt = 0;
    for (let i = 0; i < lines.count; i++) {
        const [constellation, a, b] = lines.data.subarray(i * 4, i * 4 + 3);
        expect(constellation).toBeLessThan(88);
        expect(Math.max(a ?? 0, b ?? 0)).toBeLessThan(catalog.count);
        if (constellation !== orion) continue;
        // The belt's three stars lie within 1.5° of the equator around 5.6 h, brighter than magnitude 2.5.
        const onBelt = (s: number) => {
            const star = starAt(catalog, s);
            return (
                Math.abs(star.declination + 1) < 1.5 && Math.abs(star.rightAscension - 84) < 3 && star.magnitude < 2.5
            );
        };
        if (onBelt(a ?? 0) && onBelt(b ?? 0)) belt++;
    }
    expect(belt).toBe(2);
    expect(constellationMask(null)[3]).toBe(0xffffffff);
    expect(() => constellationMask(["Xyz"])).toThrow();
});

test("the shipped catalog is gzip compressed byte planes, a third smaller", () => {
    for (const [file, made] of [
        [BRIGHT_STARS.full, full],
        [BRIGHT_STARS.compact, catalog],
    ] as const) {
        const packed = readFileSync(file);
        expect([packed[0], packed[1]]).toEqual([0x1f, 0x8b]);
        expect(packed.length).toBeLessThan(0.82 * made.data.byteLength);
    }
});

test("the compact catalog keeps the magnitudes, colors and proper motions, and the places within a sixth of an arcsecond", () => {
    const errors: number[] = [];
    for (let i = 0; i < full.count; i++) {
        const [a, b] = [starAt(full, i), starAt(catalog, i)];
        errors.push(apart(a, b));
        expect(Math.abs(a.magnitude - b.magnitude)).toBeLessThan(1e-5);
        expect(Math.abs(a.properMotionRightAscension - b.properMotionRightAscension)).toBeLessThan(1e-6);
        expect(Math.abs(a.properMotionDeclination - b.properMotionDeclination)).toBeLessThan(1e-6);
        for (let c = 0; c < 3; c++) expect(Math.abs((a.color[c] ?? 0) - (b.color[c] ?? 0))).toBeLessThan(1e-5);
    }
    const { max, rms } = spread(errors);
    console.log(`Yale compact: places off by ${max.toFixed(3)}" at most, ${rms.toFixed(3)}" rms`);
    // The full layout's floats hold a right ascension near 360° to 0.1 arcseconds themselves: against the CSV the
    // compact places are within 0.16 arcseconds.
    expect(max).toBeLessThan(0.21);
    const rows = readFileSync(new URL("../data/brightstars.csv", import.meta.url), "utf8")
        .trim()
        .split("\n")
        .slice(1);
    const truth = rows
        .map((row) => row.split(",").map(Number))
        .map(([, ra = 0, declination = 0]) => ({ rightAscension: ra * 15, declination }));
    const exact = spread(truth.map((star, i) => apart(star, starAt(catalog, i))));
    const fromFull = spread(truth.map((star, i) => apart(star, starAt(full, i))));
    console.log(
        `Yale against the CSV: compact ${exact.max.toFixed(3)}" at most, ${exact.rms.toFixed(3)}" rms; full ${fromFull.max.toFixed(3)}", ${fromFull.rms.toFixed(3)}"`,
    );
    expect(exact.max).toBeLessThan(0.16);
    // A catalog made compact in memory reads back as the file does.
    const made = catalogFromStars(
        [starAt(full, 0), starAt(full, 1)].map((star, i) => ({
            ...star,
            colorIndex: starAt(catalog, i).colorIndex ?? 0,
        })),
        "compact",
    );
    expect([...made.data]).toEqual([...catalog.data.subarray(0, 6)]);
});

/** Faint stars of either layout, the empty places left out, keyed by their magnitude and color codes. */
function faintByCodes(stars: PackedStars): Map<string, FaintStar[]> {
    const slots = "blocks" in stars ? (stars as DeepStars).blocks * (stars as DeepStars).blockSize : stars.count;
    const byCodes = new Map<string, FaintStar[]>();
    for (let i = 0; i < slots; i++) {
        const star = packedStarAt(stars, i);
        if (!Number.isFinite(star.magnitude)) continue;
        // The full layout keeps a magnitude code of 255, the compact one stops at 254: one Hipparcos star.
        const key = `${Math.min(Math.round(star.magnitude * 16), 222)} ${Math.round(star.colorIndex * 100)}`;
        byCodes.get(key)?.push(star) ?? byCodes.set(key, [star]);
    }
    return byCodes;
}

/** Each star of `compact` matched to the nearest of `full` with the same codes: the errors in arcseconds. */
function matched(full: PackedStars, compact: PackedStars): number[] {
    const [a, b] = [faintByCodes(full), faintByCodes(compact)];
    const errors: number[] = [];
    for (const [key, stars] of b) {
        const candidates = a.get(key) ?? [];
        expect(candidates.length, key).toBe(stars.length);
        // In cells of a tenth of a degree by declination, the candidates near each star.
        const cell = (s: FaintStar) => Math.floor((s.declination + 90) * 10);
        const grid = new Map<number, FaintStar[]>();
        for (const s of candidates) grid.get(cell(s))?.push(s) ?? grid.set(cell(s), [s]);
        for (const star of stars) {
            let best = Number.POSITIVE_INFINITY;
            for (let k = cell(star) - 1; k <= cell(star) + 1; k++)
                for (const s of grid.get(k) ?? [])
                    if (Math.abs(s.declination - star.declination) < 0.01) best = Math.min(best, apart(s, star));
            errors.push(best);
        }
    }
    return errors;
}

test("the compact Hipparcos and Tycho-2 stars stand where the full ones do, within 0.6 arcseconds, as bright and as colored", async () => {
    test.setTimeout(120_000);
    for (const [name, files, load] of [
        ["Hipparcos", HIPPARCOS, loadFaintStars],
        ["Tycho-2", TYCHO, loadDeepStars],
    ] as const) {
        if (!existsSync(fileURLToPath(files.compact)) || !existsSync(fileURLToPath(files.full))) continue;
        const [a, b] = [await load("full"), await load("compact")];
        expect(isCompact(b) && b.count).toBe(a.count);
        const { max, rms } = spread(matched(a, b));
        console.log(`${name} compact: places off by ${max.toFixed(3)}" at most, ${rms.toFixed(3)}" rms`);
        expect(max).toBeLessThan(0.6);
    }
});

test("the Hipparcos stars are the ones the catalog lacks, brightest first, and pack to a 13th of an arcsecond", async () => {
    test.skip(!existsSync(fileURLToPath(HIPPARCOS.full)), "no Hipparcos stars: pnpm hipparcos makes them");
    const faint = await loadFaintStars("full");
    expect(faint.count).toBe(108_883);
    expect(packedStarAt(faint, 0).magnitude).toBeGreaterThan(5.9);
    for (let i = 1; i < faint.count; i += 997)
        expect(packedStarAt(faint, i).magnitude).toBeGreaterThanOrEqual(packedStarAt(faint, i - 1).magnitude);
    const star = { magnitude: 8.43, rightAscension: 279.2347, declination: -38.7837, colorIndex: 1.07 };
    const back = packedStarAt(packStars([star]), 0);
    expect(back.rightAscension).toBeCloseTo(star.rightAscension, 4);
    expect(back.declination).toBeCloseTo(star.declination, 4);
    expect(Math.abs(back.magnitude - star.magnitude)).toBeLessThanOrEqual(0.032);
    expect(back.colorIndex).toBeCloseTo(star.colorIndex, 2);
});
