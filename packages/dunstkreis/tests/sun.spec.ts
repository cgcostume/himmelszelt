import { expect, test } from "@playwright/test";
import { evaluateWgsl, gpuDevice, wgslSource } from "./gpu.js";

type Vec4 = [number, number, number, number];
const source = wgslSource("sun");
// The Sun due north on the horizon, its true radius, and a pixel of a fiftieth of it, rays across and down.
const RADIUS = (0.2665 * Math.PI) / 180;
const PIXEL = RADIUS / 50;

/** The coverage of the pixel whose ray is `offset` radians from the Sun's center, east, along the horizon. */
async function coverage(offsets: number[], pixel = PIXEL) {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return [];
    const inputs = offsets.map((x): Vec4 => [x, 0, 0, 0]);
    const expression = `vec4f(dkSunDiscPixelCoverage(
        normalize(vec3f(input.x, 1.0, 0.0)),
        normalize(vec3f(input.x + ${pixel}, 1.0, 0.0)),
        normalize(vec3f(input.x, 1.0, -${pixel})),
        vec3f(0.0, 1.0, 0.0),
        ${RADIUS},
    ), 0.0, 0.0, 0.0)`;
    return (await evaluateWgsl(device, source, expression, inputs)).map((v) => v[0]);
}

test("the supersampled disc covers a pixel wholly inside, none outside, and about half on its rim", async () => {
    const [inside, outside, rim] = await coverage([0, 2 * RADIUS, RADIUS]);
    if (inside === undefined) return;
    expect(inside).toBe(1);
    expect(outside).toBe(0);
    expect(rim).toBeGreaterThan(0.3);
    expect(rim).toBeLessThan(0.7);
});

test("across the rim, the coverage falls in steps of a sixteenth, never rising", async () => {
    const offsets = [...Array(21).keys()].map((i) => RADIUS - PIXEL * (1 - i / 10));
    const values = await coverage(offsets);
    if (values.length === 0) return;
    values.forEach((value, i) => {
        expect(value * 16).toBeCloseTo(Math.round(value * 16), 5);
        if (i > 0) expect(value).toBeLessThanOrEqual(values[i - 1] as number);
    });
});

/** `expression` over the angles `radii`, in solar radii east of the Sun's center. */
async function alongRadius(expression: string, radii: number[]) {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return [];
    // The chord of the angle, as the snippets measure it.
    const inputs = radii.map((r): Vec4 => [Math.sin(r * RADIUS), Math.cos(r * RADIUS), 0, 0]);
    return evaluateWgsl(device, source, expression, inputs);
}

test("limb darkening keeps the disc's light, and at 550 nm follows Allen's law to a hundredth", async () => {
    const steps = 400;
    const radii = [...Array(steps).keys()].map((i) => (i + 0.5) / steps);
    const values = await alongRadius(
        `vec4f(dkSunLimbDarkening(input.xyz, vec3f(0.0, 1.0, 0.0), ${RADIUS}), 0.0)`,
        radii,
    );
    if (values.length === 0) return;
    // The mean over the disc, in rings: 1 per channel, less the little the law is held up by at the very limb.
    for (const channel of [0, 1, 2]) {
        const mean = values.reduce((sum, v, i) => sum + (v[channel] ?? 0) * 2 * (radii[i] ?? 0), 0) / steps;
        expect(mean).toBeGreaterThan(1);
        expect(mean).toBeLessThan(1.004);
    }
    // Green against Allen's Astrophysical Quantities at 550 nm, 0.3 + 0.93 mu - 0.23 mu², both over the center.
    const center = values[0]?.[1] ?? 0;
    expect(center).toBeCloseTo(2.5079 / 2, 3);
    for (const i of [100, 200, 300, 360]) {
        const mu = Math.sqrt(1 - (radii[i] ?? 0) ** 2);
        expect(Math.abs((values[i]?.[1] ?? 0) / center - (0.3 + 0.93 * mu - 0.23 * mu * mu))).toBeLessThan(0.01);
    }
    // The limb is redder than the center: blue falls further than red.
    const limb = values[steps - 1] ?? [0, 0, 0, 0];
    expect(limb[2] / (values[0]?.[2] ?? 1)).toBeLessThan(limb[0] / (values[0]?.[0] ?? 1));
});

test("the corona is Baumbach's, none on the disc and none beyond its reach", async () => {
    const radii = [0.5, 1.0001, 2, 4, 20, 35, 41, 60];
    const values = (
        await alongRadius(`vec4f(dkSunCorona(input.xyz, vec3f(0.0, 1.0, 0.0), ${RADIUS}), 0.0, 0.0, 0.0)`, radii)
    ).map((v) => v[0]);
    if (values.length === 0) return;
    const at = (i: number) => values[i] ?? Number.NaN;
    const baumbach = (r: number) => 1.24e-6 * (0.0532 / r ** 2.5 + 1.425 / r ** 7 + 2.565 / r ** 17);
    expect(at(0)).toBe(0);
    expect(at(1) / baumbach(1)).toBeCloseTo(1, 2);
    expect(at(1)).toBeCloseTo(5.0e-6, 7);
    for (const i of [2, 3, 4]) expect(at(i) / baumbach(radii[i] ?? 1)).toBeCloseTo(1, 2);
    // Fading over the last quarter of its reach, gone beyond 40 radii.
    expect(at(5)).toBeLessThan(baumbach(35));
    expect(at(5)).toBeGreaterThan(0);
    expect(at(6)).toBe(0);
    expect(at(7)).toBe(0);
});

test("the chromosphere fills a pixel by its share of it, in pink, just outside the limb", async () => {
    // A pixel a hundredth of the radius across, centered on the shell's middle; one on the disc; one well outside.
    const footprint = RADIUS / 100;
    const values = await alongRadius(
        `vec4f(dkSunChromosphere(input.xyz, vec3f(0.0, 1.0, 0.0), ${RADIUS}, ${footprint}), 0.0)`,
        [1.0018, 0.9, 1.1],
    );
    if (values.length === 0) return;
    const [shell, disc, outside] = values as [Vec4, Vec4, Vec4];
    // 0.36 % of the radius in a pixel of 1 % of it: 36 % of 3e-4 in red.
    expect(shell[0] / (3e-4 * 0.36)).toBeCloseTo(1, 1);
    expect(shell[1]).toBeLessThan(shell[2]);
    expect(shell[2]).toBeLessThan(shell[0]);
    expect(disc[0]).toBe(0);
    expect(outside[0]).toBe(0);
});
