import { expect, test } from "@playwright/test";
// From the built package: the pass imports its `.wgsl` files, which only the bundler inlines; `pnpm test` builds first.
import {
    AIR_DISPERSION,
    type Air,
    airAt,
    airTable,
    createAirTexture,
    createShimmerPass,
    DEFAULT_ATMOSPHERE_MODEL,
    readTexture,
    type ShimmerParams,
    shimmerExtent,
    shimmerReach,
    shimmerScales,
    shimmerShows,
} from "../dist/index.js";
import { gpuDevice } from "./gpu.js";

const DEG = Math.PI / 180;
const ARCSEC = 1 / 3600;
const SIZE = 192;
// A pixel of 2 arcseconds: the frame 6.4 arcminutes across, a fifth of the Moon.
const PIXEL = 2 * ARCSEC;
const RADIUS = 50;

/** A camera looking north at `altitude` degrees up, `SIZE` pixels of `PIXEL` each way, as the sky pass takes it. */
function camera(altitude: number) {
    const a = altitude * DEG;
    const t = Math.tan((SIZE / 2) * PIXEL * DEG);
    return new Float32Array([
        t,
        0,
        0,
        0,
        0,
        -Math.sin(a) * t,
        Math.cos(a) * t,
        0,
        0,
        0,
        0,
        1,
        0,
        Math.cos(a),
        Math.sin(a),
        0,
    ]);
}
const towards = (altitude: number): [number, number, number] => [0, Math.cos(altitude * DEG), Math.sin(altitude * DEG)];

/** A white disc in the frame's middle with a soft edge, premultiplied, as half floats. */
function disc() {
    const data = new Float32Array(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; ++y)
        for (let x = 0; x < SIZE; ++x) {
            const d = Math.hypot(x + 0.5 - SIZE / 2, y + 0.5 - SIZE / 2);
            data.fill(Math.min(Math.max(RADIUS + 0.5 - d, 0), 1), (y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4);
        }
    return data;
}

function toHalf(value: number): number {
    const floats = new Float32Array([value]);
    const bits = new Uint32Array(floats.buffer)[0] as number;
    const exponent = ((bits >> 23) & 0xff) - 127;
    if (value === 0 || exponent < -14) return 0;
    return ((bits >> 16) & 0x8000) | ((exponent + 15) << 10) | ((bits >> 13) & 0x3ff);
}

interface Frame extends Partial<ShimmerParams> {
    heightM: number;
    altitude: number;
    pixels?: Float32Array;
}

/** The layer through the pass: what it read and what it wrote, as floats, row major. */
async function shimmered(device: GPUDevice, { heightM, altitude, pixels = disc(), ...params }: Frame) {
    const table = airTable(DEFAULT_ATMOSPHERE_MODEL, heightM);
    const air = createAirTexture(device, table);
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
    const layer = device.createTexture({ size: [SIZE, SIZE], format: "rgba16float", usage });
    device.queue.writeTexture({ texture: layer }, Uint16Array.from(pixels, toHalf), { bytesPerRow: SIZE * 8 }, [
        SIZE,
        SIZE,
    ]);
    const target = device.createTexture({
        size: [SIZE, SIZE],
        format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const pass = await createShimmerPass(device);
    pass.update({
        direction: towards(altitude),
        inverseViewProjection: camera(altitude),
        seeing: { aperture: 0.1 },
        ...params,
    });
    const encoder = device.createCommandEncoder();
    pass.encode(encoder, layer, air, target);
    device.queue.submit([encoder.finish()]);
    const { data } = await readTexture(device, target);
    for (const texture of [air, layer, target]) texture.destroy();
    pass.destroy();
    return { table, before: pixels, after: data };
}

/** A channel's light and where its middle lies, in pixels from the top left. */
function centroid(data: Float32Array, channel: number) {
    let [sum, x, y] = [0, 0, 0];
    for (let i = 0; i < SIZE * SIZE; ++i) {
        const value = data[i * 4 + channel] as number;
        sum += value;
        x += value * ((i % SIZE) + 0.5);
        y += value * (Math.floor(i / SIZE) + 0.5);
    }
    return { sum, x: x / sum, y: y / sum };
}

const difference = (a: Float32Array, b: Float32Array) =>
    a.reduce((sum, v, i) => sum + Math.abs(v - (b[i] as number)), 0) / a.length;
const furthest = (a: Float32Array, b: Float32Array) =>
    a.reduce((most, v, i) => Math.max(most, Math.abs(v - (b[i] as number))), 0);
const most = (a: Float32Array) => a.reduce((x, v) => Math.max(x, v), Number.NEGATIVE_INFINITY);
const least = (a: Float32Array) => a.reduce((x, v) => Math.min(x, v), Number.POSITIVE_INFINITY);
const still = { r0: 1e6, aperture: 0.1 };

test("in still air without dispersion the layer comes through as it is", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const { before, after } = await shimmered(device, { heightM: 1, altitude: 3, seeing: still, dispersion: 0 });
    expect(furthest(after, before)).toBeLessThan(2e-3);
});

test("the dispersion lifts blue over green and leaves red below, by the bend's share", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const { table, after } = await shimmered(device, { heightM: 1, altitude: 3, seeing: still });
    // The bend as it shows: squeezed with everything else 3° up, by 6%.
    const bend = (airAt(table, 3) as Air).bend * (airAt(table, 3) as Air).dilution;
    const [red, green, blue] = [0, 1, 2].map((c) => centroid(after, c)) as [
        ReturnType<typeof centroid>,
        ReturnType<typeof centroid>,
        ReturnType<typeof centroid>,
    ];
    // Some 14 arcminutes of bend 3° up: red 3 arcseconds below green, blue 6 above, y running down.
    expect(green.y).toBeCloseTo(SIZE / 2, 1);
    expect(red.y - green.y).toBeCloseTo((0.0036 * bend) / PIXEL, 1);
    expect(green.y - blue.y).toBeCloseTo((0.0078 * bend) / PIXEL, 1);
    expect((red.y - blue.y) * PIXEL).toBeGreaterThan(8 * ARCSEC);
    expect(0.0036 + 0.0078).toBeCloseTo(AIR_DISPERSION, 6);
    for (const channel of [red, green, blue]) {
        expect(channel.x).toBeCloseTo(SIZE / 2, 1);
        expect(channel.sum / green.sum).toBeCloseTo(1, 3);
    }
    // Twice the dispersion, twice as far apart.
    const twice = await shimmered(device, { heightM: 1, altitude: 3, seeing: still, dispersion: 2 });
    expect(centroid(twice.after, 0).y - centroid(twice.after, 2).y).toBeCloseTo(2 * (red.y - blue.y), 1);
});

test("the turbulence moves the image about with the time, keeps its light, and less of it moves it less", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const frame = { heightM: 1, altitude: 3, dispersion: 0 };
    // One after the other: Dawn takes one readback at a time.
    const now = await shimmered(device, { ...frame, time: 1 });
    const again = await shimmered(device, { ...frame, time: 1 });
    const later = await shimmered(device, { ...frame, time: 1.2 });
    const steady = await shimmered(device, { ...frame, time: 1, seeing: { aperture: 0.1, r0: 0.4 } });
    expect(difference(now.after, again.after)).toBe(0);
    expect(difference(now.after, now.before)).toBeGreaterThan(0.004);
    expect(difference(now.after, later.after)).toBeGreaterThan(0.002);
    expect(difference(steady.after, steady.before)).toBeLessThan(0.5 * difference(now.after, now.before));
    for (const { before, after } of [now, later, steady]) {
        expect(Math.abs(centroid(after, 1).sum / centroid(before, 1).sum - 1)).toBeLessThan(0.03);
        expect(most(after)).toBeLessThan(1.01);
        expect(least(after)).toBeGreaterThanOrEqual(0);
    }
    // The large waves alone move the disc as a whole; the small alone leave its middle where it was.
    const parts = [
        await shimmered(device, { ...frame, time: 1, boiling: 0 }),
        await shimmered(device, { ...frame, time: 1, motion: 0 }),
    ];
    const moved = parts.map(({ after }) =>
        Math.hypot(centroid(after, 1).x - SIZE / 2, centroid(after, 1).y - SIZE / 2),
    );
    expect(moved[0]).toBeGreaterThan(2 * (moved[1] as number));
});

test("the ground hides what the air would move up from below the horizon, and the rest of the frame is left alone", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    // Light all over the frame, the horizon through its middle.
    const table = airTable(DEFAULT_ATMOSPHERE_MODEL, 1000);
    const pixels = new Float32Array(SIZE * SIZE * 4).fill(1);
    const { after } = await shimmered(device, { heightM: 1000, altitude: table.horizon, pixels, dispersion: 0 });
    const row = (y: number) => after.subarray(y * SIZE * 4, (y + 1) * SIZE * 4);
    expect(most(row(SIZE / 2 + 2))).toBe(0);
    expect(least(row(SIZE / 2 - 2))).toBeGreaterThan(0.9);

    // Beyond the reach the layer is copied, whatever the air: a checkerboard, moved about within 30 pixels only.
    const checks = new Float32Array(SIZE * SIZE * 4);
    for (let i = 0; i < SIZE * SIZE; ++i)
        checks.fill((((i % SIZE) >> 3) + (Math.floor(i / SIZE) >> 3)) & 1, i * 4, i * 4 + 4);
    const near = await shimmered(device, { heightM: 1, altitude: 3, reach: 30 * PIXEL, time: 2, pixels: checks });
    let outside = 0;
    for (let y = 0; y < SIZE; ++y)
        for (let x = 0; x < SIZE; ++x) {
            const i = (y * SIZE + x) * 4;
            if (Math.hypot(x + 0.5 - SIZE / 2, y + 0.5 - SIZE / 2) > 31)
                outside = Math.max(outside, Math.abs((near.after[i] as number) - (near.before[i] as number)));
        }
    expect(outside).toBeLessThan(2e-3);
    expect(difference(near.after, near.before)).toBeGreaterThan(1e-3);
});

test("from orbit a body above the limb holds still, and one in it shimmers", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const table = airTable(DEFAULT_ATMOSPHERE_MODEL, 408_000);
    const above = await shimmered(device, { heightM: 408_000, altitude: table.top + 1, time: 3 });
    expect(difference(above.after, above.before)).toBeLessThan(1e-4);
    const within = await shimmered(device, { heightM: 408_000, altitude: table.horizon + 0.3, time: 3 });
    expect(difference(within.after, within.before)).toBeGreaterThan(0.001);
});

test("the pass is left out where nothing would show, and reaches as far as the air moves the image", () => {
    const table = airTable(DEFAULT_ATMOSPHERE_MODEL, 1);
    const lens = { aperture: 0.1 };
    const [low, high] = [airAt(table, 3) as Air, airAt(table, 80) as Air];
    // A Moon 300 pixels across shows the air's work near the horizon, one of 30 pixels overhead does not.
    expect(shimmerShows(lens, low, 0.52 / 300)).toBe(true);
    expect(shimmerShows(lens, high, 0.52 / 30)).toBe(false);
    expect(shimmerShows(lens, high, 0.52 / 30, { motion: 0, boiling: 0, dispersion: 0 })).toBe(false);
    const extent = shimmerExtent(lens, low);
    expect(extent).toBeCloseTo(
        (10 * shimmerScales(lens, low.seeing).tilt) / DEG + AIR_DISPERSION * low.bend * low.dilution,
        9,
    );
    expect(shimmerReach(lens, low, 0.26, PIXEL)).toBeCloseTo(1.3 * 0.26 + 4 * PIXEL + extent, 9);
});
