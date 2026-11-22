import { expect, test } from "@playwright/test";
import { type AutoExposureKey, autoExposureCompensation, autoExposureTint } from "../src/exposure.js";
import { DEFAULT_ATMOSPHERE_MODEL, luminanceScale, spectrumToRgb } from "../src/model.js";

// A photographer's ramp, untinted: night darker, the blue hour lifted, the sunset a little brighter than the sunrise.
const RAMP: readonly AutoExposureKey[] = [
    { sunAltitude: -18, compensation: -2 },
    { sunAltitude: -8, compensation: -1.5 },
    { sunAltitude: -5, compensation: -0.8 },
    { sunAltitude: -2, compensation: -0.9 },
    { sunAltitude: -1, compensation: -0.7 },
    { sunAltitude: 0, compensation: { rising: 0, setting: 0.2 } },
    { sunAltitude: 6, compensation: { rising: 0.2, setting: 0.3 } },
    { sunAltitude: 60, compensation: 0 },
];

test("the luminance scale gives the sun its illuminance, once its four wavelengths are turned into RGB", () => {
    const model = DEFAULT_ATMOSPHERE_MODEL;
    const sun = model.solarSpectrum.map((e) => e * luminanceScale(model));
    const [r, g, b] = spectrumToRgb(model).map((row) => row.reduce((sum, m, j) => sum + m * (sun[j] as number), 0));
    expect(0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number)).toBeCloseTo(128_000, 6);
});

test("the keys ramp the compensation smoothly with the sun, mornings and evenings apart, and lifts the blue hour", () => {
    const at = (altitude: number, east: number) => {
        const a = (altitude * Math.PI) / 180;
        const [e, n] = [Math.sin(east), -Math.cos(east)];
        return autoExposureCompensation(RAMP, [e * Math.cos(a), n * Math.cos(a), Math.sin(a)]);
    };
    const [east, west] = [Math.PI / 2, -Math.PI / 2];
    expect(at(-40, east)).toBe(-2);
    expect(at(-1, east)).toBeCloseTo(-0.7, 12);
    expect(at(0, east)).toBeCloseTo(0, 12);
    expect(at(0, west)).toBeCloseTo(0.2, 12);
    expect(at(-12, west)).toBeGreaterThan(-2);
    expect(at(-12, west)).toBeLessThan(-1.5);
    expect(at(-5, west)).toBeCloseTo(-0.8, 12);
    expect(at(-3, west)).toBeLessThan(-0.8);
    expect(at(3, west)).toBeGreaterThan(0.2);
    expect(at(3, west)).toBeLessThan(0.3);
    expect(at(80, east)).toBe(0);
    expect(autoExposureCompensation([], [0, 0, 1])).toBe(0);
    // High up, the horizon sinks: a sun 5° below the horizontal is 5° above a horizon 10° down.
    const low = [0, Math.cos((5 * Math.PI) / 180), -Math.sin((5 * Math.PI) / 180)] as const;
    expect(autoExposureCompensation(RAMP, low, 10)).toBeCloseTo(at(5, 0), 12);
    // No jumps: not over the altitudes, nor where morning turns into evening across the meridian.
    for (let altitude = -30; altitude < 70; altitude += 0.01) {
        expect(Math.abs(at(altitude + 0.01, east) - at(altitude, east))).toBeLessThan(0.01);
    }
    for (let azimuth = -Math.PI; azimuth < Math.PI; azimuth += 0.001) {
        expect(Math.abs(at(3, azimuth + 0.001) - at(3, azimuth))).toBeLessThan(0.001);
    }
});

test("a tint keeps the luminance, follows the keys by the sun, and leaves untinted keys neutral", () => {
    const sunAt = (altitude: number, east: number): [number, number, number] => {
        const a = (altitude * Math.PI) / 180;
        return [east * Math.cos(a), 0, Math.sin(a)];
    };
    const luminance = ([r, g, b]: number[]) => 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    expect(autoExposureTint(RAMP, sunAt(3, -1))).toEqual([1, 1, 1]);
    expect(autoExposureTint([], sunAt(3, -1))).toEqual([1, 1, 1]);
    const warm = [2, 1, 0.5] as const;
    const keys = [
        { sunAltitude: -6, compensation: -1, tint: { rising: [1, 1, 1] as const, setting: [1, 0.6, 1.4] as const } },
        { sunAltitude: 3, compensation: 0, tint: warm },
        { sunAltitude: 30, compensation: 0 },
    ];
    // At a key, its tint at unit luminance; between keys, between their tints, still at unit luminance.
    const atKey = autoExposureTint(keys, sunAt(3, -1));
    const scale = luminance([...warm]);
    for (const [i, g] of atKey.entries()) expect(g).toBeCloseTo((warm[i] as number) / scale, 12);
    for (let altitude = -10; altitude <= 40; altitude += 0.5)
        expect(luminance(autoExposureTint(keys, sunAt(altitude, -1)))).toBeCloseTo(1, 12);
    const between = autoExposureTint(keys, sunAt(15, -1));
    expect(between[0]).toBeGreaterThan(1);
    expect(between[0]).toBeLessThan(atKey[0]);
    for (const g of autoExposureTint(keys, sunAt(60, -1))) expect(g).toBeCloseTo(1, 12);
    // Mornings and evenings apart: purple at dusk, neutral at dawn.
    const dusk = autoExposureTint(keys, sunAt(-6, -1));
    const dawn = autoExposureTint(keys, sunAt(-6, 1));
    expect(dusk[1]).toBeLessThan(dusk[2]);
    for (const g of dawn) expect(g).toBeCloseTo(1, 12);
    // The tint takes nothing from the compensation.
    expect(autoExposureCompensation(keys, sunAt(-6, -1))).toBeCloseTo(-1, 12);
});
