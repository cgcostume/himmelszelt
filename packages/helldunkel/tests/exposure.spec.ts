import { expect, test } from "@playwright/test";
import { ev100FromLuminance, exposureFromEV100, localAdaptation, lowLightCompensation } from "../src/exposure.js";

test("EV100 follows the photographic convention", () => {
    // At EV 0, 1.2 cd/m² just saturates; each EV halves the exposure.
    expect(exposureFromEV100(0)).toBeCloseTo(1 / 1.2, 12);
    expect(exposureFromEV100(15) * 2).toBeCloseTo(exposureFromEV100(14), 12);
    // A light meter reads a sunny sky of some 4000 cd/m² as about EV 15, and exposed so the average lands at ~0.1.
    expect(ev100FromLuminance(4096)).toBeCloseTo(15, 12);
    expect(4096 * exposureFromEV100(ev100FromLuminance(4096))).toBeCloseTo(1 / 9.6, 12);
});

test("a dim scene is exposed darker than metered, a bright one as metered", () => {
    expect(lowLightCompensation(4096)).toBe(0);
    expect(lowLightCompensation(1.3)).toBe(0);
    // A moonlit sky some 2.6 stops under middle gray, a moonless one barely more: Krawczyk et al.'s key bottoms out at 0.03.
    expect(lowLightCompensation(0.01)).toBeCloseTo(-2.5, 1);
    expect(lowLightCompensation(0)).toBeCloseTo(Math.log2(0.03 / 0.18), 6);
    for (const l of [1e-4, 1e-2, 0.1, 0.5, 1])
        expect(lowLightCompensation(l)).toBeLessThanOrEqual(lowLightCompensation(l * 2));
});

test("local adaptation draws the Moon darker in a night sky, by the eye's share, and never anything brighter", () => {
    expect(localAdaptation(-6, 13.6)).toBeCloseTo(-19.6, 6);
    expect(localAdaptation(-6, 13.6, 0.5)).toBeCloseTo(-9.8, 6);
    expect(localAdaptation(-6, 13.6, 0)).toBeCloseTo(0, 6);
    expect(localAdaptation(15, 13.6)).toBeCloseTo(0, 6);
});
