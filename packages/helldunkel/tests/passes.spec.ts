import { expect, test } from "@playwright/test";
import type { MeterFocus } from "../dist/index.js";
import {
    adaptEV100,
    createBloomPass,
    createMeterPass,
    METER_BINS,
    METER_BINS_PER_STOP,
    METER_LOWEST_STOP,
    meteredLuminance,
} from "../dist/index.js";
import { gpuDevice } from "./gpu.js";

const SIZE = 64;

/** A histogram with these shares of the sphere at these luminances, all of it in luminance. */
function histogramOf(places: [number, number][]) {
    const luminance = new Float64Array(METER_BINS);
    for (const [value, share] of places) {
        const bin = value > 0 ? Math.round((Math.log2(value) - METER_LOWEST_STOP) * METER_BINS_PER_STOP) : 0;
        luminance[bin] = (luminance[bin] ?? 0) + share;
    }
    return { red: luminance, green: luminance, blue: luminance, luminance, peak: luminance };
}

test("the mean is geometric, and a place counts at most so many stops below the brightest percent", () => {
    const mean = (places: [number, number][], rangeStops?: number) =>
        meteredLuminance(histogramOf(places), rangeStops === undefined ? {} : { rangeStops });
    expect(
        mean([
            [1, 0.5],
            [4, 0.5],
        ]),
    ).toBeCloseTo(2, 10);
    expect(
        mean(
            [
                [1024, 0.5],
                [0, 0.5],
            ],
            10,
        ),
    ).toBeCloseTo(32, 10);
    // Half a percent of a lamp lifts neither the floor nor, much, the mean.
    expect(
        mean(
            [
                [1, 0.995],
                [2 ** 20, 0.005],
            ],
            10,
        ),
    ).toBeCloseTo(2 ** (0.005 * 20), 6);
    expect(mean([[0, 1]])).toBe(0);
});

/** An rgba16float image of `pixel(x, y)`, readable and bindable. */
function image(device: GPUDevice, pixel: (x: number, y: number) => number) {
    const texture = device.createTexture({
        size: [SIZE, SIZE],
        format: "rgba32float",
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    const data = new Float32Array(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; ++y)
        for (let x = 0; x < SIZE; ++x) data.fill(pixel(x, y), (y * SIZE + x) * 4, (y * SIZE + x) * 4 + 3);
    device.queue.writeTexture({ texture }, data, { bytesPerRow: SIZE * 16 }, [SIZE, SIZE]);
    return texture;
}

/** The same image in half floats, written by a compute pass from a float one, and what bloom makes of it, read back. */
async function bloomed(device: GPUDevice, pixel: (x: number, y: number) => number, strength: number) {
    const float = image(device, pixel);
    const half = (usage: number) => device.createTexture({ size: [SIZE, SIZE], format: "rgba16float", usage });
    const source = half(GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);
    const target = half(GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC);
    const convert = device.createComputePipeline({
        layout: "auto",
        compute: {
            module: device.createShaderModule({
                code: `@group(0) @binding(0) var from_: texture_2d<f32>;
@group(0) @binding(1) var to_: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
    textureStore(to_, vec2i(id.xy), vec4f(textureLoad(from_, id.xy, 0).rgb, 1.0));
}`,
            }),
            entryPoint: "main",
        },
    });
    const bloom = await createBloomPass(device);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(convert);
    pass.setBindGroup(
        0,
        device.createBindGroup({
            layout: convert.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: float.createView() },
                { binding: 1, resource: source.createView() },
            ],
        }),
    );
    pass.dispatchWorkgroups(SIZE, SIZE);
    pass.end();
    bloom.encode(encoder, source, target, strength);
    const read = device.createBuffer({
        size: 512 * SIZE,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow: 512 }, [SIZE, SIZE]);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const bytes = new DataView(read.getMappedRange());
    const half16 = (bits: number) => {
        const e = (bits >> 10) & 31;
        const f = bits & 1023;
        return (
            (bits >> 15 ? -1 : 1) *
            (e === 0 ? f / 2 ** 24 : e === 31 ? Number.POSITIVE_INFINITY : (1 + f / 1024) * 2 ** (e - 15))
        );
    };
    const at = (x: number, y: number) => half16(bytes.getUint16(y * 512 + x * 8, true));
    return {
        at,
        cleanup: () => {
            for (const t of [float, source, target]) t.destroy();
        },
    };
}

test("bloom leaves an even image as it is", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const { at, cleanup } = await bloomed(device, () => 2, 0.5);
    for (const [x, y] of [
        [0, 0],
        [32, 32],
        [63, 10],
    ] as const)
        expect(at(x, y)).toBeCloseTo(2, 2);
    cleanup();
});

test("bloom spreads a bright place, falling off with distance, and strength 0 changes nothing", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const spot = (x: number, y: number) => (Math.hypot(x - 32, y - 32) < 3 ? 8 : 0.1);
    const { at, cleanup } = await bloomed(device, spot, 0.2);
    expect(at(32, 40)).toBeGreaterThan(0.1);
    expect(at(32, 40)).toBeGreaterThan(at(32, 60));
    expect(at(32, 32)).toBeLessThan(8);
    cleanup();
    const none = await bloomed(device, spot, 0);
    expect(none.at(32, 40)).toBeCloseTo(0.1, 2);
    none.cleanup();
});

test("the meter reads an even image and an even cube map as they are", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const flat = image(device, () => 4);
    const meter = await createMeterPass(device, { source: "2d" });
    const encoder = device.createCommandEncoder();
    meter.encode(encoder, flat);
    device.queue.submit([encoder.finish()]);
    expect(await meter.readLuminance()).toBeCloseTo(4, 3);
    expect(await meter.readEV100()).toBeCloseTo(Math.log2((4 * 100) / 12.5), 3);
    flat.destroy();
    meter.destroy();

    const cube = device.createTexture({
        size: [4, 4, 6],
        format: "rgba32float",
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
        textureBindingViewDimension: "cube",
    });
    device.queue.writeTexture(
        { texture: cube },
        new Float32Array(4 * 4 * 6 * 4).fill(0.5),
        { bytesPerRow: 64, rowsPerImage: 4 },
        [4, 4, 6],
    );
    const sphere = await createMeterPass(device, { source: "cube" });
    const next = device.createCommandEncoder();
    sphere.encode(next, cube);
    device.queue.submit([next.finish()]);
    expect(await sphere.readLuminance()).toBeCloseTo(0.5, 3);
    cube.destroy();
    sphere.destroy();
});

test("the meter counts every texel, by the solid angle it covers", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    // The upper half 8, the lower 2, the same share of the sphere.
    const sky = image(device, (_, y) => (y < SIZE / 2 ? 8 : 2));
    const meter = await createMeterPass(device, { source: "equirectangular" });
    const read = async (focus?: MeterFocus) => {
        const encoder = device.createCommandEncoder();
        meter.encode(encoder, sky, focus ? { focus } : {});
        device.queue.submit([encoder.finish()]);
        return meter.readLuminance();
    };
    expect(await read()).toBeCloseTo(4, 3);
    const histogram = await meter.readHistogram();
    const bin = (value: number) => (Math.log2(value) - METER_LOWEST_STOP) * METER_BINS_PER_STOP;
    expect(histogram.luminance[bin(8)]).toBeCloseTo(0.5, 2);
    expect(histogram.red[bin(2)]).toBeCloseTo(0.5, 2);
    expect(histogram.peak[bin(8)]).toBeCloseTo(0.5, 2);
    // A spot on the zenith sees the upper half alone, on the nadir the lower.
    expect(await read({ direction: [0, 0, 1], innerAngle: 0.5, outerAngle: 0.6 })).toBeCloseTo(8, 3);
    expect(await read({ direction: [0, 0, -1], innerAngle: 0.5, outerAngle: 0.6 })).toBeCloseTo(2, 3);
    sky.destroy();

    // The columns at the panorama's seam lit, azimuth from north: a spot to the north sees them alone.
    const north = image(device, (x) => (x === 0 || x === SIZE - 1 ? 8 : 2));
    const onNorth = device.createCommandEncoder();
    meter.encode(onNorth, north, { focus: { direction: [0, 1, 0], innerAngle: 0.08, outerAngle: 0.12 } });
    device.queue.submit([onNorth.finish()]);
    expect(await meter.readLuminance()).toBeCloseTo(8, 2);
    north.destroy();
    meter.destroy();

    // An infinite place is left out.
    const lamp = image(device, (x, y) => (x === 3 && y === 3 ? Number.POSITIVE_INFINITY : 4));
    const flat = await createMeterPass(device, { source: "2d" });
    const encoder = device.createCommandEncoder();
    flat.encode(encoder, lamp);
    device.queue.submit([encoder.finish()]);
    expect(await flat.readLuminance()).toBeCloseTo(4, 3);
    lamp.destroy();
    flat.destroy();
});

test("percentiles keep the middle, and an exposure adapts faster or slower by the direction", () => {
    const places: [number, number][] = [
        [1, 0.1],
        [4, 0.8],
        [2 ** 20, 0.1],
    ];
    expect(meteredLuminance(histogramOf(places), { percentiles: [0.1, 0.9] })).toBeCloseTo(4, 6);
    expect(adaptEV100(0, 4, 1, { toBrighter: 1, toDarker: 4 })).toBeCloseTo(4 * (1 - Math.exp(-1)), 10);
    expect(adaptEV100(4, 0, 4, { toBrighter: 1, toDarker: 4 })).toBeCloseTo(4 * Math.exp(-1), 10);
});

test("the reading on the GPU matches the CPU's, follows a mask and adapts without a round trip", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const sky = image(device, (_, y) => (y < SIZE / 2 ? 8 : 2));
    const meter = await createMeterPass(device, { source: "equirectangular" });
    const staging = device.createBuffer({ size: 12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const read = async (reading: Parameters<typeof meter.encode>[2]) => {
        const encoder = device.createCommandEncoder();
        meter.encode(encoder, sky, reading);
        encoder.copyBufferToBuffer(meter.result, 0, staging, 0, 12);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const [luminance = 0, ev100 = 0, adapted = 0] = new Float32Array(staging.getMappedRange().slice(0));
        staging.unmap();
        return { luminance, ev100, adapted, cpu: await meter.readLuminance() };
    };
    const whole = await read({});
    expect(whole.luminance).toBeCloseTo(whole.cpu, 3);
    expect(whole.ev100).toBeCloseTo(Math.log2((whole.cpu * 100) / 12.5), 3);
    const filtered = await read({ percentiles: [0.6, 0.9] });
    expect(filtered.luminance).toBeCloseTo(8, 3);
    expect(filtered.cpu).toBeCloseTo(8, 3);

    const lower = device.createTexture({
        size: [1, 2],
        format: "r8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: lower }, new Uint8Array([0, 255]), { bytesPerRow: 1 }, [1, 2]);
    expect((await read({ mask: lower })).luminance).toBeCloseTo(2, 3);

    // From EV 4 of the lower half towards EV 6 of the upper: one time constant goes 63% of the way.
    const upper = { toBrighter: 1, toDarker: 1, seconds: 1 };
    const next = await read({ focus: { direction: [0, 0, 1], innerAngle: 0.5, outerAngle: 0.6 }, adapt: upper });
    expect(next.ev100).toBeCloseTo(6, 3);
    expect(next.adapted).toBeCloseTo(6 - 2 * Math.exp(-1), 3);
    for (const made of [sky, lower, staging]) made.destroy();
    meter.destroy();
});

test("a thinned reading stays close to counting everything", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const gradient = image(device, (x, y) => 2 ** ((x / SIZE) * 6 + (y / SIZE) * 2));
    const meter = await createMeterPass(device, { source: "2d" });
    const read = async (maxSize?: number) => {
        const encoder = device.createCommandEncoder();
        meter.encode(encoder, gradient, maxSize ? { maxSize } : {});
        device.queue.submit([encoder.finish()]);
        return Math.log2(await meter.readLuminance());
    };
    const full = await read();
    expect(Math.abs((await read(32)) - full)).toBeLessThan(0.1);
    gradient.destroy();
    meter.destroy();
});

test("a panorama counts by solid angle, also thinned, and a thinned spot still looks where it should", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const meter = await createMeterPass(device, { source: "equirectangular" });
    const read = async (source: GPUTexture, reading: Parameters<typeof meter.encode>[2] = {}) => {
        const encoder = device.createCommandEncoder();
        meter.encode(encoder, source, reading);
        device.queue.submit([encoder.finish()]);
        return meter.readHistogram();
    };
    // The top quarter of the rows covers (1 - cos 45°) / 2 of the sphere, 14.6%, not a quarter.
    const cap = image(device, (_, y) => (y < SIZE / 4 ? 8 : 2));
    const eight = (Math.log2(8) - METER_LOWEST_STOP) * METER_BINS_PER_STOP;
    const share = (1 - Math.SQRT1_2) / 2;
    expect((await read(cap)).luminance[eight]).toBeCloseTo(share, 2);
    expect(Math.abs(((await read(cap, { maxSize: 32 })).luminance[eight] as number) - share)).toBeLessThan(0.02);
    // A thinned spot at the zenith sees the lit cap alone, at the nadir none of it.
    const spot = (z: number) => ({ focus: { direction: [0, 0, z], innerAngle: 0.5, outerAngle: 0.6 } }) as const;
    expect((await read(cap, { ...spot(1), maxSize: 32 })).luminance[eight]).toBeCloseTo(1, 3);
    expect((await read(cap, { ...spot(-1), maxSize: 32 })).luminance[eight]).toBeCloseTo(0, 3);
    cap.destroy();
    meter.destroy();
});
