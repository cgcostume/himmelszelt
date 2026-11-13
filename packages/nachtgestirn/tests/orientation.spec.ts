import { expect, test } from "@playwright/test";
import {
    earthshineIlluminance,
    horizonZ,
    liftedDirection,
    meanLuminance,
    moonEV100,
    moonIlluminance,
    moonOrientation,
    phaseLaw,
    REFRACTION_SAMPLES,
    refractionTable,
    selenographic,
    toSelenographic,
    viewFrame,
} from "../src/orientation.js";

const DEG = Math.PI / 180;

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

test("the meter exposes a full Moon by looney 11, f/11 at 1/100 s, and a crescent's lit part alike", () => {
    expect(moonEV100(0, 1, 0.8)).toBeCloseTo(Math.log2(121 * 100), 0);
    // Half lit at the quarter: a tenth of the full Moon's light over half the disc, 2.3 stops less.
    expect(moonEV100(0, 1) - moonEV100(90, 0.5)).toBeGreaterThan(2);
    expect(moonEV100(0, 1) - moonEV100(90, 0.5)).toBeLessThan(2.6);
});

test("a full Moon lights the top of the air with some 0.3 lux, four hundred thousandths of the Sun's", () => {
    expect(moonIlluminance(0)).toBeGreaterThan(0.28);
    expect(moonIlluminance(0)).toBeLessThan(0.34);
    expect(moonIlluminance(90)).toBeCloseTo(moonIlluminance(0) * phaseLaw(90), 6);
});

test("the refraction table spans the disc and what the air lifts it by, and finds the horizon", () => {
    // Bennett's refraction, in degrees at an apparent altitude in degrees; below -1° the ray ends on the ground.
    const bennett = (h: number) => (h < -1 ? null : 1 / Math.tan((h + 7.31 / (h + 4.4)) * (Math.PI / 180)) / 60);
    // The true center a third of a degree down, the disc just risen.
    const table = refractionTable([0, Math.cos(-0.3 * DEG), Math.sin(-0.3 * DEG)], 0.52, bennett);
    expect(table.bends.length).toBe(REFRACTION_SAMPLES);
    // Every entry on or just around the disc, which shows lifted, squeezed to some 0.8 of its 0.52°.
    const top = table.from + (REFRACTION_SAMPLES - 1) * table.step;
    expect(top - table.from).toBeGreaterThan(0.4 * DEG);
    expect(top - table.from).toBeLessThan(0.6 * DEG);
    const [, uy, uz] = liftedDirection([0, Math.cos(-0.04 * DEG), Math.sin(-0.04 * DEG)], bennett);
    const at = (Math.atan2(uz, uy) - table.from) / table.step;
    expect(at).toBeGreaterThan(REFRACTION_SAMPLES / 2);
    expect(at).toBeLessThan(REFRACTION_SAMPLES);
    const i = 10;
    expect((table.bends[i] ?? 0) / DEG).toBeCloseTo(bennett((table.from + i * table.step) / DEG) ?? 0, 5);
    // Sunk to -2°, the band's lower part on the ground: its horizon at -1° exactly, and no jump in the bends below it.
    const sunk = refractionTable([0, Math.cos(-2 * DEG), Math.sin(-2 * DEG)], 0.52, bennett);
    expect(sunk.horizon / DEG).toBeCloseTo(-1, 5);
    expect(sunk.bends[0]).toBe(sunk.bends[sunk.bends.findIndex((_, k) => sunk.from + k * sunk.step >= -DEG)]);
});

test("the lifted direction follows the bend and runs on smoothly below the horizon", () => {
    const bennett = (h: number) => (h < -0.5 ? null : 1 / Math.tan((h + 7.31 / (h + 4.4)) * DEG) / 60);
    const altitude = (t: number) => {
        const [, y, z] = liftedDirection([0, Math.cos(t * DEG), Math.sin(t * DEG)], bennett);
        return Math.atan2(z, y) / DEG;
    };
    expect(altitude(10)).toBeCloseTo(10 + (bennett(altitude(10)) ?? 0), 4);
    // Lifted some 0.6° near the horizon; below the last ray it keeps its lift and sinks at the true rate.
    // From far below, where no ray within 3° of the body gets out, too: the rising Moon must not jump back.
    const steps = Array.from({ length: 81 }, (_, i) => altitude(-7.5 + i * 0.1));
    for (let i = 1; i < steps.length; i++) {
        expect((steps[i] ?? 0) - (steps[i - 1] ?? 0)).toBeGreaterThan(0.04);
        expect((steps[i] ?? 0) - (steps[i - 1] ?? 0)).toBeLessThan(0.11);
    }
});
