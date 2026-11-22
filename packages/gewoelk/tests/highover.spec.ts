import { expect, test } from "@playwright/test";
import { gpuDevice } from "./gpu.js";

const SIZE = 32;

test("the voxel pass takes the layered model's sheet of high cloud, and is as before without one", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const { readTexture } = await import("@himmelszelt/dunstkreis");
    const { CLOUD_TYPES, createCloudPass, DEFAULT_CLOUD_PARAMS, DEFAULT_HIGH_SHEET } = await import("../dist/index.js");

    device.pushErrorScope("validation");
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const target = device.createTexture({ size: [SIZE, SIZE], format: "rgba16float", usage });
    // Looking straight up from the ground, where only the sheet is: the old sheets and the cloudscape off.
    const up = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0]);
    const frame = {
        ...DEFAULT_CLOUD_PARAMS,
        inverseViewProjection: up,
        sheets: [],
        cloudscape: { ...DEFAULT_CLOUD_PARAMS.cloudscape, enabled: false },
    };
    const render = async (pass: Awaited<ReturnType<typeof createCloudPass>>, high: object | null) => {
        const encoder = device.createCommandEncoder();
        pass.update({ ...frame, high: high as never }, encoder);
        pass.encode(encoder, target);
        device.queue.submit([encoder.finish()]);
        return (await readTexture(device, target)).data;
    };
    const options = { format: "rgba16float" as const, toneMap: false as const, background: false };
    const plain = await createCloudPass(device, options);
    const sheeted = await createCloudPass(device, { ...options, high: { mapSize: 256 } });
    expect(plain.high).toBeNull();
    expect(sheeted.high?.map.width).toBe(256);

    const bits = (data: Float32Array) => new Uint32Array(data.buffer);
    const none = await render(plain, null);
    // A pass with the sheet's place but no sheet in it writes what a pass without does, to the bit.
    expect(bits(await render(sheeted, null))).toEqual(bits(none));
    const veil = await render(sheeted, { ...DEFAULT_HIGH_SHEET, ...CLOUD_TYPES.high.veil });
    expect(veil.every((value) => Number.isFinite(value))).toBe(true);
    const through = Array.from({ length: SIZE * SIZE }, (_, i) => veil[i * 4 + 3] ?? 1);
    expect(through.filter((a) => a < 0.95).length).toBeGreaterThan(through.length / 10);
    expect(await device.popErrorScope()).toBeNull();
    plain.destroy();
    sheeted.destroy();
    target.destroy();
});
