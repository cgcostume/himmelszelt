import { expect, test } from "@playwright/test";
import { airTable, airTableBend, liftedDirection, scintillationIndex } from "../src/air.js";
import { colorFromColorIndex, temperatureFromColorIndex, temperatureFromColorIndexApprox } from "../src/color.js";
import {
    illuminanceFromMagnitude,
    luminanceFromSurfaceBrightness,
    magnitudeFromIlluminance,
    S10_LUMINANCE,
    surfaceBrightnessFromLuminance,
} from "../src/light.js";

test("a star of magnitude 0 gives some 2.5 millionths of a lux, the Sun 128,000", () => {
    expect(illuminanceFromMagnitude(0)).toBeCloseTo(2.5775e-6, 9);
    expect(illuminanceFromMagnitude(-26.74)).toBeCloseTo(128_000, 0);
    expect(magnitudeFromIlluminance(illuminanceFromMagnitude(6.5))).toBeCloseTo(6.5, 9);
    // Five magnitudes are a factor of a hundred.
    expect(illuminanceFromMagnitude(1) / illuminanceFromMagnitude(6)).toBeCloseTo(100, 6);
});

test("surface brightness: a dark sky of 21.5 mag/arcsec² is some 0.2 thousandths of a cd/m², an S10 some 0.8 millionths", () => {
    expect(luminanceFromSurfaceBrightness(21.5)).toBeGreaterThan(2.0e-4);
    expect(luminanceFromSurfaceBrightness(21.5)).toBeLessThan(3.0e-4);
    expect(surfaceBrightnessFromLuminance(luminanceFromSurfaceBrightness(23.2))).toBeCloseTo(23.2, 9);
    expect(S10_LUMINANCE).toBeGreaterThan(8e-7);
    expect(S10_LUMINANCE).toBeLessThan(9e-7);
});

test("Ballesteros' temperature: Vega near 10,000 K, the Sun near 5,800 K, a red star cool", () => {
    expect(temperatureFromColorIndex(0)).toBeGreaterThan(9500);
    expect(temperatureFromColorIndex(0)).toBeLessThan(10500);
    expect(temperatureFromColorIndex(0.65)).toBeGreaterThan(5600);
    expect(temperatureFromColorIndex(0.65)).toBeLessThan(5900);
    expect(temperatureFromColorIndex(1.85)).toBeLessThan(3800);
    expect(temperatureFromColorIndexApprox(0.65)).toBeCloseTo(5785, 0);
});

test("a star's color: blue stars bluer than red, and the shipped catalog's path reproduces its colors", () => {
    const vega = colorFromColorIndex(0);
    const betelgeuse = colorFromColorIndex(1.85);
    expect(vega[2]).toBeGreaterThan(vega[0]);
    expect(betelgeuse[0]).toBeGreaterThan(betelgeuse[2]);
    // Unit luminance: the Rec. 709 weights of the channels sum to about 1.
    const luminance = (c: readonly number[]) => 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
    expect(luminance(vega)).toBeCloseTo(1, 2);
    expect(luminance(betelgeuse)).toBeCloseTo(1, 2);
});

test("the air table crowds its entries at the horizon, finds it, and lifts a star by its bend", () => {
    // Bennett's refraction, in degrees, for a horizon at -0.3°.
    const bend = (a: number) =>
        a < -0.3 ? null : 1 / Math.tan(((Math.max(a, 0) + 7.31 / (Math.max(a, 0) + 4.4)) * Math.PI) / 180) / 60;
    const through = (a: number) => (a < -0.3 ? null : ([0.8, 0.7, 0.6] as const));
    const table = airTable(bend, through);
    expect(table.horizon).toBeCloseTo(-0.3, 4);
    expect(airTableBend(table, 0)).toBeCloseTo(bend(0) ?? 0, 2);
    expect(airTableBend(table, 45)).toBeCloseTo(bend(45) ?? 0, 4);
    expect(airTableBend(table, 89.9)).toBeCloseTo(bend(89.9) ?? 0, 4);
    // A star truly on the horizon shows some 34 arcminutes higher.
    const lifted = liftedDirection(table, [0, 1, 0]);
    expect((Math.asin(lifted[2]) * 180) / Math.PI).toBeGreaterThan(0.45);
    expect((Math.asin(lifted[2]) * 180) / Math.PI).toBeLessThan(0.6);
    // Below the most bent ray, unchanged.
    expect(liftedDirection(table, [0, 1, -0.1])).toEqual([0, 1, -0.1]);
});

test("the twinkling: a tenth or so at the zenith for the eye, more than half near the horizon, never past saturation", () => {
    expect(scintillationIndex(90)).toBeGreaterThan(0.1);
    expect(scintillationIndex(90)).toBeLessThan(0.35);
    expect(scintillationIndex(20)).toBeGreaterThan(0.5);
    expect(scintillationIndex(2)).toBe(0.6);
    expect(scintillationIndex(90, 20)).toBeLessThan(scintillationIndex(90));
});
