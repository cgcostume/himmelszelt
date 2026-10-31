import { expect, test } from "@playwright/test";
import { encodeRgbe } from "../src/rgbe.js";
import { workgroupSum } from "../src/wgsl/reduce.js";
import { compileWgsl, gpuDevice, wgslSource } from "./gpu.js";

const OUTPUT = "@group(1) @binding(0) var rbOutput: texture_storage_2d<rgba16float, write>;";

test("the irradiance pass compiles from its declared fragments", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const code = [workgroupSum(64, false), ...["cube", "spiral", "irradiance"].map(wgslSource)].join("\n");
    expect(await compileWgsl(device, code)).toEqual([]);
});

test("the panorama pass compiles from its declared fragments", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const code = [wgslSource("cube"), wgslSource("panorama"), OUTPUT, wgslSource("panorama.comp")].join("\n");
    expect(await compileWgsl(device, code)).toEqual([]);
});

test("a Radiance HDR file holds a shared exponent per pixel, from the top row down", () => {
    const bytes = encodeRgbe(new Float32Array([1, 0.5, 0.25, 1, 0, 0, 0, 1]), 2, 1);
    const header = "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n";
    expect(new TextDecoder().decode(bytes.subarray(0, header.length))).toBe(header);
    // 1 = 0.5 * 2^1: the mantissas times 256 over 2^1, the exponent offset by 128.
    expect([...bytes.subarray(header.length)]).toEqual([128, 64, 32, 129, 0, 0, 0, 0]);
});
