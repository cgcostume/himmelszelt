import { expect, test } from "@playwright/test";
import {
    autoExposureCompensation,
    DEFAULT_AUTO_EXPOSURE_KEYS,
    ev100FromLuminance,
    exposureFromEV100,
} from "../src/exposure.js";
import { DEFAULT_ATMOSPHERE_MODEL, luminanceScale } from "../src/model.js";

test("EV100 follows the photographic convention", () => {
    // At EV 0, 1.2 cd/m² just saturates; each EV halves the exposure.
    expect(exposureFromEV100(0)).toBeCloseTo(1 / 1.2, 12);
    expect(exposureFromEV100(15) * 2).toBeCloseTo(exposureFromEV100(14), 12);
    // A light meter reads a sunny sky of some 4000 cd/m² as about EV 15, and exposed so the average lands at ~0.1.
    expect(ev100FromLuminance(4096)).toBeCloseTo(15, 12);
    expect(4096 * exposureFromEV100(ev100FromLuminance(4096))).toBeCloseTo(1 / 9.6, 12);
});

test("the luminance scale gives the sun its illuminance", () => {
    const [r, g, b] = DEFAULT_ATMOSPHERE_MODEL.solarIrradiance;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    expect(luminance * luminanceScale(DEFAULT_ATMOSPHERE_MODEL)).toBeCloseTo(128_000, 6);
});

test("the keys ramp the compensation smoothly with the sun, mornings and evenings apart, and lifts the blue hour", () => {
    const at = (altitude: number, east: number) => {
        const a = (altitude * Math.PI) / 180;
        const [e, n] = [Math.sin(east), -Math.cos(east)];
        return autoExposureCompensation(DEFAULT_AUTO_EXPOSURE_KEYS, [e * Math.cos(a), n * Math.cos(a), Math.sin(a)]);
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
    expect(autoExposureCompensation(DEFAULT_AUTO_EXPOSURE_KEYS, low, 10)).toBeCloseTo(at(5, 0), 12);
    // No jumps: not over the altitudes, nor where morning turns into evening across the meridian.
    for (let altitude = -30; altitude < 70; altitude += 0.01) {
        expect(Math.abs(at(altitude + 0.01, east) - at(altitude, east))).toBeLessThan(0.01);
    }
    for (let azimuth = -Math.PI; azimuth < Math.PI; azimuth += 0.001) {
        expect(Math.abs(at(3, azimuth + 0.001) - at(3, azimuth))).toBeLessThan(0.001);
    }
});
