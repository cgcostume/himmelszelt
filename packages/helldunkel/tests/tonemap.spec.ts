import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { gpuDevice } from "./gpu.js";

const wgsl = (name: string) => readFileSync(new URL(`../src/wgsl/${name}.wgsl`, import.meta.url), "utf8");

/** Each input through `hdToneMapNeutral`, still sRGB-encoded. */
async function neutral(device: GPUDevice, inputs: number[][]) {
    const code = `${wgsl("tonemap")}
@group(0) @binding(0) var<storage, read_write> data: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
    data[id.x] = vec4f(hdToneMapNeutral(data[id.x].rgb), 0.0);
}`;
    const module = device.createShaderModule({ code });
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    const size = inputs.length * 16;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const buffer = device.createBuffer({ size, usage });
    device.queue.writeBuffer(buffer, 0, new Float32Array(inputs.flatMap((v) => [...v, 0])));
    const staging = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
        0,
        device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer } }],
        }),
    );
    pass.dispatchWorkgroups(inputs.length);
    pass.end();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    buffer.destroy();
    staging.destroy();
    return inputs.map((_, i) => [out[i * 4] ?? 0, out[i * 4 + 1] ?? 0, out[i * 4 + 2] ?? 0]);
}

test("Neutral never darkens a channel where light is added, and keeps grays as Khronos' curve has them", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    // A dim blue night sky, then a star's red halo over it: the sky's blue must not drop.
    const [r, g, b] = [0.003, 0.008, 0.02];
    const [under, over] = await neutral(device, [
        [r, g, b],
        [r + 0.02, g + 0.008, b],
    ]);
    for (let c = 0; c < 3; c++) expect(over?.[c] ?? 0).toBeGreaterThanOrEqual((under?.[c] ?? 0) - 1e-6);
    // Grays: Khronos' x - 6.25 x² offset below 0.08 and 0.04 above, after the middle gray gain, then sRGB.
    const srgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
    const grays = [0.01, 0.03, 0.2];
    const out = await neutral(
        device,
        grays.map((g) => [g, g, g]),
    );
    grays.forEach((g, i) => {
        const x = g * 1.728;
        const expected = x < 0.08 ? 6.25 * x * x : x - 0.04;
        for (let c = 0; c < 3; c++) expect(out[i]?.[c] ?? 0).toBeCloseTo(srgb(expected), 4);
    });
    // Hue kept in the blacks: a dark orange keeps its ratio of red to green.
    const [orange] = await neutral(device, [[0.03, 0.015, 0]]);
    const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    expect(linear(orange?.[0] ?? 0) / linear(orange?.[1] ?? 1)).toBeCloseTo(2, 2);
});
