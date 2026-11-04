import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { catalogFromBuffer, catalogFromStars, STAR_FIELDS, starAt } from "../src/catalog.js";

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
    expect(sirius.color[2]).toBeGreaterThan(sirius.color[0]);
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
