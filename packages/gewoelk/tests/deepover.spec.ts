import { expect, test } from "@playwright/test";
import { gpuDevice } from "./gpu.js";

const SIZE = 32;

test("the voxel pass takes the layered model's deep layer, and is as before without one", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const { readTexture } = await import("@himmelszelt/dunstkreis");
    const { CLOUD_TYPES, createCloudPass, DEFAULT_CLOUD_PARAMS, DEFAULT_DEEP_LAYER } = await import("../dist/index.js");

    device.pushErrorScope("validation");
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const target = device.createTexture({ size: [SIZE, SIZE], format: "rgba16float", usage });
    // Looking north along the horizon from the ground, at a front that stands there, 12 km on.
    const front = { ...DEFAULT_DEEP_LAYER, ...CLOUD_TYPES.deep.frontAhead, frontBearing: 0 };
    const render = async (
        pass: Awaited<ReturnType<typeof createCloudPass>>,
        deep: object | null,
        cloudscape: boolean,
    ) => {
        const encoder = device.createCommandEncoder();
        const enabled = { ...DEFAULT_CLOUD_PARAMS.cloudscape, enabled: cloudscape };
        pass.update({ ...DEFAULT_CLOUD_PARAMS, sheets: [], cloudscape: enabled, deep: deep as never }, encoder);
        pass.encode(encoder, target);
        device.queue.submit([encoder.finish()]);
        return (await readTexture(device, target)).data;
    };
    const options = { format: "rgba16float" as const, toneMap: false as const, background: false };
    const plain = await createCloudPass(device, options);
    const deepened = await createCloudPass(device, { ...options, deep: { mapSize: 128, scale: 1 } });
    expect(plain.deep).toBeNull();
    expect(deepened.deep?.maps.width).toBe(128);

    const bits = (data: Float32Array) => new Uint32Array(data.buffer);
    // A pass with the deep layer's place but no layer in it writes what a pass without does, to the bit.
    expect(bits(await render(deepened, null, true))).toEqual(bits(await render(plain, null, true)));
    const through = (data: Float32Array) => Array.from({ length: SIZE * SIZE }, (_, i) => data[i * 4 + 3] ?? 1);
    const low = through(await render(deepened, null, true));
    const alone = await render(deepened, front, false);
    expect(alone.every((value) => Number.isFinite(value))).toBe(true);
    // The front fills a good share of the sky, the upper half of the frame.
    const wall = through(alone);
    expect(wall.slice(0, wall.length / 2).filter((a) => a < 0.5).length).toBeGreaterThan(wall.length / 8);
    // Both together let through no more than the front alone, and no less than what each lets through of what the
    // other does: the cloudscape's clouds inside the front's are left out, the front draws what is there.
    const both = through(await render(deepened, front, true));
    expect(both.every((a, i) => a < (wall[i] ?? 1) + 0.02 && a > (low[i] ?? 1) * (wall[i] ?? 1) - 0.02)).toBe(true);
    expect(await device.popErrorScope()).toBeNull();
    plain.destroy();
    deepened.destroy();
    target.destroy();
});
