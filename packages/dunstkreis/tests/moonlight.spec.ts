import { expect, test } from "@playwright/test";
// From the built package: the passes import their `.wgsl` files, which only the bundler inlines; `pnpm test` builds first.
import { createSkyPass, precomputeAtmosphere, readTexture } from "../dist/index.js";
import { gpuDevice } from "./gpu.js";

// The sky by moonlight is the sky by day at the Moon's share of the Sun's light: the same march from the Moon's
// direction, in a table of its own. Read on a cube map's zenith face, away from either aureole.

const SIZE = 8;
const DEG = Math.PI / 180;
const at = (altitude: number, azimuth: number): [number, number, number] => [
    Math.cos(altitude * DEG) * Math.sin(azimuth * DEG),
    Math.cos(altitude * DEG) * Math.cos(azimuth * DEG),
    Math.sin(altitude * DEG),
];

/** The mean luminance of the zenith face, in cd/m². */
async function zenith(params: {
    sunDirection: [number, number, number];
    moonDirection?: [number, number, number];
    moonIlluminance?: number;
}) {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return 0;
    const luts = await precomputeAtmosphere(device);
    const sky = await createSkyPass(device, { luts, format: "rgba16float", toneMap: false, moonlight: true });
    sky.update({ ...params, observerHeightM: 100, inverseViewProjection: new Float32Array(16), ev100: 0 });
    const pass = await sky.createCubePass({ format: "rgba32float" });
    const cube = device.createTexture({
        size: [SIZE, SIZE, 6],
        format: "rgba32float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const encoder = device.createCommandEncoder();
    pass.encode(encoder, cube);
    device.queue.submit([encoder.finish()]);
    const { data } = await readTexture(device, cube, 4);
    let sum = 0;
    for (let i = 0; i < SIZE * SIZE; ++i)
        sum += 0.2126 * (data[i * 4] ?? 0) + 0.7152 * (data[i * 4 + 1] ?? 0) + 0.0722 * (data[i * 4 + 2] ?? 0);
    cube.destroy();
    sky.destroy();
    luts.destroy();
    return sum / (SIZE * SIZE);
}

test("the sky by moonlight is the day's at the Moon's share of the Sun's light, and dark without it", async () => {
    const moon = at(40, 150);
    const night = at(-30, 330);
    const day = await zenith({ sunDirection: moon });
    const moonlit = await zenith({ sunDirection: night, moonDirection: moon, moonIlluminance: 0.3 });
    const dark = await zenith({ sunDirection: night });
    expect(moonlit / ((day * 0.3) / 128_000)).toBeGreaterThan(0.97);
    expect(moonlit / ((day * 0.3) / 128_000)).toBeLessThan(1.03);
    expect(dark).toBeLessThan(moonlit / 100);
});
