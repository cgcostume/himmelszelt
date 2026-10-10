import { expect, test } from "@playwright/test";
import * as approx from "../src/approx.js";
import * as precise from "../src/index.js";

// Meeus, "Astronomical Algorithms", example 47.a (1992-04-12.0 TD, JDE 2448724.5).
const JDE = 2448724.5;

test("moon.meanLongitude matches Meeus' worked example 47.a", () => {
    expect(precise.moon.meanLongitude(JDE)).toBeCloseTo(134.290182, 6);
});

test("moon.meanElongation matches Meeus' worked example 47.a", () => {
    expect(precise.moon.meanElongation(JDE)).toBeCloseTo(113.842304, 6);
});

test("moon.meanAnomaly matches Meeus' worked example 47.a", () => {
    expect(precise.moon.meanAnomaly(JDE)).toBeCloseTo(5.150833, 6);
});

test("moon.meanArgumentOfLatitude matches Meeus' worked example 47.a", () => {
    expect(precise.moon.meanArgumentOfLatitude(JDE)).toBeCloseTo(219.889721, 6);
});

// Meeus' λ = 133.162655° is referred to the mean equinox, like position; apparentPosition adds Δψ = 0.004610°.
test("moon.position matches Meeus' worked example 47.a", () => {
    const ecl = precise.moon.position(JDE);
    expect(ecl.longitude).toBeCloseTo(133.162655, 6);
    expect(ecl.latitude).toBeCloseTo(-3.229126, 6);
});

test("moon.distance matches Meeus' worked example 47.a", () => {
    expect(precise.moon.distance(JDE)).toBeCloseTo(368409.7, 1);
});

test("moon.equatorialHorizontalParallax matches Meeus' worked example 47.a", () => {
    expect(precise.moon.equatorialHorizontalParallax(JDE)).toBeCloseTo(0.99199, 5);
});

// Meeus, example 53.a (the same instant): l' = -1.206°, b' = 4.194°, l'' = -0.025°, b'' = 0.006°, P = 15.08°.
test("moon librations and positionAngleOfAxis match Meeus' worked example 53.a", () => {
    const optical = precise.moon.opticalLibrations(JDE);
    expect(optical.longitude).toBeCloseTo(-1.206, 3);
    expect(optical.latitude).toBeCloseTo(4.194, 3);
    const total = precise.moon.librations(JDE);
    expect(total.longitude - optical.longitude).toBeCloseTo(-0.025, 3);
    expect(total.latitude - optical.latitude).toBeCloseTo(0.006, 3);
    expect(precise.moon.positionAngleOfAxis(JDE)).toBeCloseTo(15.08, 2);
});

test("approx.moon.position roughly agrees with the precise result", () => {
    const preciseEcl = precise.moon.position(JDE);
    const approxEcl = approx.moon.position(JDE);

    expect(approxEcl.longitude).toBeCloseTo(preciseEcl.longitude, 0);
    expect(approxEcl.latitude).toBeCloseTo(preciseEcl.latitude, 0);
});

test("approx.moon.distance roughly agrees with the precise result", () => {
    const preciseDistance = precise.moon.distance(JDE);
    const approxDistance = approx.moon.distance(JDE);

    expect(Math.abs(approxDistance - preciseDistance)).toBeLessThan(2000);
});

// Meeus, "Astronomical Algorithms", example 48.a (1992-04-12.0 TD, the same instant as 47.a).
test("moon.phaseAngle and illuminatedFraction match Meeus' worked example 48.a", () => {
    expect(precise.moon.phaseAngle(JDE)).toBeCloseTo(69.0756, 1);
    expect(precise.moon.illuminatedFraction(JDE)).toBeCloseTo(0.6786, 3);
});

test("approx.moon.phaseAngle and illuminatedFraction match Meeus' 48.4 result for example 48.a", () => {
    expect(approx.moon.phaseAngle(JDE)).toBeCloseTo(68.88, 0);
    expect(approx.moon.illuminatedFraction(JDE)).toBeCloseTo(0.6802, 2);
});

test("moon.earthshine peaks near new moon, vanishes near full moon, and approx stays within 3% of its peak", () => {
    // 2026-08-12 (new moon, the solar eclipse) and 2026-08-28 (full moon).
    const newMoon = 2461265.27;
    const fullMoon = 2461280.66;
    expect(precise.moon.earthshine(newMoon)).toBeGreaterThan(0.09);
    expect(precise.moon.earthshine(fullMoon)).toBeLessThan(0.005);
    for (let jd = newMoon; jd < newMoon + 29.5; jd += 0.5) {
        expect(Math.abs(approx.moon.earthshine(jd) - precise.moon.earthshine(jd))).toBeLessThan(0.03 * 0.095);
    }
});

test("moon.sunDirection is a unit vector within a fraction of a degree of the Sun's own direction", () => {
    const time = precise.fromJulianDay(JDE);
    for (const ns of [precise, approx]) {
        const d = ns.moon.sunDirection(time, { latitude: 52.4, longitude: 13.1 });
        const s = ns.horizontalToDirection(ns.sun.horizontalPosition(time, { latitude: 52.4, longitude: 13.1 }));
        expect(Math.hypot(...d)).toBeCloseTo(1, 9);
        const angle = Math.acos(Math.min(1, d[0] * s[0] + d[1] * s[1] + d[2] * s[2])) * precise.RAD_TO_DEG;
        expect(angle).toBeLessThan(0.2);
    }
});

test("stepping by moon.MEAN_SYNODIC_MONTH from MEAN_NEW_MOON stays within a day of every new and full moon", () => {
    const { MEAN_NEW_MOON, MEAN_SYNODIC_MONTH } = precise.moon;
    // Two hundred lunations, about sixteen years, from the epoch.
    for (let k = 0; k < 200; k++) {
        for (const [offset, wanted] of [
            [0, 0],
            [0.5, 1],
        ] as const) {
            const mean = MEAN_NEW_MOON + (k + offset) * MEAN_SYNODIC_MONTH;
            let closest = Number.POSITIVE_INFINITY;
            for (let jd = mean - 1; jd <= mean + 1; jd += 1 / 48) {
                closest = Math.min(closest, Math.abs(precise.moon.illuminatedFraction(jd) - wanted));
            }
            // A true new or full moon lies inside the window, to a fraction of a percent of the disc.
            expect(closest).toBeLessThan(0.002);
        }
    }
});

// The bright limb faces the Sun: in the observer's view of the Moon, counterclockwise from up, which is to the left,
// the sky's east. Checked against the same direction built from the ENU vectors alone.
test("moon.brightLimbAngle points the bright limb at the Sun in the observer's view", () => {
    const observer = { latitude: 52.4, longitude: 13.1 };
    type V = [number, number, number];
    const dot = ([a0, a1, a2]: V, [b0, b1, b2]: V) => a0 * b0 + a1 * b1 + a2 * b2;
    const cross = ([a0, a1, a2]: V, [b0, b1, b2]: V): V => [a1 * b2 - a2 * b1, a2 * b0 - a0 * b2, a0 * b1 - a1 * b0];
    for (let jd = 2461000; jd < 2461060; jd += 1.37) {
        const time = precise.fromJulianDay(jd);
        const v = [...precise.moon.direction(time, observer)] as V;
        const zenithAcross = cross(cross(v, [0, 0, 1]), v);
        const up = zenithAcross.map((c) => c / Math.hypot(...zenithAcross)) as V;
        const right = cross(v, up);
        const s = [...precise.moon.sunDirection(time, observer)] as V;
        const expected = ((Math.atan2(-dot(s, right), dot(s, up)) * 180) / Math.PI + 360) % 360;
        const angle = precise.moon.brightLimbAngle(time, observer);
        expect(Math.abs(((angle - expected + 540) % 360) - 180)).toBeLessThan(0.5);
        expect(Math.abs(((approx.moon.brightLimbAngle(time, observer) - angle + 540) % 360) - 180)).toBeLessThan(1);
    }
});
