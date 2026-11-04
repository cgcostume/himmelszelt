import { expect, test } from "@playwright/test";
import {
    earthshineIlluminance,
    horizonZ,
    meanLuminance,
    moonOrientation,
    phaseLaw,
    selenographic,
    toSelenographic,
    viewFrame,
} from "../src/orientation.js";

// The Moon due south, halfway up, as seen from the northern hemisphere.
const SOUTH_UP: [number, number, number] = [0, -Math.SQRT1_2, Math.SQRT1_2];

test("the view frame has west on the right when facing south, and the zenith up", () => {
    const { right, up, toward } = viewFrame(SOUTH_UP);
    expect(right[0]).toBeCloseTo(-1, 6);
    expect(up[2]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(toward[1]).toBeCloseTo(Math.SQRT1_2, 6);
});

test("without libration or tilt the disc's center is 0°/0° and its north pole 90° north", () => {
    const m = moonOrientation({
        direction: SOUTH_UP,
        libration: { longitude: 0, latitude: 0 },
        positionAngleOfAxis: 0,
        parallacticAngle: 0,
    });
    const { toward, up, right } = viewFrame(SOUTH_UP);
    const center = selenographic(toSelenographic(m, toward));
    expect(center.longitude).toBeCloseTo(0, 4);
    expect(center.latitude).toBeCloseTo(0, 4);
    // The matrix is float32, and asin steepens near the pole: within a hundredth of a degree.
    expect(selenographic(toSelenographic(m, up)).latitude).toBeCloseTo(90, 1);
    // Selenographic east, Mare Crisium's side, is on the right of the disc, which is the sky's west.
    expect(selenographic(toSelenographic(m, right)).longitude).toBeCloseTo(90, 4);
});

test("the libration moves the disc's center to its longitude and latitude", () => {
    const m = moonOrientation({
        direction: SOUTH_UP,
        libration: { longitude: 5, latitude: -6 },
        positionAngleOfAxis: 0,
        parallacticAngle: 0,
    });
    const center = selenographic(toSelenographic(m, viewFrame(SOUTH_UP).toward));
    expect(center.longitude).toBeCloseTo(5, 4);
    expect(center.latitude).toBeCloseTo(-6, 4);
});

test("the north pole stands at the axis' angle minus the parallactic angle, counterclockwise from up", () => {
    const m = moonOrientation({
        direction: SOUTH_UP,
        libration: { longitude: 0, latitude: 0 },
        positionAngleOfAxis: 20,
        parallacticAngle: -10,
    });
    const { right, up } = viewFrame(SOUTH_UP);
    const tilt = (30 * Math.PI) / 180;
    // Counterclockwise from up by 30°: towards the left.
    const pole: [number, number, number] = [
        -Math.sin(tilt) * right[0] + Math.cos(tilt) * up[0],
        -Math.sin(tilt) * right[1] + Math.cos(tilt) * up[1],
        -Math.sin(tilt) * right[2] + Math.cos(tilt) * up[2],
    ];
    expect(selenographic(toSelenographic(m, pole)).latitude).toBeCloseTo(90, 1);
});

test("the orientation is a rotation", () => {
    const m = moonOrientation({
        direction: [0.3, 0.5, Math.sqrt(1 - 0.09 - 0.25)],
        libration: { longitude: -7, latitude: 3 },
        positionAngleOfAxis: 15,
        parallacticAngle: 40,
    });
    for (const n of [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
    ] as const) {
        const b = toSelenographic(m, n);
        expect(Math.hypot(...b)).toBeCloseTo(1, 5);
    }
});

test("a full Earth lights the Moon with some 13 lux, a ten thousandth of the Sun", () => {
    const full = earthshineIlluminance(0, 384_400);
    expect(full).toBeGreaterThan(12);
    expect(full).toBeLessThan(14);
    expect(earthshineIlluminance(180, 384_400)).toBeCloseTo(0, 6);
    expect(earthshineIlluminance(90, 384_400)).toBeCloseTo(full / Math.PI, 3);
});

test("the phase law gives a tenth at the quarters and the full Moon some 4,900 cd/m²", () => {
    expect(phaseLaw(0)).toBe(1);
    expect(phaseLaw(90)).toBeGreaterThan(0.08);
    expect(phaseLaw(90)).toBeLessThan(0.1);
    expect(meanLuminance(0)).toBeCloseTo(4890, -1);
});

test("the horizon dips with height", () => {
    expect(horizonZ(1)).toBeCloseTo(-0.00056, 4);
    expect(horizonZ(10_000)).toBeLessThan(-0.05);
});
