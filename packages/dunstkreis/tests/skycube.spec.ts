import { expect, test } from "@playwright/test";
// From the built package: the passes import their `.wgsl` files, which only the bundler inlines; `pnpm test` builds first.
import { createSkyPass, precomputeAtmosphere, readTexture } from "../dist/index.js";
import { gpuDevice } from "./gpu.js";

// The sky cube map's first row below the horizon, where the sky by the visible horizon, lower than the geometric one
// by 0.48° at 227 m, and the far ground meet within its texels: a test pattern for how a texel's rays are spread and
// how the horizon within them is taken, which every face must agree on.

const SIZE = 16;
// dkCubePointAt: the point on the cube a face's s and t stand for, in ENU.
const point = (face: number, s: number, t: number) =>
    [
        [1, -t, -s],
        [-1, -t, s],
        [s, 1, t],
        [s, -1, -t],
        [s, -t, 1],
        [-s, -t, -1],
    ][face] as [number, number, number];

/** The side faces' texels whose center lies in the row just below the horizon: azimuth in degrees and luminance. */
async function horizonRow(sunDirection: [number, number, number]) {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return [];
    const luts = await precomputeAtmosphere(device);
    const sky = await createSkyPass(device, { luts, format: "rgba16float", toneMap: false });
    sky.update({
        sunDirection,
        sunAngularDiameter: 0.533,
        observerHeightM: 227,
        inverseViewProjection: new Float32Array(16),
        projectionDistance: 0,
        ev100: 0,
    });
    const pass = await sky.createCubePass({ format: "rgba32float", samples: 8 });
    const cube = device.createTexture({
        size: [SIZE, SIZE, 6],
        format: "rgba32float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const encoder = device.createCommandEncoder();
    pass.encode(encoder, cube);
    device.queue.submit([encoder.finish()]);
    const row: [number, number][] = [];
    for (const face of [0, 1, 2, 3]) {
        const { data } = await readTexture(device, cube, face);
        for (let y = 0; y < SIZE; ++y) {
            for (let x = 0; x < SIZE; ++x) {
                const [px, py, pz] = point(face, ((x + 0.5) / SIZE) * 2 - 1, ((y + 0.5) / SIZE) * 2 - 1);
                const z = pz / Math.hypot(px, py, pz);
                if (z >= 0 || z < -1 / SIZE) continue;
                const i = (y * SIZE + x) * 4;
                const luminance = 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
                row.push([(Math.atan2(px, py) * 180) / Math.PI, luminance]);
            }
        }
    }
    cube.destroy();
    sky.destroy();
    luts.destroy();
    return row.sort((a, b) => a[0] - b[0]);
}

test("on a sky the same all round, every side face holds the same first row below the horizon", async () => {
    const row = await horizonRow([0, 0, 1]);
    if (row.length === 0) return;
    expect(row.length).toBe(4 * SIZE);
    // Each face's row, from its left edge, as the same azimuth within the face.
    const faces = [0, 1, 2, 3].map((k) => row.slice(k * SIZE, (k + 1) * SIZE).map(([, luminance]) => luminance));
    for (const face of faces.slice(1)) {
        face.forEach((luminance, i) => {
            expect(Math.abs(luminance - (faces[0]?.[i] ?? 0)) / luminance).toBeLessThan(1e-3);
        });
    }
});

test("by a low Sun, the first row below the horizon runs on across the faces' edges without a step", async () => {
    const sun = (3 * Math.PI) / 180;
    const row = await horizonRow([Math.cos(sun), 0, Math.sin(sun)]);
    if (row.length === 0) return;
    // Across an edge, neighbors differ no more than the steepest step between neighbors within a face, give or take.
    const steps = row.map(([, luminance], i) => {
        const [, next] = row[(i + 1) % row.length] as [number, number];
        return Math.abs(next - luminance) / Math.max(next, luminance);
    });
    const within = Math.max(...steps.filter((_, i) => (i + 1) % SIZE !== 0));
    const across = Math.max(...steps.filter((_, i) => (i + 1) % SIZE === 0));
    expect(across).toBeLessThan(within);
});
