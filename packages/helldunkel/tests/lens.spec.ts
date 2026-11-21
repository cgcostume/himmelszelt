import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { starburstSpikes } from "../src/lens.js";
import { gpuDevice } from "./gpu.js";

const wgsl = (name: string) => readFileSync(new URL(`../src/wgsl/${name}.wgsl`, import.meta.url), "utf8");
const DEG = Math.PI / 180;

test("an even count of blades draws as many spikes, an odd one twice as many", () => {
    expect([5, 6, 7, 8, 9].map(starburstSpikes)).toEqual([10, 6, 14, 8, 18]);
});

test("lens.wgsl compiles on its own, and its starburst is the one described", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    // Along the first spike of six blades, 10° from the horizontal, 2° and 4° out, and between two spikes.
    const radius = 0.2665 * DEG;
    const at = (degrees: number, turn: number) =>
        `vec2f(${degrees * DEG * Math.cos(turn * DEG)}, ${degrees * DEG * Math.sin(turn * DEG)})`;
    const cases = [
        `hdStarburst(${at(2, 10)}, ${radius}, 6u)`,
        `hdStarburst(${at(4, 10)}, ${radius}, 6u)`,
        `hdStarburst(${at(2, 40)}, ${radius}, 6u)`,
        `hdStarburst(${at(2, 70)}, ${radius}, 6u)`,
        // Seven blades draw a spike every 180° / 7 from the first: there, and where six blades have none.
        `hdStarburst(${at(2, 10 + 180 / 7)}, ${radius}, 7u)`,
        `hdStarburst(${at(2, 10 + 180 / 7)}, ${radius}, 6u)`,
        `hdStarburst(${at(2, 10)}, ${radius}, 0u)`,
    ];
    const code = `${wgsl("lens")}
@group(0) @binding(0) var<storage, read_write> results: array<vec4f, ${cases.length}>;
@compute @workgroup_size(1)
fn main() {
${cases.map((expression, i) => `    results[${i}] = vec4f(${expression}, 0.0);`).join("\n")}
}`;
    const module = device.createShaderModule({ code });
    const info = await module.getCompilationInfo();
    expect(info.messages.filter((m) => m.type === "error")).toEqual([]);
    const buffer = device.createBuffer({
        size: cases.length * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const staging = device.createBuffer({
        size: cases.length * 16,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
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
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, cases.length * 16);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(staging.getMappedRange().slice(0));
    staging.destroy();
    buffer.destroy();
    const green = (i: number) => values[i * 4 + 1] ?? Number.NaN;
    // On a spike, falling with the square of the angle from well beyond the disc; a third of the light per line.
    const sigma = 0.7 * radius;
    const onSpike = (degrees: number) =>
        1.1e-4 / (3 * Math.sqrt(2 * Math.PI) * sigma * Math.PI * ((degrees * DEG) ** 2 + radius ** 2));
    expect(green(0) / onSpike(2)).toBeCloseTo(1, 2);
    expect(green(1) / onSpike(4)).toBeCloseTo(1, 2);
    // Between two spikes nothing to speak of, and on the next one, 60° on, the same again.
    expect(green(2)).toBeLessThan(1e-3 * green(0));
    expect(green(3) / green(0)).toBeCloseTo(1, 3);
    // Red reaches farther than blue, by the wavelengths.
    expect((values[0] ?? 0) / (values[2] ?? 1)).toBeCloseTo(1.109 / 0.845, 3);
    // Seven blades share the light among seven lines, where six have none; no blades, no starburst.
    expect(green(4) / green(0)).toBeCloseTo(3 / 7, 2);
    expect(green(5)).toBeLessThan(1e-3 * green(0));
    expect(green(6)).toBe(0);
});
