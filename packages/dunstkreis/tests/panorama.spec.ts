import { expect, test } from "@playwright/test";
import { evaluateWgsl, gpuDevice, wgslSource } from "./gpu.js";

const source = wgslSource("panorama");
const DEG = Math.PI / 180;
type Vec4 = [number, number, number, number];

/** The ENU direction at an azimuth from north through east and an altitude, in degrees. */
const direction = (azimuth: number, altitude: number): Vec4 => [
    Math.cos(altitude * DEG) * Math.sin(azimuth * DEG),
    Math.cos(altitude * DEG) * Math.cos(azimuth * DEG),
    Math.sin(altitude * DEG),
    0,
];

/** u around the seam, within [-0.5, 0.5): the left and the right edge are the same azimuth. */
const wrapped = (u = 0, around = 0) => ((((u - around) % 1) + 1.5) % 1) - 0.5;

async function evaluate(expression: string, inputs: Vec4[]) {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return [];
    return evaluateWgsl(device, source, expression, inputs);
}

// North, east, south, west on the horizon, then the zenith.
const MARKS = [direction(0, 0), direction(90, 0), direction(180, 0), direction(270, 0), direction(0, 90)];

test("the equirectangular puts north at the left edge, south in the middle and the zenith at the top", async () => {
    const full = await evaluate("vec4f(dkEquirectangularUv(input.xyz, 0.0), 0.0, 0.0)", MARKS);
    if (full.length === 0) return;
    const expected = [
        [0, 0.5],
        [0.25, 0.5],
        [0.5, 0.5],
        [0.75, 0.5],
    ];
    expected.forEach(([u, v], i) => {
        expect(wrapped(full[i]?.[0], u)).toBeCloseTo(0, 5);
        expect(full[i]?.[1]).toBeCloseTo(v as number, 5);
    });
    expect(full[4]?.[1]).toBeCloseTo(0, 5);
});

test("octahedral and fisheye put the zenith in the middle, north at the top and east on the left", async () => {
    for (const fn of ["dkOctahedralUv(input.xyz, 0.0)", "dkFisheyeUv(input.xyz, 0.0)"]) {
        const uv = await evaluate(`vec4f(${fn}, 0.0, 0.0)`, MARKS);
        if (uv.length === 0) return;
        const expected = [
            [0.5, 0],
            [0, 0.5],
            [0.5, 1],
            [1, 0.5],
            [0.5, 0.5],
        ];
        expected.forEach(([u, v], i) => {
            expect(uv[i]?.[0], `${fn} ${i}`).toBeCloseTo(u as number, 5);
            expect(uv[i]?.[1], `${fn} ${i}`).toBeCloseTo(v as number, 5);
        });
    }
});

test("the azimuth offset turns each panorama about the zenith", async () => {
    // Offset by 90°, east takes north's place.
    const offset = (90 * DEG).toFixed(9);
    const uv = await evaluate(
        `vec4f(dkEquirectangularUv(input.xyz, ${offset}), dkOctahedralUv(input.xyz, ${offset}))`,
        [direction(90, 0), direction(0, 0)],
    );
    if (uv.length === 0) return;
    expect(wrapped(uv[0]?.[0])).toBeCloseTo(0, 5);
    expect(uv[1]?.[0]).toBeCloseTo(0.75, 5);
    expect(uv[0]?.[2]).toBeCloseTo(0.5, 5);
    expect(uv[0]?.[3]).toBeCloseTo(0, 5);
});

test("every projection maps a direction back onto itself", async () => {
    const inputs: Vec4[] = [];
    for (let i = 0; i < 512; ++i) {
        const z = 1 - (2 * (i + 0.5)) / 512;
        const azimuth = i * 137.50776405;
        inputs.push(direction(azimuth, Math.asin(z) / DEG));
    }
    const upper = inputs.filter(([, , z]) => z > 0);
    const cases: [string, Vec4[]][] = [
        ["dkPanoramaDirection(1u, dkPanoramaUv(1u, input.xyz, 0.7), 0.7)", inputs],
        ["dkPanoramaDirection(2u, dkPanoramaUv(2u, input.xyz, 0.7), 0.7)", inputs],
        ["dkPanoramaDirection(3u, dkPanoramaUv(3u, input.xyz, 0.7), 0.7)", upper],
        ["dkPanoramaDirection(4u, dkPanoramaUv(4u, input.xyz, 0.7), 0.7)", inputs],
    ];
    for (const [expression, directions] of cases) {
        const back = await evaluate(`vec4f(${expression}, 0.0)`, directions);
        if (back.length === 0) return;
        let worst = 0;
        back.forEach((d, i) => {
            const [x, y, z] = directions[i] as Vec4;
            worst = Math.max(worst, Math.hypot(d[0] - x, d[1] - y, d[2] - z));
        });
        expect(worst, expression).toBeLessThan(1e-4);
    }
});

test("the sphere map puts the horizon at sin 45° of the radius and the nadir on the rim, equal in area", async () => {
    const uv = await evaluate("vec4f(dkSphereMapUv(input.xyz, 0.0), 0.0, 0.0)", [
        ...MARKS,
        direction(0, -89.99),
        direction(90, -30),
    ]);
    if (uv.length === 0) return;
    const r = (p: number[]) => Math.hypot((p[0] ?? 0) * 2 - 1, (p[1] ?? 0) * 2 - 1);
    // North at the top, east on the left, as the fisheye.
    expect(uv[0]?.[0]).toBeCloseTo(0.5, 5);
    expect(uv[0]?.[1]).toBeCloseTo(0.5 - 0.5 * Math.SQRT1_2, 5);
    expect(uv[1]?.[0]).toBeCloseTo(0.5 - 0.5 * Math.SQRT1_2, 5);
    expect(r(uv[4] ?? [])).toBeCloseTo(0, 5);
    expect(r(uv[5] ?? [])).toBeCloseTo(1, 5);
    // sin(zenith angle / 2): 120° from the zenith at sin 60°.
    expect(r(uv[6] ?? [])).toBeCloseTo(Math.sin(60 * DEG), 5);
});

test("the fisheye takes a direction below the horizon to its corner, beyond the circle", async () => {
    const uv = await evaluate("vec4f(dkFisheyeUv(input.xyz, 0.0), 0.0, 0.0)", [
        direction(30, -0.5),
        direction(200, -89),
    ]);
    if (uv.length === 0) return;
    for (const p of uv) {
        expect(p[0]).toBe(0);
        expect(p[1]).toBe(0);
    }
});
