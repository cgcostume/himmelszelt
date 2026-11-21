import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { BLUE_NOISE_SIZE, blueNoiseData, blueNoiseTexture } from "../src/bluenoise.js";
import { gpuDevice } from "./gpu.js";

const tonemap = readFileSync(new URL("../src/wgsl/tonemap.wgsl", import.meta.url), "utf8");

test("the blue noise holds every rank equally often, and any 4x4 block's mean stays near the middle", () => {
    const data = blueNoiseData();
    expect(data.length).toBe(BLUE_NOISE_SIZE * BLUE_NOISE_SIZE);
    const counts = new Array<number>(256).fill(0);
    for (const value of data) counts[value] = (counts[value] ?? 0) + 1;
    expect(counts.every((n) => n === 16)).toBe(true);
    // White noise strays some 70 from 127.5 in its worst block; blue noise holds back the low frequencies.
    let worst = 0;
    for (let by = 0; by < 16; ++by) {
        for (let bx = 0; bx < 16; ++bx) {
            let sum = 0;
            for (let y = 0; y < 4; ++y) for (let x = 0; x < 4; ++x) sum += data[(by * 4 + y) * 64 + bx * 4 + x] ?? 0;
            worst = Math.max(worst, Math.abs(sum / 16 - 127.5));
        }
    }
    expect(worst).toBeLessThan(30);
});

test("hdDitherBlue keeps a flat gray's mean and moves no pixel two steps or more", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    expect(blueNoiseTexture(device)).toBe(blueNoiseTexture(device));
    const levels = [0.0021, 0.013, 0.25, 0.5017, 0.9];
    const pixels = BLUE_NOISE_SIZE * BLUE_NOISE_SIZE;
    const code = `${tonemap}
@group(0) @binding(0) var noise: texture_2d<f32>;
@group(0) @binding(1) var<storage, read> grays: array<f32>;
@group(0) @binding(2) var<storage, read_write> data: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
    let gray = vec3f(grays[id.y]);
    data[id.y * ${pixels}u + id.x] = round(hdDitherBlue(gray, vec2u(id.x % 64u, id.x / 64u), 255.0, noise).r * 255.0);
}`;
    const module = device.createShaderModule({ code });
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const grays = device.createBuffer({ size: levels.length * 4, usage });
    device.queue.writeBuffer(grays, 0, new Float32Array(levels));
    const size = levels.length * pixels * 4;
    const data = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const staging = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
        0,
        device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: blueNoiseTexture(device).createView() },
                { binding: 1, resource: { buffer: grays } },
                { binding: 2, resource: { buffer: data } },
            ],
        }),
    );
    pass.dispatchWorkgroups(pixels / 64, levels.length);
    pass.end();
    encoder.copyBufferToBuffer(data, 0, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    for (const [i, gray] of levels.entries()) {
        const values = out.subarray(i * pixels, (i + 1) * pixels);
        const target = gray * 255;
        expect(values.every((v) => Math.abs(v - target) < 2)).toBe(true);
        expect(values.reduce((a, v) => a + v, 0) / pixels).toBeCloseTo(target, 1);
    }
    grays.destroy();
    data.destroy();
    staging.destroy();
});
