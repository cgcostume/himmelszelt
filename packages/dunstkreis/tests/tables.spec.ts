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
    const pass = await createSkyPass(device, { luts, format: "rgba16float", toneMap: false });
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
