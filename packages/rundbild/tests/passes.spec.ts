import { expect, test } from "@playwright/test";
import { decodeRgbe, encodeRgbe } from "../src/rgbe.js";
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

test("the ground's directions compile", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    expect(await compileWgsl(device, wgslSource("ground"))).toEqual([]);
});

test("a Radiance HDR file holds a shared exponent per pixel, from the top row down", () => {
    const bytes = encodeRgbe(new Float32Array([1, 0.5, 0.25, 1, 0, 0, 0, 1]), 2, 1);
    const header = "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n";
    expect(new TextDecoder().decode(bytes.subarray(0, header.length))).toBe(header);
    // 1 = 0.5 * 2^1: the mantissas times 256 over 2^1, the exponent offset by 128.
    expect([...bytes.subarray(header.length)]).toEqual([128, 64, 32, 129, 0, 0, 0, 0]);
});

test("a Radiance HDR file reads back within its precision, flat and run-length encoded", () => {
    const flat = decodeRgbe(encodeRgbe(new Float32Array([1, 0.5, 0.25, 1, 0, 0, 0, 1]), 2, 1));
    expect([flat.width, flat.height]).toEqual([2, 1]);
    [1, 0.5, 0.25, 1, 0, 0, 0, 1].forEach((v, i) => {
        expect(flat.pixels[i]).toBeCloseTo(v, 1);
    });
    // Eight pixels of one scanline: a run of eight per channel but for the exponent's dump of eight.
    const header = new TextEncoder().encode("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n");
    const line = [2, 2, 0, 8, 136, 128, 136, 64, 136, 32, 8, 129, 129, 129, 129, 129, 129, 129, 129];
    const rle = decodeRgbe(new Uint8Array([...header, ...line]));
    expect(rle.pixels[28]).toBeCloseTo((128.5 * 2) / 256, 5);
    expect(rle.pixels[29]).toBeCloseTo((64.5 * 2) / 256, 5);
    expect(rle.pixels[30]).toBeCloseTo((32.5 * 2) / 256, 5);
});
