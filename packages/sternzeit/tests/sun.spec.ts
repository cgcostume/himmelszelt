import { expect, test } from "@playwright/test";
import * as approx from "../src/approx.js";
import * as precise from "../src/index.js";

// Meeus, "Astronomical Algorithms", example 25.a (1992-10-13.0 TD, JDE 2448908.5).
const JDE = 2448908.5;

test("sun.meanAnomaly matches Meeus' worked example 25.a", () => {
    expect(precise.sun.meanAnomaly(JDE)).toBeCloseTo(278.99397, 3);
});

test("sun.meanLongitude matches Meeus' worked example 25.a", () => {
    expect(precise.sun.meanLongitude(JDE)).toBeCloseTo(201.8072, 3);
});

test("sun.trueLongitude matches Meeus' worked example 25.a", () => {
    expect(precise.sun.trueLongitude(JDE)).toBeCloseTo(199.90987, 3);
});

test("sun.trueAnomaly matches Meeus' worked example 25.a", () => {
    expect(precise.sun.trueAnomaly(JDE)).toBeCloseTo(277.09664, 3);
});

test("earth.orbitEccentricity matches Meeus' worked example 25.a", () => {
    expect(precise.earth.orbitEccentricity(JDE)).toBeCloseTo(0.01671167, 6);
});

test("sun.distance matches Meeus' worked example 25.a", () => {
    expect(precise.sun.distance(JDE)).toBeCloseTo(149248233, -2);
});

test("sun.apparentPosition matches Meeus' worked example 25.a", () => {
    const equ = precise.sun.apparentPosition(JDE);
    expect(equ.rightAscension).toBeCloseTo(198.38083, 3);
    expect(equ.declination).toBeCloseTo(-7.78507, 3);
});

// 25.a takes the nutation from its largest term only; the full series moves λ by 0.0003°.
test("sun.apparentLongitude matches Meeus' worked example 25.a", () => {
    expect(precise.sun.apparentLongitude(JDE)).toBeCloseTo(199.90895, 3);
    expect(approx.sun.apparentLongitude(JDE)).toBeCloseTo(199.90895, 2);
});

test("approx.sun.apparentPosition roughly agrees with the precise result", () => {
    const preciseEqu = precise.sun.apparentPosition(JDE);
    const approxEqu = approx.sun.apparentPosition(JDE);

    expect(approxEqu.rightAscension).toBeCloseTo(preciseEqu.rightAscension, 0);
    expect(approxEqu.declination).toBeCloseTo(preciseEqu.declination, 0);
});

test('sun.equatorialHorizontalParallax is 8.794" at 1 AU, scaled by the distance (Meeus 40.1)', () => {
    const au = precise.sun.distance(JDE) / precise.ASTRONOMICAL_UNIT_KM;
    expect(precise.sun.equatorialHorizontalParallax(JDE) * 3600).toBeCloseTo(8.794 / au, 3);
});

test("sun.equatorialHorizontalParallax is on the order of the Sun's real ~8.8 arcsecond parallax", () => {
    expect(precise.sun.equatorialHorizontalParallax(JDE)).toBeCloseTo(8.8 / 3600, 3);
});

test("sun.topocentricPosition nudges apparentPosition by no more than the Sun's parallax", () => {
    const time = precise.fromJulianDay(JDE);
    const apparent = precise.sun.apparentPosition(JDE);
    const topocentric = precise.sun.topocentricPosition(time, { latitude: 52.39, longitude: 13.09 });

    expect(Math.abs(topocentric.rightAscension - apparent.rightAscension)).toBeLessThan(8.8 / 3600);
    expect(Math.abs(topocentric.declination - apparent.declination)).toBeLessThan(8.8 / 3600);
});

// Meeus 25.a has R = 0.99766 AU; the Sun's disc spans 2 · atan(696,000 km / R), about 0.534°.
test("sun.apparentAngularDiameter is in degrees", () => {
    expect(precise.sun.apparentAngularDiameter(JDE)).toBeCloseTo(0.5344, 3);
    expect(approx.sun.apparentAngularDiameter(JDE)).toBeCloseTo(0.5344, 3);
});

test("approx.sun.equationOfCenter stays within a hundredth of a degree of the precise one", () => {
    for (let t = precise.J2000; t < precise.J2050; t += 11.7) {
        expect(Math.abs(approx.sun.equationOfCenter(t) - precise.sun.equationOfCenter(t))).toBeLessThan(0.01);
    }
});

test("sun.direction and moon.direction are the unit vectors of their horizontal positions", () => {
    const time = { year: 2026, month: 6, day: 21, hour: 10, minute: 0, second: 0, utcOffsetSeconds: 0 };
    const place = { latitude: 52.5, longitude: 13.4, heightM: 300 };
    for (const body of [precise.sun, precise.moon] as const) {
        const direction = body.direction(time, place);
        expect(direction).toEqual(precise.horizontalToDirection(body.horizontalPosition(time, place)));
        expect(Math.hypot(...direction)).toBeCloseTo(1, 12);
    }
});

test("sun.apparentEclipticalPosition is the apparent longitude, on the ecliptic", () => {
    expect(precise.sun.apparentEclipticalPosition(JDE)).toEqual({
        longitude: precise.sun.apparentLongitude(JDE),
        latitude: 0,
    });
});
