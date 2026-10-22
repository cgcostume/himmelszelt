import { expect, test } from "@playwright/test";
import { evaluateWgsl, gpuDevice, wgslSource } from "./gpu.js";

const source = wgslSource("cube");
type Vec4 = [number, number, number, number];

/** Directions spread evenly over the sphere by a Fibonacci spiral, and the face axes and their diagonals exactly. */
function directions(): Vec4[] {
    const all: Vec4[] = [];
    for (let i = 0; i < 2048; ++i) {
        const z = 1 - (2 * (i + 0.5)) / 2048;
        const r = Math.sqrt(1 - z * z);
        const azimuth = i * 2.399963229728653;
        all.push([r * Math.cos(azimuth), r * Math.sin(azimuth), z, 0]);
    }
    for (const axis of [0, 1, 2])
        for (const sign of [1, -1]) all.push([0, 0, 0, 0].map((_, i) => (i === axis ? sign : 0)) as Vec4);
    const c = 1 / Math.sqrt(3);
    for (const x of [c, -c]) for (const y of [c, -c]) for (const z of [c, -c]) all.push([x, y, z, 0]);
    return all;
}

async function evaluate(expression: string, inputs: Vec4[]) {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return [];
    return evaluateWgsl(device, source, expression, inputs);
}

test("a cubified cube map looks up the point on the face of the direction's largest component", async () => {
    const inputs = directions();
    const points = await evaluate("vec4f(dkCubeFromSphere(input.xyz), 0.0)", inputs);
    if (points.length === 0) return;
    points.forEach((p, i) => {
        const d = inputs[i] as Vec4;
        const axis = [0, 1, 2].reduce((a, b) => (Math.abs(d[b] ?? 0) > Math.abs(d[a] ?? 0) ? b : a));
        // On the face: ±1 along its axis, within [-1, 1] across, the same sign as d.
        expect(Math.abs(p[axis] as number), `${d}`).toBeCloseTo(1, 5);
        expect(Math.sign(p[axis] as number)).toBe(Math.sign(d[axis] as number));
        for (const other of [0, 1, 2].filter((a) => a !== axis)) {
            expect(Math.abs(p[other] as number)).toBeLessThanOrEqual(1 + 1e-5);
            if (Math.abs(d[other] as number) > 1e-6)
                expect(Math.sign(p[other] as number)).toBe(Math.sign(d[other] as number));
        }
    });
});

test("a cubified cube map keeps a component near zero on its side of the face's middle", async () => {
    // Just above and below the horizon, on the side faces: the point's z as small as the direction's, never zero.
    const inputs: Vec4[] = [1e-6, -1e-6, 1e-4, -1e-4].flatMap((z) =>
        [0.3, 1.1, 2].map((azimuth): Vec4 => {
            const r = Math.sqrt(1 - z * z);
            return [r * Math.sin(azimuth), r * Math.cos(azimuth), z, 0];
        }),
    );
    const points = await evaluate("vec4f(dkCubeFromSphere(input.xyz), 0.0)", inputs);
    if (points.length === 0) return;
    points.forEach((p, i) => {
        const z = (inputs[i] as Vec4)[2];
        expect(Math.sign(p[2] as number), `${inputs[i]}`).toBe(Math.sign(z));
        expect(Math.abs(p[2] as number) / Math.abs(z), `${inputs[i]}`).toBeGreaterThan(1);
        expect(Math.abs(p[2] as number) / Math.abs(z), `${inputs[i]}`).toBeLessThan(2);
    });
});

test("dkCubeFromSphere inverts dkSphereFromCube, both ways", async () => {
    const inputs = directions();
    const back = await evaluate("vec4f(dkSphereFromCube(dkCubeFromSphere(input.xyz)), 0.0)", inputs);
    if (back.length === 0) return;
    let worst = 0;
    back.forEach((b, i) => {
        const d = inputs[i] as Vec4;
        worst = Math.max(worst, Math.hypot(b[0] - d[0], b[1] - d[1], b[2] - d[2]));
    });
    expect(worst).toBeLessThan(2e-4);

    // Points on every face, through texel positions as the cube pass writes them, out and back.
    const faces: Vec4[] = [];
    for (let face = 0; face < 6; ++face)
        for (let y = 0; y < 16; ++y) for (let x = 0; x < 16; ++x) faces.push([face, x + 0.5, y + 0.5, 0]);
    const roundTrip = await evaluate(
        "vec4f(dkCubeFromSphere(dkSphereFromCube(dkCubePointAt(u32(input.x), input.yz, 16u))), 0.0)",
        faces,
    );
    const direct = await evaluate("vec4f(dkCubePointAt(u32(input.x), input.yz, 16u), 0.0)", faces);
    let worstPoint = 0;
    roundTrip.forEach((p, i) => {
        const q = direct[i] as [number, number, number, number];
        worstPoint = Math.max(worstPoint, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    });
    expect(worstPoint).toBeLessThan(2e-4);
});

test("the cube's texel directions run as WebGPU samples a cube map", async () => {
    // The center of each face looks along its axis, in WebGPU's order +x, -x, +y, -y, +z, -z.
    const centers = await evaluate("vec4f(dkCubeDirection(u32(input.x), vec2u(8u, 8u), 16u), 0.0)", [
        [0, 0, 0, 0],
        [1, 0, 0, 0],
        [2, 0, 0, 0],
        [3, 0, 0, 0],
        [4, 0, 0, 0],
        [5, 0, 0, 0],
    ]);
    if (centers.length === 0) return;
    const axes = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
    ];
    centers.forEach((c, face) => {
        const axis = axes[face] as number[];
        expect(c[0] * (axis[0] as number) + c[1] * (axis[1] as number) + c[2] * (axis[2] as number)).toBeGreaterThan(
            0.99,
        );
    });
});
