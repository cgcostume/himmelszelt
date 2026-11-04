import { expect, test } from "@playwright/test";
// From the built package: the passes import their `.wgsl` files, which only the bundler inlines; `pnpm test` builds first.
import {
    airTransmittance,
    apparentDirection,
    createSkyPass,
    DEFAULT_ATMOSPHERE_MODEL,
    precomputeAtmosphere,
    readTexture,
} from "../dist/index.js";
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

test("the Moon's light at the observer is the Sun's at its share, through the same air, and moves with the Moon", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const luts = await precomputeAtmosphere(device);
    const sky = await createSkyPass(device, { luts, format: "rgba16float", toneMap: false, moonlight: true });
    const base = { observerHeightM: 100, inverseViewProjection: new Float32Array(16), ev100: 0 };
    const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sky.update({ ...base, sunDirection: at(20, 90) });
    const sun = await sky.sunIlluminance();
    expect(luminance(await sky.moonIlluminance())).toBe(0);
    // The Sun stays, only the Moon moves: the meter runs again for it.
    sky.update({ ...base, sunDirection: at(20, 90), moonDirection: at(20, 270), moonIlluminance: 0.3 });
    const moon = await sky.moonIlluminance();
    for (let c = 0; c < 3; c++) expect((moon[c] ?? 0) / (((sun[c] ?? 0) * 0.3) / 128_000)).toBeCloseTo(1, 2);
    sky.update({ ...base, sunDirection: at(20, 90), moonDirection: at(-5, 270), moonIlluminance: 0.3 });
    expect(luminance(await sky.moonIlluminance())).toBeLessThan(luminance(moon) / 100);
    sky.destroy();
    luts.destroy();
});

test("airTransmittance on the CPU agrees with the transmittance table the meter reads, by day and near the horizon", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const luts = await precomputeAtmosphere(device);
    const sky = await createSkyPass(device, { luts, format: "rgba16float", toneMap: false });
    const base = { observerHeightM: 100, inverseViewProjection: new Float32Array(16), ev100: 0 };
    sky.update({ ...base, sunDirection: at(90, 0) });
    const above = await sky.sunIlluminance();
    for (const [altitude, tolerance] of [
        [30, 0.01],
        [5, 0.03],
    ] as const) {
        sky.update({ ...base, sunDirection: at(altitude, 90) });
        const metered = await sky.sunIlluminance();
        const [x, y, z] = apparentDirection(at(altitude, 90), DEFAULT_ATMOSPHERE_MODEL, 100);
        const seen = (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI;
        const overhead = airTransmittance(DEFAULT_ATMOSPHERE_MODEL, 100, 90) ?? [1, 1, 1];
        const through = airTransmittance(DEFAULT_ATMOSPHERE_MODEL, 100, seen) ?? [0, 0, 0];
        for (let c = 0; c < 3; c++) {
            const expected = (metered[c] ?? 0) / (above[c] ?? 1);
            expect(Math.abs((through[c] ?? 0) / (overhead[c] ?? 1) / expected - 1)).toBeLessThan(tolerance);
        }
    }
    expect(airTransmittance(DEFAULT_ATMOSPHERE_MODEL, 100, -1)).toBeNull();
    sky.destroy();
    luts.destroy();
});

test("the sky pass compiles with night vision, and turns the moonlit sky bluer", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const luts = await precomputeAtmosphere(device);
    const target = device.createTexture({
        size: [4, 4],
        format: "rgba32float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const zenithColor = async (nightVision: boolean) => {
        device.pushErrorScope("validation");
        const sky = await createSkyPass(device, {
            luts,
            format: "rgba32float",
            toneMap: false,
            moonlight: true,
            nightVision,
        });
        // Looking straight up, a narrow view.
        const up = new Float32Array([0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0]);
        sky.update({
            sunDirection: at(-30, 330),
            moonDirection: at(40, 150),
            moonIlluminance: 0.3,
            observerHeightM: 100,
            inverseViewProjection: up,
            ev100: -Math.log2(1.2),
        });
        const encoder = device.createCommandEncoder();
        sky.encode(encoder, target);
        device.queue.submit([encoder.finish()]);
        expect(await device.popErrorScope()).toBeNull();
        const { data } = await readTexture(device, target, 0);
        sky.destroy();
        return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
    };
    const camera = await zenithColor(false);
    const eye = await zenithColor(true);
    const saturation = ([r, , b]: number[]) => (b ?? 0) / Math.max(r ?? 0, 1e-12);
    expect(saturation(camera)).toBeGreaterThan(saturation(eye));
    expect(eye[2] ?? 0).toBeGreaterThan(eye[0] ?? 0);
    target.destroy();
    luts.destroy();
});
