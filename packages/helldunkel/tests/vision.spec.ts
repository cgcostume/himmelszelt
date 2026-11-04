import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { coneShare, nightVision } from "../src/vision.js";
import { gpuDevice } from "./gpu.js";

const wgsl = (name: string) => readFileSync(new URL(`../src/wgsl/${name}.wgsl`, import.meta.url), "utf8");
const luminance = ([r, g, b]: readonly number[]) => 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);

test("by day the eye sees colors as they are, under the Moon a bluish gray, and between it fades smoothly", () => {
    expect(coneShare(0.001)).toBe(0);
    expect(coneShare(10)).toBe(1);
    expect(coneShare(0.1)).toBeGreaterThan(0);
    expect(coneShare(0.1)).toBeLessThan(coneShare(1));
    // Photopic: unchanged, to the matrices' rounding.
    const day = nightVision([100, 50, 20]);
    for (const [c, v] of [100, 50, 20].entries()) expect(day[c] ?? 0).toBeCloseTo(v, 0);
    // Scotopic: red and green alike turn blue, and red, which the rods barely see, goes darker than green.
    const red = nightVision([0.001, 0, 0]);
    const green = nightVision([0, 0.001, 0]);
    for (const c of [red, green]) expect(c[2] ?? 0).toBeGreaterThan(c[0] ?? 0);
    expect(luminance(red) / 0.0002126).toBeLessThan(luminance(green) / 0.0007152);
    // Hue lost: two colors of the same scotopic luminance look alike.
    expect((red[2] ?? 0) / (red[0] || 1)).toBeCloseTo((green[2] ?? 0) / (green[0] || 1), 3);
    // Continuous across the mesopic range.
    for (let l = 0.005; l < 8; l *= 1.1) {
        const a = luminance(nightVision([l, l, l]));
        const b = luminance(nightVision([l * 1.001, l * 1.001, l * 1.001]));
        expect(Math.abs(b / a - 1)).toBeLessThan(0.01);
    }
});

test("vision.wgsl compiles and agrees with its TypeScript twin", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const inputs = [
        [100, 50, 20],
        [0.3, 0.2, 0.1],
        [0.001, 0.002, 0.004],
        [0, 0, 0],
    ];
    const code = `${wgsl("vision")}
@group(0) @binding(0) var<storage, read_write> data: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
    data[id.x] = vec4f(hdNightVision(data[id.x].rgb), 0.0);
}`;
    const module = device.createShaderModule({ code });
    const info = await module.getCompilationInfo();
    expect(info.messages.filter((m) => m.type === "error")).toEqual([]);
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    const buffer = device.createBuffer({
        size: inputs.length * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, new Float32Array(inputs.flatMap((v) => [...v, 0])));
    const staging = device.createBuffer({
        size: inputs.length * 16,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
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
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, inputs.length * 16);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(staging.getMappedRange().slice(0));
    inputs.forEach((v, i) => {
        const expected = nightVision(v as [number, number, number]);
        for (let c = 0; c < 3; c++) {
            const e = expected[c] ?? 0;
            expect(Math.abs((out[i * 4 + c] ?? 0) - e)).toBeLessThanOrEqual(Math.abs(e) * 1e-4 + 1e-9);
        }
    });
    buffer.destroy();
    staging.destroy();
});
