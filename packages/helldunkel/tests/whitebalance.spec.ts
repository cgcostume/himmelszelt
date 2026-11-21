import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
    applyWhiteBalance,
    D65_WHITE,
    daylightWhite,
    NO_WHITE_BALANCE,
    planckianWhite,
    whiteBalance,
    whiteFromChromaticity,
} from "../src/white.js";
import { gpuDevice } from "./gpu.js";

type Rgb = [number, number, number];
const wgsl = (name: string) => readFileSync(new URL(`../src/wgsl/${name}.wgsl`, import.meta.url), "utf8");
const luminance = ([r, g, b]: readonly number[]) =>
    0.212639006 * (r ?? 0) + 0.715168679 * (g ?? 0) + 0.0721923154 * (b ?? 0);
// The Moon above the air and the Sun above it, the site's reference whites, and some lamps and skies.
const WHITES: Rgb[] = [[1.21, 1, 0.79], [1.119, 1, 0.982], [0.3, 0.2, 0.1], planckianWhite(2856), daylightWhite(12000)];

test("the matrix shows the reference white as D65 at its own luminance", () => {
    for (const white of WHITES) {
        const balanced = applyWhiteBalance(white, whiteBalance(white));
        const y = luminance(white);
        for (const c of balanced) expect(c).toBeCloseTo(y, 9);
        expect(luminance(balanced)).toBeCloseTo(y, 9);
    }
});

test("D65 and any gray give the identity, exactly", () => {
    expect(whiteBalance(D65_WHITE)).toEqual(NO_WHITE_BALANCE);
    expect(whiteBalance([0.2, 0.2, 0.2])).toEqual(NO_WHITE_BALANCE);
    expect(applyWhiteBalance([0.1, 0.7, 3], NO_WHITE_BALANCE)).toEqual([0.1, 0.7, 3]);
    // Almost D65: almost the identity.
    const m = whiteBalance(daylightWhite(6504));
    for (const [i, v] of NO_WHITE_BALANCE.entries()) expect(Math.abs((m[i] ?? 0) - v)).toBeLessThan(1e-3);
});

test("balancing on one white and back on its image round trips", () => {
    const color: Rgb = [0.4, 0.3, 0.9];
    for (const white of WHITES) {
        const m = whiteBalance(white);
        // What the balance makes of D65 has the inverse gains, so balancing on it undoes the first, but for its luminance.
        const image = applyWhiteBalance(D65_WHITE, m);
        const back = applyWhiteBalance(applyWhiteBalance(color, m), whiteBalance(image));
        for (const [i, c] of color.entries()) expect(back[i]).toBeCloseTo(c * luminance(image), 8);
    }
    // A white from its chromaticity comes out at unit luminance, and its balance shows it as D65.
    const white = whiteFromChromaticity([0.35, 0.37]);
    expect(luminance(white)).toBeCloseTo(1, 9);
    for (const c of applyWhiteBalance(white, whiteBalance(white))) expect(c).toBeCloseTo(1, 9);
});

test("the loci: D65 at 6504 K on the daylight locus, illuminant A at 2856 K on the Planckian, warm whites red", () => {
    for (const c of daylightWhite(6504)) expect(c).toBeCloseTo(1, 2);
    // Illuminant A, x 0.44758, y 0.40745 (CIE 15:2018).
    const a = whiteFromChromaticity([0.44758, 0.40745]);
    for (const [i, c] of planckianWhite(2856).entries()) expect(Math.abs(c - (a[i] ?? 0))).toBeLessThan(0.01);
    for (const k of [2000, 3000, 4000, 5000, 6000]) {
        const w = planckianWhite(k);
        expect(luminance(w)).toBeCloseTo(1, 9);
        expect(w[0]).toBeGreaterThan(w[2]);
    }
    expect(daylightWhite(20000)[2]).toBeGreaterThan(daylightWhite(20000)[0]);
});

test("whitebalance.wgsl compiles and agrees with its TypeScript twin", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const colors: Rgb[] = [
        [0.4, 0.3, 0.9],
        [1, 1, 1],
        [100, 50, 20],
        [0, 0, 0],
    ];
    // Per case: the white in, the color in; out, the matrix from hdWhiteBalanceFor applied to the color, and the white.
    const cases = WHITES.flatMap((white) => colors.map((color) => [white, color] as const));
    const code = `${wgsl("whitebalance")}
@group(0) @binding(0) var<storage, read_write> data: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
    let balance = hdWhiteBalanceFor(data[2u * id.x].rgb);
    data[2u * id.x] = vec4f(hdWhiteBalance(data[2u * id.x].rgb, balance), 0.0);
    data[2u * id.x + 1u] = vec4f(hdWhiteBalance(data[2u * id.x + 1u].rgb, balance), 0.0);
}`;
    const module = device.createShaderModule({ code });
    const info = await module.getCompilationInfo();
    expect(info.messages.filter((m) => m.type === "error")).toEqual([]);
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    const size = cases.length * 32;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const buffer = device.createBuffer({ size, usage });
    device.queue.writeBuffer(buffer, 0, new Float32Array(cases.flatMap(([w, c]) => [...w, 0, ...c, 0])));
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
    pass.dispatchWorkgroups(cases.length);
    pass.end();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(staging.getMappedRange().slice(0));
    cases.forEach(([white, color], i) => {
        const m = whiteBalance(white);
        for (const [k, expected] of [applyWhiteBalance(white, m), applyWhiteBalance(color, m)].entries()) {
            for (let c = 0; c < 3; c++) {
                const e = expected[c] ?? 0;
                expect(Math.abs((out[i * 8 + k * 4 + c] ?? 0) - e)).toBeLessThanOrEqual(Math.max(...color, 1) * 2e-5);
            }
        }
    });
    buffer.destroy();
    staging.destroy();
});
