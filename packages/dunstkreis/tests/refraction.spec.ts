import { earth } from "@himmelszelt/sternzeit";
import { expect, test } from "@playwright/test";
import { DEFAULT_ATMOSPHERE_MODEL } from "../src/model.js";
import { airRefractivity, apparentDirection, refractionAngle } from "../src/refraction.js";

const model = DEFAULT_ATMOSPHERE_MODEL;
const GROUND_M = 0.001;
const standard = { temperatureC: 15 };
const bennett = (altitude: number) => earth.atmosphericRefractionFromApparent(altitude, standard);
const traced = (altitude: number, heightM = GROUND_M) => refractionAngle(model, heightM, altitude) as number;

test("air's refractivity is Edlén's at the standard atmosphere and follows its density", () => {
    expect(airRefractivity()).toBeCloseTo(2.778e-4, 7);
    expect(airRefractivity(-20)).toBeGreaterThan(airRefractivity(30));
    expect(airRefractivity(15, 500)).toBeCloseTo(airRefractivity() / 2.0265, 7);
});

test("traced through the model's air, refraction lands near Bennett's fit", () => {
    // Above a few degrees only the refractivity on the ground matters, and the two agree to a few percent.
    for (const altitude of [5, 10, 20, 45, 80])
        expect(Math.abs(traced(altitude) / bennett(altitude) - 1)).toBeLessThan(0.03);
    // At the horizon the ray crosses the lowest air, where the model's one scale height makes it denser than the real
    // one, whose temperature falls with height: some 10% more.
    expect(traced(0) / bennett(0)).toBeGreaterThan(1);
    expect(traced(0) / bennett(0)).toBeLessThan(1.12);
    expect(traced(90)).toBeCloseTo(0, 6);
});

test("without refractivity, nothing bends", () => {
    const straight = { ...model, refractivity: 0 };
    expect(refractionAngle(straight, GROUND_M, 0)).toBeCloseTo(0, 9);
    expect(apparentDirection([0.6, 0.8, 0], straight, GROUND_M)).toEqual([0.6, 0.8, 0]);
});

test("the horizon rises above its geometric dip, and the ray there bends out and back in", () => {
    const heightM = 10_000;
    const dip = (-Math.acos(6360 / 6370) * 180) / Math.PI;
    let [low, high] = [dip - 1, dip + 1];
    for (let i = 0; i < 50; ++i) {
        const middle = (low + high) / 2;
        if (refractionAngle(model, heightM, middle) === null) low = middle;
        else high = middle;
    }
    // Terrestrial refraction, from the same air: some 7% of the dip, as surveyors' k = 0.13 gives.
    expect(high - dip).toBeGreaterThan(0.05 * -dip);
    expect(high - dip).toBeLessThan(0.1 * -dip);
    // Grazing the ground from up there, the ray crosses the lowest air twice.
    expect(traced(high + 1e-6, heightM)).toBeGreaterThan(1.5 * traced(0));
});

test("from space, a ray grazing the ground bends twice the horizon's, and one through thin air hardly at all", () => {
    const heightM = 400_000;
    const limb = (-Math.acos(6360 / 6760) * 180) / Math.PI;
    expect(traced(limb + 0.05, heightM) / traced(0)).toBeGreaterThan(1.5);
    expect(traced(limb + 2, heightM)).toBeLessThan(1e-3);
    expect(traced(10, heightM)).toBe(0);
});

test("apparentDirection is the inverse of the tracing, and steady looking down from high up", () => {
    for (const heightM of [GROUND_M, 1000, 20_000, 400_000]) {
        for (let altitude = -20; altitude < 60; altitude += 0.37) {
            const a = (altitude * Math.PI) / 180;
            const apparent = apparentDirection([0.6 * Math.cos(a), 0.8 * Math.cos(a), Math.sin(a)], model, heightM);
            const apparentAltitude = (Math.asin(apparent[2]) * 180) / Math.PI;
            const bend = refractionAngle(model, heightM, apparentAltitude);
            if (bend === null) continue;
            // Lifted, never by more than the grazing ray from space, and lowered back exactly. Unless the planet hides
            // it: then it stays on the horizon, just below which the rays end on the ground.
            expect(apparentAltitude).toBeGreaterThanOrEqual(altitude);
            expect(apparentAltitude - altitude).toBeLessThan(1.5);
            const error = (apparentAltitude - bend - altitude) * 3600;
            expect(error).toBeGreaterThan(-0.1);
            if (error > 0.1) expect(refractionAngle(model, heightM, apparentAltitude - 0.001)).toBeNull();
        }
    }
});
