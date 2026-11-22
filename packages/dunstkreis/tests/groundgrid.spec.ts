import { expect, test } from "@playwright/test";
// From the built package: the pass imports its `.wgsl` files, which only the bundler inlines; `pnpm test` builds first.
import {
    createGroundGridPass,
    GROUND_GRID_STRENGTH,
    type GroundGridView,
    groundGridOffsets,
    readTexture,
} from "../dist/index.js";
import { gpuDevice } from "./gpu.js";

const DEG = Math.PI / 180;
const SIZE = 96;

/** A camera looking north at `altitude` degrees, 60 degrees across, as the sky pass takes it. */
function camera(altitude: number) {
    const a = altitude * DEG;
    const t = Math.tan(30 * DEG);
    return new Float32Array([
        t,
        0,
        0,
        0,
        0,
        -Math.sin(a) * t,
        Math.cos(a) * t,
        0,
        0,
        0,
        0,
        1,
        0,
        Math.cos(a),
        Math.sin(a),
        0,
    ]);
}

/** A sky of 1 everywhere through the pass, seen from 2 m looking 10 degrees down, row major. */
async function gridded(device: GPUDevice, view: Partial<GroundGridView> = {}) {
    const sky = device.createTexture({
        size: [SIZE, SIZE],
        format: "rgba32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: sky }, new Float32Array(SIZE * SIZE * 4).fill(1), { bytesPerRow: SIZE * 16 }, [
        SIZE,
        SIZE,
    ]);
    const into = device.createTexture({
        size: [SIZE, SIZE],
        format: "rgba32float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const pass = createGroundGridPass(device);
    const encoder = device.createCommandEncoder();
    const drawn = pass.encode(
        encoder,
        sky,
        {
            inverseViewProjection: camera(-10),
            projectionDistance: 0,
            heightM: 2,
            radiusKm: 6360,
            flown: { east: 0, north: 0 },
            ...view,
        },
        into,
    );
    device.queue.submit([encoder.finish()]);
    const { data } = await readTexture(device, drawn);
    sky.destroy();
    into.destroy();
    pass.destroy();
    return data;
}

const row = (data: Float32Array, y: number) => data.subarray(y * SIZE * 4, (y + 1) * SIZE * 4);

test("the offsets are each level's share of its cell, the coarsest first", () => {
    const offsets = groundGridOffsets({ east: 12.3456, north: -0.25 });
    expect(offsets).toHaveLength(16);
    expect(offsets[0]).toBeCloseTo(0.23456, 9);
    expect(offsets[1]).toBeCloseTo(0.975, 9);
    expect(offsets[2]).toBeCloseTo(0.3456, 9);
    expect(offsets[3]).toBeCloseTo(0.75, 9);
    expect(groundGridOffsets({ east: 10, north: 0 }).every((v) => Math.abs(v) < 1e-9 || Math.abs(v - 1) < 1e-9)).toBe(
        true,
    );
});

test("the grid brightens the ground along its lines and leaves the sky alone", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const data = await gridded(device);
    // The top rows look 20 degrees up and more, the bottom 40 degrees down.
    expect(row(data, 0).every((v) => v === 1)).toBe(true);
    const ground = row(data, SIZE - 1);
    const lit = ground.filter((_, i) => i % 4 === 0);
    expect(Math.max(...lit)).toBeGreaterThan(1.1);
    expect(Math.max(...lit)).toBeLessThanOrEqual(1 + GROUND_GRID_STRENGTH + 1e-6);
    expect(Math.min(...lit)).toBeGreaterThanOrEqual(1);
    // Alpha comes through.
    expect(ground.filter((_, i) => i % 4 === 3).every((v) => v === 1)).toBe(true);
});

test("flying half a cell moves the lines, and a whole 10 km brings them back", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const still = await gridded(device);
    const half = await gridded(device, { flown: { east: 0.0005, north: 0.0005 } });
    const whole = await gridded(device, { flown: { east: 10, north: -20 } });
    const differ = (a: Float32Array, b: Float32Array) => a.reduce((s, v, i) => s + Math.abs(v - (b[i] as number)), 0);
    expect(differ(still, half)).toBeGreaterThan(1);
    expect(differ(still, whole)).toBeLessThan(1e-3);
    expect(await gridded(device, { strength: 0 })).toEqual(new Float32Array(SIZE * SIZE * 4).fill(1));
});
