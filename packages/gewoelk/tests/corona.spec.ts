import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { coronaShare, DEFAULT_CORONA, diffractionLobe } from "../src/corona.js";
import { gpuDevice } from "./gpu.js";

const DEG = Math.PI / 180;

test("the lobe holds all of the diffracted light, whatever the droplets' spread", () => {
    for (const spread of [0, DEFAULT_CORONA.spread, 0.3]) {
        // Over the plane, in rings of a thousandth of a degree out to 60°.
        let sum = 0;
        for (let angle = 0.0005; angle < 60; angle += 0.001)
            sum +=
                diffractionLobe(angle, 550, { dropletRadiusUm: 10, spread }) * 2 * Math.PI * angle * 0.001 * DEG * DEG;
        expect(sum).toBeGreaterThan(0.98);
        expect(sum).toBeLessThan(1.02);
    }
});

test("droplets of one size draw Airy's rings, as wide as the wavelength is to the droplet", () => {
    const one = { dropletRadiusUm: 10, spread: 0 };
    // Dark where J1 has its first zero, 3.8317 over the droplet's size, 1.92° in green; red's lies farther out.
    const dark = (nm: number) => (3.8317 * nm) / (2 * Math.PI * 10_000) / DEG;
    expect(dark(550)).toBeCloseTo(1.92, 2);
    expect(diffractionLobe(dark(550), 550, one) / diffractionLobe(0, 550, one)).toBeLessThan(1e-4);
    expect(diffractionLobe(dark(550), 610, one) / diffractionLobe(0, 610, one)).toBeGreaterThan(5e-3);
    // The first ring at 1.75 % of the middle, 5.1356 over the size out.
    expect(diffractionLobe((5.1356 / 3.8317) * dark(550), 550, one) / diffractionLobe(0, 550, one)).toBeCloseTo(
        0.0175,
        3,
    );
    // Half the droplet, twice the width; mixed sizes fill the dark ring in.
    const small = { dropletRadiusUm: 5, spread: 0 };
    expect(diffractionLobe(2 * dark(550), 550, small) / diffractionLobe(0, 550, small)).toBeLessThan(1e-4);
    expect(diffractionLobe(dark(550), 550, DEFAULT_CORONA) / diffractionLobe(0, 550, DEFAULT_CORONA)).toBeGreaterThan(
        5e-3,
    );
});

test("the share diffracted once is none through clear air or thick cloud, and most where three fifths come through", () => {
    expect(coronaShare(1)).toBe(0);
    expect(coronaShare(1e-4)).toBeLessThan(1e-6);
    expect(coronaShare(Math.exp(-0.5))).toBeCloseTo(0.5 / Math.E, 6);
    expect(coronaShare(0.5)).toBeLessThan(coronaShare(Math.exp(-0.5)));
    expect(coronaShare(0.7)).toBeLessThan(coronaShare(Math.exp(-0.5)));
});

test("corona.wgsl compiles on its own and agrees with its TypeScript twin", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const angles = [0, 0.5, 1.5, 1.92, 2.6, 4, 7];
    const spread = DEFAULT_CORONA.spread;
    const cases = [
        ...angles.map((angle) => `gwCoronaLobe(${angle}, 10.0, ${spread})`),
        "vec3f(gwCoronaShare(1.0), gwCoronaShare(0.6), gwCoronaShare(0.05))",
        `gwCorona(vec3f(0.0, 0.0, 1.0), vec3f(0.0, sin(0.02), cos(0.02)), vec3f(0.25), 0.6, 10.0, ${spread})`,
        `gwCoronaLobe(40.0, 10.0, ${spread})`,
    ];
    const code = `${readFileSync(new URL("../src/wgsl/corona.wgsl", import.meta.url), "utf8")}
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
    const WAVELENGTHS = [610, 550, 465];
    for (const [i, angle] of angles.entries()) {
        for (const [channel, nm] of WAVELENGTHS.entries()) {
            const expected = diffractionLobe(angle, nm);
            expect(Math.abs((values[i * 4 + channel] ?? 0) - expected)).toBeLessThan(1e-3 * expected + 1e-2);
        }
    }
    const shares = angles.length;
    expect(values[shares * 4]).toBe(0);
    expect(values[shares * 4 + 1]).toBeCloseTo(coronaShare(0.6), 5);
    expect(values[shares * 4 + 2]).toBeCloseTo(coronaShare(0.05), 5);
    // A full Moon's quarter lux through thin cloud, 1.15° out: the lobe times the share, in cd/m².
    const angle = 0.02 / DEG;
    expect((values[(shares + 1) * 4 + 1] ?? 0) / (0.25 * diffractionLobe(angle, 550) * coronaShare(0.6))).toBeCloseTo(
        1,
        2,
    );
    expect(values[(shares + 2) * 4 + 1]).toBe(0);
});
