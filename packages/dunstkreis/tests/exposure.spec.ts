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

test("the keys ramp the compensation with the sun, mornings and evenings apart", () => {
    const at = (altitude: number, east: boolean) => {
        const a = (altitude * Math.PI) / 180;
        return autoExposureCompensation(DEFAULT_AUTO_EXPOSURE_KEYS, [(east ? 1 : -1) * Math.cos(a), 0, Math.sin(a)]);
    };
    expect(at(-40, true)).toBe(-2);
    expect(at(-12, false)).toBeCloseTo(-1.6, 12);
    expect(at(-1, true)).toBeCloseTo(-0.35, 12);
    expect(at(0, true)).toBeCloseTo(0, 12);
    expect(at(0, false)).toBeCloseTo(0.2, 12);
    expect(at(3, false)).toBeCloseTo(0.25, 12);
    expect(at(80, true)).toBe(0);
    expect(autoExposureCompensation([], [0, 0, 1])).toBe(0);
});
