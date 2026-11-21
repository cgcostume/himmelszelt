import { expect, test } from "@playwright/test";
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

test("surface brightness: a dark sky of 21.5 mag/arcsec² is some 0.28 thousandths of a cd/m², an S10 some 0.8 millionths", () => {
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

test("a star's color: blue stars bluer than red, at unit luminance", () => {
    const vega = colorFromColorIndex(0);
    const betelgeuse = colorFromColorIndex(1.85);
    expect(vega[2]).toBeGreaterThan(vega[0]);
    expect(betelgeuse[0]).toBeGreaterThan(betelgeuse[2]);
    // Unit luminance: the Rec. 709 weights of the channels sum to about 1.
    const luminance = (c: readonly number[]) => 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
    expect(luminance(vega)).toBeCloseTo(1, 2);
    expect(luminance(betelgeuse)).toBeCloseTo(1, 2);
});
