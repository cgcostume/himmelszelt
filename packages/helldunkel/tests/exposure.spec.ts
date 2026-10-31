import { expect, test } from "@playwright/test";
import { ev100FromLuminance, exposureFromEV100 } from "../src/exposure.js";

test("EV100 follows the photographic convention", () => {
    // At EV 0, 1.2 cd/m² just saturates; each EV halves the exposure.
    expect(exposureFromEV100(0)).toBeCloseTo(1 / 1.2, 12);
    expect(exposureFromEV100(15) * 2).toBeCloseTo(exposureFromEV100(14), 12);
    // A light meter reads a sunny sky of some 4000 cd/m² as about EV 15, and exposed so the average lands at ~0.1.
    expect(ev100FromLuminance(4096)).toBeCloseTo(15, 12);
    expect(4096 * exposureFromEV100(ev100FromLuminance(4096))).toBeCloseTo(1 / 9.6, 12);
});
