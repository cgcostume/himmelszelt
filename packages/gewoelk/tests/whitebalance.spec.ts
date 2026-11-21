import { expect, test } from "@playwright/test";
import { gpuDevice } from "./gpu.js";

const SIZE = 32;
const DEG = Math.PI / 180;

/** Composed frames over dunstkreis' sky in cd/m², each with `toneMap` and its white balance, or none given. */
async function frames(runs: readonly { toneMap: "neutral" | false; whiteBalance?: readonly number[] }[]) {
    const device = await gpuDevice();
    if (!device) return [];
    const { createSkyPass, precomputeAtmosphere, readTexture } = await import("@himmelszelt/dunstkreis");
    const { createCloudPass, DEFAULT_CLOUD_PARAMS } = await import("../dist/index.js");
    const luts = await precomputeAtmosphere(device);
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const background = device.createTexture({ size: [SIZE, SIZE], format: "rgba16float", usage });
    const target = device.createTexture({ size: [SIZE, SIZE], format: "rgba16float", usage });
    // A sun 20 degrees up in the north, looking at it over the clouds from 1 km.
    const frame = {
        sunDirection: [0, Math.cos(20 * DEG), Math.sin(20 * DEG)] as [number, number, number],
        observerHeightM: 1000,
        inverseViewProjection: new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    };
    const sky = await createSkyPass(device, { luts, format: "rgba16float", toneMap: false });
    const out: Float32Array[] = [];
    for (const { toneMap, whiteBalance } of runs) {
        const clouds = await createCloudPass(device, { format: "rgba16float", toneMap });
        const encoder = device.createCommandEncoder();
        sky.update({ ...frame, ev100: -Math.log2(1.2) }, encoder);
        sky.encode(encoder, background);
        const balance = whiteBalance ? { whiteBalance: whiteBalance as never } : {};
        clouds.update({ ...DEFAULT_CLOUD_PARAMS, ...frame, ev100: 12, ...balance }, encoder);
        clouds.encode(encoder, target, { background });
        device.queue.submit([encoder.finish()]);
        out.push((await readTexture(device, target)).data);
        clouds.destroy();
    }
    sky.destroy();
    background.destroy();
    target.destroy();
    luts.destroy();
    return out;
}

test("without a white balance, or with the identity, the composed frame is the same to the bit", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const [none, same, linear, linearSame] = await frames([
        { toneMap: "neutral" },
        { toneMap: "neutral", whiteBalance: identity },
        { toneMap: false },
        { toneMap: false, whiteBalance: identity },
    ]);
    // Half floats read back as floats, compared by their bits.
    const bits = (data?: Float32Array) => new Uint32Array(data?.buffer ?? new ArrayBuffer(0));
    expect(none?.length).toBe(SIZE * SIZE * 4);
    expect(bits(same)).toEqual(bits(none));
    expect(bits(linearSame)).toEqual(bits(linear));
});

test("a white balance turns the composed light by its matrix, clouds and background alike", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    const { whiteBalance } = await import("@himmelszelt/helldunkel");
    const m = whiteBalance([1.21, 1, 0.79]);
    const [plain, balanced] = await frames([{ toneMap: false }, { toneMap: false, whiteBalance: m }]);
    if (!plain || !balanced) return;
    for (let i = 0; i < SIZE * SIZE; ++i) {
        const [r, g, b] = [0, 1, 2].map((c) => plain[i * 4 + c] ?? 0) as [number, number, number];
        const expected = [
            m[0] * r + m[3] * g + m[6] * b,
            m[1] * r + m[4] * g + m[7] * b,
            m[2] * r + m[5] * g + m[8] * b,
        ];
        // Within a few half float steps of the pixel's brightest channel, rounded once before and once after.
        const step = Math.max(r, g, b) * 3e-3 + 1e-6;
        for (let c = 0; c < 3; ++c)
            expect(Math.abs((balanced[i * 4 + c] ?? 0) - (expected[c] ?? 0))).toBeLessThanOrEqual(step);
    }
});
