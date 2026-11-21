import { expect, test } from "@playwright/test";
// From the built package: the passes import their `.wgsl` files, which only the bundler inlines; `pnpm test` builds first.
import { createSkyPass, LENS_VEIL, precomputeAtmosphere, readTexture, type SkyPassOptions } from "../dist/index.js";
import { gpuDevice } from "./gpu.js";

const DEG = Math.PI / 180;
// A camera looking north along the horizontal, 8° across 256 pixels, and the Sun in its middle: from 400 km the
// horizon lies 20° below, so the frame is black sky but for the Sun.
const SIZE = 256;
const TY = Math.tan(4 * DEG);
/** The Sun's direction, due north and `altitude` degrees up, and the matrix of a camera looking north `look` degrees up. */
function towards(altitude: number, look = altitude) {
    const sunDirection: [number, number, number] = [0, Math.cos(altitude * DEG), Math.sin(altitude * DEG)];
    const [c, s] = [Math.cos(look * DEG), Math.sin(look * DEG)];
    // biome-ignore format: a matrix reads best as one
    const inverseViewProjection = new Float32Array([TY, 0, 0, 0, 0, -s * TY, c * TY, 0, 0, 0, 0, 1, 0, c, s, 0]);
    return { inverseViewProjection, sunDirection };
}
const RADIUS = 0.2665 * DEG;
/** helldunkel's veil, `hdVeilingGlare`, in cd/m² per lux at `angle` degrees, for an eye of thirty years, blue-green. */
const veil = (angle: number) => 10 / angle ** 3 + (5 / angle ** 2 + 0.1 / angle) * (1 + (30 / 62.5) ** 4) + 0.0025;
/** The angle from the view's axis of the pixel `right` and `up` pixels from the middle, in radians. */
const angleOf = (right: number, up: number) => Math.atan((Math.hypot(right, up) / (SIZE / 2)) * TY);

/** The luminance in cd/m² a sky pass with `options` writes, from `heightM`, the Sun `altitude` degrees up and the camera
 *  looking `look` degrees up, at the Sun by default, and the Sun's illuminance there. */
async function frame(
    device: GPUDevice,
    heightM: number,
    options: Partial<SkyPassOptions> = {},
    altitude = 0,
    look = altitude,
) {
    const luts = await precomputeAtmosphere(device);
    const pass = await createSkyPass(device, { luts, format: "rgba32float", toneMap: false, ...options });
    // An exposure of 1: the luminance itself.
    pass.update({
        ...towards(altitude, look),
        sunAngularDiameter: 0.533,
        ev100: -Math.log2(1.2),
        observerHeightM: heightM,
    });
    const target = device.createTexture({
        size: [SIZE, SIZE],
        format: "rgba32float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const encoder = device.createCommandEncoder();
    pass.encode(encoder, target);
    device.queue.submit([encoder.finish()]);
    const { data } = await readTexture(device, target);
    const sun = await pass.sunIlluminance();
    target.destroy();
    pass.destroy();
    luts.destroy();
    /** Green `right` and `up` pixels from the middle of the frame, where the Sun is. */
    const green = (right: number, up: number) =>
        data[((SIZE / 2 - up) * SIZE + SIZE / 2 + right) * 4 + 1] ?? Number.NaN;
    return { green, sun };
}

const NOTHING = { veil: 0, solarCorona: false, limbDarkening: false } as const;

test("the veil is CIE's at its strength, of the Sun's light at the observer, at any height, and leaves the frame with the Sun", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const bare = await frame(device, 400_000, NOTHING);
    const lit = await frame(device, 400_000, { ...NOTHING, veil: LENS_VEIL });
    // Black sky without it, and with it the Sun's green lux times a two-hundredth of the eye's veil, 1° and 3° from it.
    for (const pixels of [32, 96]) {
        const angle = angleOf(pixels + 0.5, 0.5) / DEG;
        expect(bare.green(pixels, 0)).toBeLessThan(1e-3);
        expect(lit.green(pixels, 0) / (lit.sun[1] * LENS_VEIL * veil(angle))).toBeCloseTo(1, 2);
    }
    // A lens's by default, and the eye's two hundred times that.
    const byDefault = await frame(device, 400_000, { solarCorona: false, limbDarkening: false });
    expect(byDefault.green(96, 0) / lit.green(96, 0)).toBeCloseTo(1, 5);
    const eye = await frame(device, 400_000, { ...NOTHING, veil: 1 });
    expect(eye.green(96, 0) / lit.green(96, 0)).toBeCloseTo(200, 0);

    // Only of what is looked at: the Sun on the frame's upper edge, all of it; 40 % of the frame's half height beyond
    // it, 5.6° up in a view of 8°, none, and none of the starburst either.
    const edge = await frame(device, 400_000, { ...NOTHING, veil: LENS_VEIL }, 4, 0);
    expect(edge.green(0, 96) / (edge.sun[1] * LENS_VEIL * veil(angleOf(0.5, 32.5) / DEG))).toBeCloseTo(1, 1);
    const beyond = await frame(device, 400_000, { ...NOTHING, veil: LENS_VEIL, starburst: true }, 5.7, 0);
    expect(beyond.green(0, 96)).toBeLessThan(1e-3);
    expect(beyond.green(20, 120)).toBeLessThan(1e-3);

    // From 100 m with the Sun 60° up, where the air hardly lifts it, all of it as well, over the sky.
    const ground = await frame(device, 100, NOTHING, 60);
    const veiled = await frame(device, 100, { ...NOTHING, veil: LENS_VEIL }, 60);
    const added = veiled.green(40, 0) - ground.green(40, 0);
    expect(added / (veiled.sun[1] * LENS_VEIL * veil(angleOf(40.5, 0.5) / DEG))).toBeCloseTo(1, 1);
});

test("a starburst draws as many spikes as an even count of blades, twice as many as an odd one, where a lens draws them", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    /** Spikes around the Sun: the peaks of the light on a ring 2.5° from it, well above what lies between them. */
    const spikes = async (starburst: NonNullable<SkyPassOptions["starburst"]>) => {
        const image = await frame(device, 400_000, { ...NOTHING, starburst });
        const ring = [...Array(720).keys()].map((i) => {
            const turn = (i / 720) * 2 * Math.PI;
            return image.green(Math.round(80 * Math.cos(turn)), Math.round(80 * Math.sin(turn)));
        });
        const floor = Math.max(...ring) / 10;
        return ring.filter((value, i) => value > floor && (ring[(i + 719) % 720] ?? 0) <= floor).length;
    };
    expect(await spikes(false)).toBe(0);
    expect(await spikes(true)).toBe(6);
    expect(await spikes({ blades: 8 })).toBe(8);
    expect(await spikes({ blades: 5 })).toBe(10);
    // On the first spike, 10° up from the image's horizontal, the light falls with the square of the angle.
    const six = await frame(device, 400_000, { ...NOTHING, starburst: true });
    const on = (pixels: number) =>
        six.green(Math.round(pixels * Math.cos(10 * DEG)), Math.round(pixels * Math.sin(10 * DEG)));
    expect(on(50) / on(100)).toBeGreaterThan(3.5);
    expect(on(50) / on(100)).toBeLessThan(4.5);
    const luts = await precomputeAtmosphere(device);
    const two = createSkyPass(device, { luts, format: "rgba32float", toneMap: false, starburst: { blades: 2 } });
    await expect(two).rejects.toThrow(/blades/);
    luts.destroy();
});

test("the corona shines off the limb at Baumbach's share of the disc, and the disc darkens to its limb at the same light", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const bare = await frame(device, 400_000, NOTHING);
    const corona = await frame(device, 400_000, { ...NOTHING, solarCorona: true });
    // The disc's mean luminance, from the pass without limb darkening, and the corona 1.5 and 3 radii from the center.
    const disc = bare.green(0, 0);
    expect(disc / (bare.sun[1] / (Math.PI * RADIUS ** 2))).toBeCloseTo(1, 3);
    for (const pixels of [12, 25]) {
        const r = angleOf(pixels + 0.5, 0.5) / RADIUS;
        const baumbach = 1.24e-6 * (0.0532 / r ** 2.5 + 1.425 / r ** 7 + 2.565 / r ** 17);
        expect(bare.green(pixels, 0)).toBeLessThan(1e-3);
        expect(corona.green(pixels, 0) / (disc * baumbach)).toBeCloseTo(1, 1);
    }
    // Limb darkened, the center is brighter by (alpha + 2) / 2 and the disc's sum the same.
    const darkened = await frame(device, 400_000, { ...NOTHING, limbDarkening: true });
    expect(darkened.green(0, 0) / disc).toBeCloseTo(2.5079 / 2, 2);
    const sum = (image: typeof bare) => {
        let total = 0;
        for (let up = -12; up < 12; ++up) for (let right = -12; right < 12; ++right) total += image.green(right, up);
        return total;
    };
    expect(sum(darkened) / sum(bare)).toBeCloseTo(1, 2);
});
