import { expect, test } from "@playwright/test";
import * as approx from "../src/approx.js";
import * as precise from "../src/index.js";

// Meeus, "Astronomical Algorithms", example 21.b: θ Persei on 2028 November 13.19 TD.
const THETA_PERSEI: precise.CatalogStar = {
    rightAscension: (2 + 44 / 60 + 11.986 / 3600) * 15,
    declination: 49 + 13 / 60 + 42.48 / 3600,
    // 0.03425 s of right ascension a year, on the sky times cos δ.
    properMotionRightAscension: 0.03425 * 15 * Math.cos((49.2285 * Math.PI) / 180),
    properMotionDeclination: -0.0895,
};
const JDE = 2462088.69;

test("stars.properMotion matches Meeus' worked example 21.b", () => {
    const moved = precise.stars.properMotion(THETA_PERSEI, JDE);
    expect(moved.rightAscension).toBeCloseTo(41.054063, 4);
    expect(moved.declination).toBeCloseTo(49.22775, 4);
});

test("stars.apparentPosition matches Meeus' worked example 21.b", () => {
    const position = precise.stars.apparentPosition(THETA_PERSEI, JDE);
    expect(position.rightAscension).toBeCloseTo(41.547214, 4);
    expect(position.declination).toBeCloseTo(49.348483, 4);
});

test("stars.precessionAngles match Meeus' worked example 21.b", () => {
    const { zeta, z, theta } = precise.stars.precessionAngles(JDE);
    expect(zeta).toBeCloseTo(0.1849341, 6);
    expect(z).toBeCloseTo(0.1849524, 6);
    expect(theta).toBeCloseTo(0.160708, 6);
});

test("the approximate precession stays within an arcsecond of Meeus' over this century", () => {
    for (const jde of [2451545, 2460000, 2470000, 2488070]) {
        const a = precise.stars.apparentPosition(THETA_PERSEI, jde);
        const b = approx.stars.apparentPosition(THETA_PERSEI, jde);
        expect(
            precise.angularSeparation(a.rightAscension, a.declination, b.rightAscension, b.declination),
        ).toBeLessThan(1 / 3600);
    }
});

test("stars.equatorialToHorizontalMatrix agrees with equatorialToHorizontal", () => {
    const observer = { latitude: 52.52, longitude: 13.405 };
    const siderealTime = 123.456;
    const m = precise.stars.equatorialToHorizontalMatrix(siderealTime, observer);
    for (const equ of [
        { rightAscension: 10, declination: 20 },
        { rightAscension: 200, declination: -40 },
        { rightAscension: 350, declination: 89 },
    ]) {
        const direction = precise.stars.applyMatrix3(m, precise.stars.equatorialToVector(equ));
        const expected = precise.horizontalToDirection(precise.equatorialToHorizontal(equ, siderealTime, observer));
        for (let i = 0; i < 3; i++) expect(direction[i]).toBeCloseTo(expected[i] ?? 0, 6);
    }
});

test("stars.horizontalMatrix puts a star where stars.horizontalPosition does", () => {
    const time = precise.fromDate(new Date(Date.UTC(2026, 10, 4, 22)));
    const observer = { latitude: 52.52, longitude: 13.405 };
    const sirius: precise.CatalogStar = {
        rightAscension: 6.752472 * 15,
        declination: -16.71611,
        properMotionRightAscension: -0.553,
        properMotionDeclination: -1.205,
    };
    const m = precise.stars.horizontalMatrix(time, observer);
    const t = precise.julianEphemerisDay(time);
    const moved = precise.stars.properMotion(sirius, t);
    const direction = precise.stars.applyMatrix3(m, precise.stars.equatorialToVector(moved));
    const expected = precise.horizontalToDirection(precise.stars.horizontalPosition(sirius, time, observer));
    for (let i = 0; i < 3; i++) expect(direction[i]).toBeCloseTo(expected[i] ?? 0, 6);
    // Sirius rises in the east-southeast in the late evening of November in Berlin.
    const horizontal = precise.stars.horizontalPosition(sirius, time, observer);
    expect(horizontal.azimuth).toBeGreaterThan(100);
    expect(horizontal.azimuth).toBeLessThan(130);
});
