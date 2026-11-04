import { expect, test } from "@playwright/test";
// From the built package: the passes import their `.wgsl` files, which only the bundler inlines; `pnpm test` builds first.
import { createSkyPass, precomputeAtmosphere, readTexture } from "../dist/index.js";
import { gpuDevice } from "./gpu.js";

// Golden texels of the tables and the sky, computed by the shipped passes through Dawn, pinned from a run on an RX 7900
// XT. Drift of the tables' values, which only the research script would otherwise show, fails here: a change to the
// model or the integration is expected to move them, and then these numbers are updated knowingly.

const near = (actual: readonly number[], expected: readonly number[], relative: number) => {
    for (const [i, value] of expected.entries()) {
        const difference = Math.abs((actual[i] as number) - value);
        expect(difference, `component ${i}: ${actual[i]} for ${value}`).toBeLessThanOrEqual(
            Math.abs(value) * relative + 1e-6,
        );
    }
};
const texel = (image: { width: number; data: Float32Array }, x: number, y: number) => [
    ...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
];

// A camera looking north, pitched up by 10 degrees, 70 degrees vertical field of view, reversed-z, infinite far plane.
function camera(aspect: number): Float32Array {
    const p = (10 * Math.PI) / 180;
    const ty = Math.tan((70 * Math.PI) / 360);
    return new Float32Array([
        ty * aspect,
        0,
        0,
        0,
        0,
        -Math.sin(p) * ty,
        Math.cos(p) * ty,
        0,
        0,
        0,
        0,
        1,
        0,
        Math.cos(p),
        Math.sin(p),
        0,
    ]);
}
// The sun 3 degrees up, due east.
const sunDirection: [number, number, number] = [Math.cos((3 * Math.PI) / 180), 0, Math.sin((3 * Math.PI) / 180)];

test("the tables, the sky-view table, the meter and a few pixels of sky hold their golden values", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;

    const luts = await precomputeAtmosphere(device);
    const transmittance = await readTexture(device, luts.transmittance);
    // The ground row, straight up, half way, and below the horizon; a row high up.
    near(texel(transmittance, 0, 0), [0.91113, 0.88037, 0.84912, 0.76318], 0.01);
    near(texel(transmittance, 128, 0), [0.42578, 0.31128, 0.21082, 0.074158], 0.01);
    expect(texel(transmittance, 250, 0)).toEqual([0, 0, 0, 0]);
    near(texel(transmittance, 200, 32), [0.1637, 0.082092, 0.063538, 0.013603], 0.01);
    // The multiple scattering as stored, log2 plus 12: the sun at the horizon and overhead on the ground, and half way up.
    const multiScattering = await readTexture(device, luts.multiScattering);
    near(texel(multiScattering, 64, 0), [3.2383, 3.0293, 3.3184, 3.0664], 0.01);
    near(texel(multiScattering, 127, 0), [7.8203, 7.8711, 8.0234, 8.1797], 0.01);
    near(texel(multiScattering, 64, 32), [3.8262, 3.6113, 4.3359, 4.7266], 0.01);

    // Exposed by ev100, not metered, so the pixels below are of a known exposure; the meter runs and is read either way.
    // Without the aureole, which takes a share of the aerosols' forward lobe out of the table: the values are of the
    // march as Hillaire's.
    const pass = await createSkyPass(device, { luts, format: "rgba16float", toneMap: false, aureole: false });
    const width = 1920;
    const height = 1080;
    const params = {
        sunDirection,
        sunAngularDiameter: 0.533,
        ev100: 12,
        inverseViewProjection: camera(width / height),
    };
    pass.update({ ...params, observerHeightM: 10 });
    const skyView = await readTexture(device, pass.skyViewTexture);
    const sky = (x: number, y: number) => texel(skyView, x, y).map((v) => v / pass.skyViewScale);
    // Towards the sun just above the horizon, away from it, and the ground just below it.
    near(sky(10, 127), [37152, 24656, 11952, 3026], 0.01);
    near(sky(100, 200), [617.5, 575, 650.5, 663.5], 0.01);
    near(sky(64, 128), [1073, 1025, 1104, 939.5], 0.01);
    expect(await pass.meteredEV100()).toBeCloseTo(12.7466, 1);
    near(await pass.sunIlluminance(), [40391, 17550, 2147.6], 0.01);

    // The exposed sky itself, linear: a pixel of sky to the left, one near the zenith, the ground below the horizon.
    const target = device.createTexture({
        size: [width, height],
        format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const encoder = device.createCommandEncoder();
    pass.encode(encoder, target);
    device.queue.submit([encoder.finish()]);
    const image = await readTexture(device, target);
    near(texel(image, 100, 540).slice(0, 3), [0.44019, 0.48828, 0.40039], 0.01);
    near(texel(image, 960, 100).slice(0, 3), [0.076538, 0.11462, 0.18274], 0.01);
    near(texel(image, 960, 1000).slice(0, 3), [0.076416, 0.065796, 0.068909], 0.01);

    // From space the meter raymarches: the lit planet, and the sun's light with nothing in the way.
    pass.update({ ...params, observerHeightM: 300_000 });
    expect(await pass.meteredEV100()).toBeCloseTo(12.2751, 1);
    near(await pass.sunIlluminance(), [139650, 125070, 122740], 0.01);

    target.destroy();
    pass.destroy();
    luts.destroy();
});

test("the light scattered once and the light scattered more than once add up to the whole sky", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;

    const luts = await precomputeAtmosphere(device);
    const params = { sunDirection, sunAngularDiameter: 0.533, ev100: 12, inverseViewProjection: camera(16 / 9) };
    // Towards the sun just above the horizon, and high up away from it: each order alone, and both. Not the ground, whose
    // own reflection of the sun each order adds once.
    const skyOf = async (scattering: { single?: boolean; multiple?: boolean }) => {
        const pass = await createSkyPass(device, { luts, format: "rgba16float", toneMap: false, scattering });
        pass.update({ ...params, observerHeightM: 10 });
        const skyView = await readTexture(device, pass.skyViewTexture);
        const texels = [texel(skyView, 10, 127), texel(skyView, 100, 60)].map((t) =>
            t.map((v) => v / pass.skyViewScale),
        );
        pass.destroy();
        return texels;
    };
    const [both, single, multiple] = await Promise.all([
        skyOf({}),
        skyOf({ multiple: false }),
        skyOf({ single: false }),
    ]);
    for (const [i, whole] of both.entries()) {
        const sum = (single[i] as number[]).map((v, c) => v + ((multiple[i] as number[])[c] as number));
        near(sum, whole, 0.01);
        // Each order alone is a part of it, not all.
        for (const part of [single[i], multiple[i]])
            expect((part as number[])[0]).toBeLessThan((whole[0] as number) * 0.99);
    }
    luts.destroy();
});

test("the aureole sits on the setting sun and runs on across the horizon without a step", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;

    const luts = await precomputeAtmosphere(device);
    // Due north, 0.2° up, through a narrow camera looking straight at the horizon: 8° high, 256 pixels, 0.03° each.
    const altitude = (0.2 * Math.PI) / 180;
    const size = 256;
    const ty = Math.tan((8 * Math.PI) / 360);
    // biome-ignore format: a matrix reads best as one
    const inverseViewProjection = new Float32Array([ty, 0, 0, 0, 0, 0, ty, 0, 0, 0, 0, 1, 0, 1, 0, 0]);
    const params = {
        sunDirection: [0, Math.cos(altitude), Math.sin(altitude)] as [number, number, number],
        sunAngularDiameter: 0.533,
        // An exposure of 1: the luminance itself.
        ev100: -Math.log2(1.2),
        inverseViewProjection,
        observerHeightM: 10,
    };
    const render = async (aureole: false | undefined) => {
        const pass = await createSkyPass(device, {
            luts,
            format: "rgba32float",
            toneMap: false,
            sunDisc: false,
            ...(aureole === false ? { aureole } : {}),
        });
        pass.update(params);
        const target = device.createTexture({
            size: [size, size],
            format: "rgba32float",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        });
        const encoder = device.createCommandEncoder();
        pass.encode(encoder, target);
        device.queue.submit([encoder.finish()]);
        const image = await readTexture(device, target);
        target.destroy();
        pass.destroy();
        return image;
    };
    const [withAureole, without] = await Promise.all([render(undefined), render(false)]);
    const green = (image: typeof withAureole, x: number, y: number) => texel(image, x, y)[1] as number;
    const aureole = (x: number, y: number) => green(withAureole, x, y) - green(without, x, y);

    // Brightest where the sun shows, a little above the image's middle row, the horizon.
    let peak = { x: 0, y: 0, value: 0 };
    for (let y = 0; y < size; ++y)
        for (let x = 0; x < size; ++x) if (aureole(x, y) > peak.value) peak = { x, y, value: aureole(x, y) };
    expect(Math.abs(peak.x - size / 2)).toBeLessThanOrEqual(2);
    expect(peak.y).toBeLessThan(size / 2);
    expect(peak.y).toBeGreaterThan(size / 2 - 30);

    // The horizon: the row below which the sky drops to the ground's light in front of it, short of the long rays above.
    const column = peak.x + 50;
    let horizon = size / 2 - 40;
    while (green(without, column, horizon) < 3 * green(without, column, horizon + 1)) ++horizon;
    // 1.5° to the side, 50 pixels, down the column, above the horizon and below it: from row to row the aureole changes
    // by at most a quarter more than the sky does, which falls steeply just below the horizon, where the ground comes
    // near fast. Across it the aureole drops as the sky does, since both are the air's light along the same rays.
    const sky = (x: number, y: number) => green(without, x, y);
    const ratio = (f: (x: number, y: number) => number, y: number) =>
        Math.max(f(column, y), f(column, y + 1)) / Math.min(f(column, y), f(column, y + 1));
    for (let y = horizon - 40; y < horizon + 40; ++y) {
        if (y === horizon) continue;
        expect(ratio(aureole, y), `rows ${y} and ${y + 1}`).toBeLessThan(1.25 * Math.max(1, ratio(sky, y)));
    }
    expect(ratio(aureole, horizon)).toBeLessThan(2 * ratio(sky, horizon));
    // A glow of a degree or so: 1.5° to the side as bright as the sky there at most, at 4° a few percent of it.
    expect(aureole(column, peak.y) / green(without, column, peak.y)).toBeLessThan(1);
    const far = peak.x + Math.round(4 / (8 / size));
    expect(aureole(far, peak.y) / green(without, far, peak.y)).toBeLessThan(0.05);
    luts.destroy();
});
