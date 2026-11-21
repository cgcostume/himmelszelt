import { expect, test } from "@playwright/test";
// From the built package: the passes import their `.wgsl` files, which only the bundler inlines; `pnpm test` builds first.
import { createSkyPass, precomputeAtmosphere, readTexture } from "../dist/index.js";
import { gpuDevice } from "./gpu.js";

const SIZE = 64;
const DEG = Math.PI / 180;

/** The tone mapped frame of a sky pass at dusk, dithered or not, by the noise given or the pass' own. */
async function frame(device: GPUDevice, dither: boolean, blueNoise?: GPUTexture) {
    const luts = await precomputeAtmosphere(device);
    const target = device.createTexture({
        size: [SIZE, SIZE],
        format: "rgba32float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const sky = await createSkyPass(device, {
        luts,
        format: "rgba32float",
        dither,
        ...(blueNoise ? { blueNoise } : {}),
    });
    sky.update({ sunDirection: [0, Math.cos(-4 * DEG), Math.sin(-4 * DEG)], observerHeightM: 100, ev100: 2 });
    const encoder = device.createCommandEncoder();
    sky.encode(encoder, target);
    device.queue.submit([encoder.finish()]);
    const { data } = await readTexture(device, target, 0);
    sky.destroy();
    target.destroy();
    luts.destroy();
    return data;
}

test("without dither the noise is never read; with it, no channel moves by a step or more", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const white = device.createTexture({
        size: [64, 64],
        format: "r8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: white }, new Uint8Array(64 * 64).fill(255), { bytesPerRow: 64 }, [64, 64]);
    const plain = await frame(device, false);
    expect(new Uint32Array((await frame(device, false, white)).buffer)).toEqual(new Uint32Array(plain.buffer));
    const dithered = await frame(device, true);
    let moved = 0;
    for (let i = 0; i < plain.length; ++i) {
        const step = Math.abs((dithered[i] ?? 0) - (plain[i] ?? 0)) * 255;
        expect(step).toBeLessThan(1);
        if (step > 0.25) ++moved;
    }
    expect(moved).toBeGreaterThan(plain.length / 4);
    white.destroy();
});
