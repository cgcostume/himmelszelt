import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { cloudOutput } from "../src/wgsl/output.js";
import { compileWgsl, gpuDevice } from "./gpu.js";

const fragment = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the layered composition compiles from its declared fragments", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const helldunkel = "../../helldunkel/src/wgsl";
    const code = [
        cloudOutput("rgba8unorm"),
        fragment("../src/wgsl/params.wgsl"),
        fragment("../../dunstkreis/src/wgsl/camera.wgsl"),
        fragment("../src/wgsl/corona.wgsl"),
        fragment(`${helldunkel}/whitebalance.wgsl`),
        fragment(`${helldunkel}/tonemap.wgsl`),
        fragment("../src/wgsl/layered.comp.wgsl"),
    ].join("\n");
    const errors = await compileWgsl(device, code);
    expect(errors, errors.join("\n")).toEqual([]);
});

test("a weather by its name renders: clouds over the background, nothing where there are none", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const { readTexture } = await import("@himmelszelt/dunstkreis");
    const { createLayeredCloudPass } = await import("../dist/index.js");

    device.pushErrorScope("validation");
    const size = 48;
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const target = device.createTexture({ size: [size, size], format: "rgba16float", usage });
    const clouds = await createLayeredCloudPass(device, {
        format: "rgba16float",
        quality: "low",
        toneMap: false,
        background: false,
    });
    const render = (weather: "towering" | "clear", coverage = 1) => {
        const encoder = device.createCommandEncoder();
        const baked = clouds.update({ weather, coverage }, encoder);
        clouds.encode(encoder, target);
        device.queue.submit([encoder.finish()]);
        return baked;
    };
    expect(render("towering")).toBe(true);
    expect(clouds.sky.deep.kind).toBe("towers");
    expect(clouds.sky.deep.coverage).toBeCloseTo(0.3, 6);
    const { data } = await readTexture(device, target);
    expect(data.every((value, i) => Number.isFinite(value) && value >= 0 && (i % 4 < 3 || value <= 1))).toBe(true);
    // The sky above the horizon is the upper half: clouds hide a good share of it.
    const through = Array.from({ length: (size * size) / 2 }, (_, i) => data[i * 4 + 3] ?? 1);
    expect(through.filter((a) => a < 0.5).length).toBeGreaterThan(through.length / 10);

    // With the coverage turned to nothing, no layer and no sheet is there, and all of the background is let through.
    render("clear", 0);
    expect(clouds.sky.high.coverage).toBe(0);
    const empty = await readTexture(device, target);
    expect(empty.data.every((value, i) => value === (i % 4 < 3 ? 0 : 1))).toBe(true);
    expect(await device.popErrorScope()).toBeNull();
    clouds.destroy();
    target.destroy();
});

test("the box filter brings the marched layers to the target's size with less grain and as much cloud", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const { readTexture } = await import("@himmelszelt/dunstkreis");
    const { createLayeredCloudPass } = await import("../dist/index.js");

    device.pushErrorScope("validation");
    const size = 96;
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const target = device.createTexture({ size: [size, size], format: "rgba16float", usage });
    // Marched at half the target's size, where a pixel sits between the layers' texels.
    const clouds = await createLayeredCloudPass(device, {
        format: "rgba16float",
        quality: { scale: 0.5, mapSize: 128, highMapSize: 256 },
        toneMap: false,
        background: false,
    });
    const through = async (boxFilter: boolean) => {
        const encoder = device.createCommandEncoder();
        clouds.update({ weather: "towering", boxFilter }, encoder);
        clouds.encode(encoder, target);
        device.queue.submit([encoder.finish()]);
        const { data } = await readTexture(device, target);
        expect(data.every((value, i) => Number.isFinite(value) && value >= 0 && (i % 4 < 3 || value <= 1 + 1e-3))).toBe(
            true,
        );
        return Array.from({ length: size * size }, (_, i) => data[i * 4 + 3] ?? 1);
    };
    const mean = (values: number[]) => values.reduce((sum, x) => sum + x, 0) / values.length;
    // How rough a picture is: the mean step from a pixel to the next in its row.
    const rough = (values: number[]) => mean(values.map((x, i) => (i % size ? Math.abs(x - (values[i - 1] ?? x)) : 0)));
    const taps = await through(false);
    const box = await through(true);
    expect(await device.popErrorScope()).toBeNull();
    expect(Math.abs(mean(box) - mean(taps))).toBeLessThan(0.01);
    expect(rough(box)).toBeLessThan(rough(taps));
    clouds.destroy();
    target.destroy();
});
