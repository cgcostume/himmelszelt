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
