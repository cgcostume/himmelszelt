import { expect, test } from "@playwright/test";
// From the built package: the passes import their `.wgsl` files, which only the bundler inlines; `pnpm test` builds first.
import {
    type AutoExposureKey,
    autoExposureTint,
    createSkyPass,
    NO_WHITE_BALANCE,
    precomputeAtmosphere,
    readTexture,
    type ToneCurve,
    type WhiteBalance,
    whiteBalance,
} from "../dist/index.js";
import { gpuDevice } from "./gpu.js";

const SIZE = 32;
const DEG = Math.PI / 180;
// A low Sun to the north, in the default view's middle, so the frame holds sky, ground, aureole and disc.
const SUN: [number, number, number] = [0, Math.cos(5 * DEG), Math.sin(5 * DEG)];

/** The frame of a sky pass with `toneMap` and `whiteBalance`, or none given, read back as it was written. */
async function frame(toneMap: ToneCurve | false, balance?: WhiteBalance, keys?: readonly AutoExposureKey[]) {
    const device = await gpuDevice();
    if (!device) return new Float32Array();
    const luts = await precomputeAtmosphere(device);
    const target = device.createTexture({
        size: [SIZE, SIZE],
        format: "rgba32float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const sky = await createSkyPass(device, { luts, format: "rgba32float", toneMap });
    sky.update({
        sunDirection: SUN,
        observerHeightM: 100,
        ev100: 12,
        ...(balance ? { whiteBalance: balance } : {}),
        ...(keys ? { autoExposureKeys: keys } : {}),
    });
    const encoder = device.createCommandEncoder();
    sky.encode(encoder, target);
    device.queue.submit([encoder.finish()]);
    const { data } = await readTexture(device, target, 0);
    sky.destroy();
    target.destroy();
    luts.destroy();
    return data;
}

test("without a white balance, or with the identity, the frame is the same to the bit", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    for (const toneMap of ["neutral", false] as const) {
        const none = new Uint32Array((await frame(toneMap)).buffer);
        const identity = new Uint32Array((await frame(toneMap, NO_WHITE_BALANCE)).buffer);
        expect(none.length).toBe(SIZE * SIZE * 4);
        expect(identity).toEqual(none);
    }
});

test("a white balance turns the exposed light by its matrix, sky, ground and sun disc alike", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    const m = whiteBalance([1.21, 1, 0.79]);
    const plain = await frame(false);
    const balanced = await frame(false, m);
    let checked = 0;
    for (let i = 0; i < SIZE * SIZE; ++i) {
        const [r, g, b] = [plain[i * 4] ?? 0, plain[i * 4 + 1] ?? 0, plain[i * 4 + 2] ?? 0];
        const expected = [
            m[0] * r + m[3] * g + m[6] * b,
            m[1] * r + m[4] * g + m[7] * b,
            m[2] * r + m[5] * g + m[8] * b,
        ];
        for (let c = 0; c < 3; ++c) {
            const e = expected[c] ?? 0;
            expect(Math.abs((balanced[i * 4 + c] ?? 0) - e)).toBeLessThanOrEqual(Math.abs(e) * 1e-4 + 1e-7);
        }
        checked += r > 0 ? 1 : 0;
    }
    expect(checked).toBeGreaterThan(SIZE * SIZE * 0.9);
    // Balanced for the Moon's reddish white, the sky turns bluer.
    const mid = (SIZE * (SIZE / 4) + SIZE / 2) * 4;
    const ratio = (d: Float32Array) => (d[mid + 2] ?? 0) / (d[mid] ?? 1);
    expect(ratio(balanced)).toBeGreaterThan(ratio(plain));
});

test("the keys' tint scales the balanced light per channel, and untinted keys change no bit", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    const plain = new Uint32Array((await frame("neutral", undefined, [])).buffer);
    const ramp: AutoExposureKey[] = [
        { sunAltitude: -18, compensation: -2 },
        { sunAltitude: 0, compensation: { rising: 0, setting: 0.2 } },
        { sunAltitude: 60, compensation: 0 },
    ];
    const untinted = new Uint32Array((await frame("neutral", undefined, ramp)).buffer);
    expect(untinted).toEqual(plain);
    const m = whiteBalance([1.21, 1, 0.79]);
    const keys: AutoExposureKey[] = [{ sunAltitude: 0, compensation: 0, tint: [1.4, 0.8, 1.2] }];
    const balanced = await frame(false, m);
    const tinted = await frame(false, m, keys);
    // One key: the same tint at any altitude, whatever the horizon's dip.
    const tint = autoExposureTint(keys, SUN);
    let checked = 0;
    for (let i = 0; i < SIZE * SIZE; ++i) {
        for (let c = 0; c < 3; ++c) {
            const e = (balanced[i * 4 + c] ?? 0) * (tint[c] ?? 1);
            expect(Math.abs((tinted[i * 4 + c] ?? 0) - e)).toBeLessThanOrEqual(Math.abs(e) * 1e-4 + 1e-7);
        }
        checked += (balanced[i * 4] ?? 0) > 0 ? 1 : 0;
    }
    expect(checked).toBeGreaterThan(SIZE * SIZE * 0.9);
});
