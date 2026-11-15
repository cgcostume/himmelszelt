import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
    catalogFromBuffer,
    catalogFromStars,
    packedStarAt,
    packedStarsFromBuffer,
    packStars,
    STAR_FIELDS,
    starAt,
} from "../src/catalog.js";
import { colorFromColorIndex } from "../src/color.js";
import { CONSTELLATIONS, constellationMask, constellationsFromBuffer } from "../src/constellations.js";

const bytes = readFileSync(new URL("../data/brightstars.bin", import.meta.url));
const catalog = catalogFromBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

test("the shipped catalog holds the 9,093 stars of the Yale Bright Star Catalogue, Sirius the brightest", () => {
    expect(catalog.count).toBe(9093);
    expect(catalog.data.length).toBe(9093 * STAR_FIELDS);
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

test("the shipped Hipparcos stars are the ones the catalog lacks, brightest first, and pack to a 13th of an arcsecond", () => {
    const file = readFileSync(new URL("../data/hipparcos.bin", import.meta.url));
    const faint = packedStarsFromBuffer(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
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
