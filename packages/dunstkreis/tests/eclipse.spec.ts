import { expect, test } from "@playwright/test";
// From the built package: the passes import their `.wgsl` files, which only the bundler inlines; `pnpm test` builds first.
import { createSkyPass, discUncovered, precomputeAtmosphere, readTexture } from "../dist/index.js";
import { gpuDevice } from "./gpu.js";

const DEG = Math.PI / 180;
type Vec3 = [number, number, number];
const at = (altitude: number, azimuth: number): Vec3 => [
    Math.cos(altitude * DEG) * Math.sin(azimuth * DEG),
    Math.cos(altitude * DEG) * Math.cos(azimuth * DEG),
    Math.sin(altitude * DEG),
];
/** A narrow view along `forward`, 2° across. */
function towards([x, y, z]: Vec3) {
    const flat = Math.hypot(x, y);
    const right = flat > 1e-6 ? [y / flat, -x / flat, 0] : [1, 0, 0];
    const [rx = 0, ry = 0] = right;
    const up = [ry * z, -rx * z, rx * y - ry * x];
    const t = Math.tan(1 * DEG);
    // biome-ignore format: a matrix reads best as one
    return new Float32Array([rx * t, ry * t, 0, 0, (up[0] ?? 0) * t, (up[1] ?? 0) * t, (up[2] ?? 0) * t, 0, 0, 0, 0, 1, x, y, z, 0]);
}

const SUN = at(60, 0);
type Moon = { moonDirection?: Vec3; moonAngularDiameter?: number };

/** The sky's green luminance in cd/m² at the zenith and 5° over the horizon away from the Sun, from 100 m, and the
 *  Sun's green illuminance there, with the Moon as given. */
async function sky(device: GPUDevice, moon: Moon) {
    const luts = await precomputeAtmosphere(device);
    const options = { luts, format: "rgba32float", toneMap: false, veil: 0, sunDisc: false } as const;
    const pass = await createSkyPass(device, options);
    const target = device.createTexture({
        size: [4, 4],
        format: "rgba32float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const looks: number[] = [];
    for (const forward of [at(90, 0), at(5, 180)]) {
        pass.update({
            sunDirection: SUN,
            sunAngularDiameter: 0.533,
            observerHeightM: 100,
            inverseViewProjection: towards(forward),
            ev100: -Math.log2(1.2),
            ...moon,
        });
        const encoder = device.createCommandEncoder();
        pass.encode(encoder, target);
        device.queue.submit([encoder.finish()]);
        const { data } = await readTexture(device, target);
        looks.push(data[1] ?? Number.NaN);
    }
    const sun = await pass.sunIlluminance();
    target.destroy();
    pass.destroy();
    luts.destroy();
    return { zenith: looks[0] ?? Number.NaN, horizon: looks[1] ?? Number.NaN, sun: sun[1] };
}

test("a Moon half over the Sun dims the Sun's light and the sky by the share of the disc it covers", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const open = await sky(device, {});
    // Far from the Sun the Moon changes nothing, to the bit.
    const far = await sky(device, { moonDirection: at(60, 12), moonAngularDiameter: 0.533 });
    expect(far).toEqual(open);
    // As wide as the Sun, its center on the Sun's limb: two circles a radius apart overlap by 39.1 %.
    const uncovered = 1 - ((2 * Math.PI) / 3 - Math.sqrt(3) / 2) / Math.PI;
    const half = await sky(device, { moonDirection: at(60 + 0.2665, 0), moonAngularDiameter: 0.533 });
    expect(half.sun / open.sun).toBeCloseTo(uncovered, 2);
    // The air along a ray sees the Moon a little elsewhere than the observer does: within a twentieth.
    expect(Math.abs(half.zenith / open.zenith / uncovered - 1)).toBeLessThan(0.05);
    expect(Math.abs(half.horizon / open.horizon / uncovered - 1)).toBeLessThan(0.1);
});

test("under the Moon's shadow the Sun's light is gone and the sky as dark as dusk, brighter round the horizon", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const open = await sky(device, {});
    const total = await sky(device, { moonDirection: SUN, moonAngularDiameter: 0.56 });
    expect(total.sun).toBe(0);
    // Overhead a few thousandths of the day's sky at most, and not black: lit by the air outside the shadow.
    expect(total.zenith / open.zenith).toBeLessThan(5e-3);
    expect(total.zenith / open.zenith).toBeGreaterThan(1e-5);
    // Towards the horizon a ray leaves the shadow, some 100 km wide here, and keeps far more of its light.
    expect(total.horizon / open.horizon).toBeGreaterThan(5 * (total.zenith / open.zenith));
});

test("the share of the Sun's disc left uncovered: all, none, a ring, and two circles a radius apart", () => {
    expect(discUncovered(0.2665, 0.28, 1)).toBe(1);
    expect(discUncovered(0.2665, 0.28, 0)).toBe(0);
    // An annular eclipse leaves the ring the smaller Moon does not reach.
    expect(discUncovered(0.2665, 0.25, 0.01)).toBeCloseTo(1 - (0.25 / 0.2665) ** 2, 12);
    expect(discUncovered(1, 1, 1)).toBeCloseTo(1 - ((2 * Math.PI) / 3 - Math.sqrt(3) / 2) / Math.PI, 12);
    // Falling steadily as the Moon moves in.
    let last = 1;
    for (let apart = 0.56; apart >= 0; apart -= 0.01) {
        const share = discUncovered(0.2665, 0.28, apart);
        expect(share).toBeLessThanOrEqual(last);
        last = share;
    }
});

test("Baily's beads: through the valleys of the Moon's limb a little of the Sun still shows at the contacts, and only there", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const luts = await precomputeAtmosphere(device);
    const options = {
        luts,
        format: "rgba32float",
        toneMap: false,
        veil: 0,
        solarCorona: false,
        limbDarkening: false,
    } as const;
    const pass = await createSkyPass(device, options);
    const target = device.createTexture({
        size: [64, 64],
        format: "rgba32float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    /** The disc's green light summed over a view 2° across from 400 km, the Moon `apart` degrees from the Sun. */
    const light = async (apart: number | null) => {
        pass.update({
            sunDirection: SUN,
            sunAngularDiameter: 0.533,
            observerHeightM: 400_000,
            inverseViewProjection: towards(SUN),
            ev100: -Math.log2(1.2),
            moonDirection: at(60 + (apart ?? 30), 0),
            moonAngularDiameter: apart === null ? 0 : 0.56,
        });
        const encoder = device.createCommandEncoder();
        pass.encode(encoder, target);
        device.queue.submit([encoder.finish()]);
        const { data } = await readTexture(device, target);
        let sum = 0;
        for (let i = 1; i < data.length; i += 4) sum += data[i] ?? 0;
        return sum;
    };
    const open = await light(null);
    // The limbs touch from inside with the centers 0.0135° apart. Half an arcsecond into totality the valleys still let
    // light through, a few arcseconds in none does, and well inside nothing is drawn at all.
    const contact = (0.56 - 0.533) / 2;
    const beads = await light(contact - 0.5 / 3600);
    expect(beads).toBeGreaterThan(0);
    expect(beads / open).toBeLessThan(1e-3);
    expect(await light(contact - 5 / 3600)).toBe(0);
    expect(await light(contact - 60 / 3600)).toBe(0);
    // Just before the contact the smooth limb leaves a sliver, and the mountains take some of it away.
    const sliver = await light(contact + 1 / 3600);
    expect(sliver).toBeGreaterThan(beads);
    expect(sliver / open).toBeLessThan(1e-3);
    // Half way in, the disc's light is the share the Moon leaves of it, whatever the pixels' size.
    expect((await light(0.2665)) / open).toBeCloseTo(discUncovered(0.2665, 0.28, 0.2665), 2);
    target.destroy();
    pass.destroy();
    luts.destroy();
});
