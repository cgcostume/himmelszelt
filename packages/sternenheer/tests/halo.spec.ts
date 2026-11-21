import { expect, test } from "@playwright/test";
import {
    createStarsPass,
    haloLevelWidth,
    haloWeights,
    illuminanceFromMagnitude,
    type StarsParams,
} from "../dist/index.js";
import { gpuDevice } from "./gpu.js";

const DEG = Math.PI / 180;
const Y = [0.2126, 0.7152, 0.0722] as const;
// The halo's logarithmic curve, SH_HALO_KNEE in params.wgsl.
const HALO_KNEE = 0.25;
// An exposure of 1: the pass writes cd/m².
const UNIT_EV100 = -Math.log2(1.2);

/** A pinhole looking east at the equinox, `fov` radians high and wide. */
function eastward(fov: number): Float32Array {
    const t = Math.tan(fov / 2);
    return new Float32Array([0, -t, 0, 0, 0, 0, t, 0, 0, 0, 0, 1, 1, 0, 0, 0]);
}

/** One white star of `magnitude` at the view's center, drawn into a square float target of `size` pixels over `fov`
 *  and read back, with what the pass says of its light and what it left between its passes. */
async function drawOne(device: GPUDevice, size: number, fov: number, magnitude: number, params: Partial<StarsParams>) {
    const pass = await createStarsPass(device, {
        format: "rgba32float",
        catalog: { count: 1, data: new Float32Array([magnitude, 0, 0, 0, 0, 1, 1, 1]), compact: false },
        toneMap: false,
        background: false,
        debug: true,
    });
    const displayEV100 = -9;
    pass.update({ ev100: UNIT_EV100, displayEV100, inverseViewProjection: eastward(fov), ...params });
    const target = device.createTexture({
        size: [size, size],
        format: "rgba32float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const read = device.createBuffer({
        size: size * size * 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    pass.encode(encoder, target);
    encoder.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow: size * 16 }, [size, size]);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const pixels = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    const [star] = await pass.readStars(0, 1);
    const inspection = await pass.inspect();
    read.destroy();
    target.destroy();
    pass.destroy();
    if (!star) throw new Error("no star");
    const w = (2 * Math.tan(fov / 2)) / size;
    // A pinhole's pixel spans w² cos³θ of sky.
    const solidAngle = (x: number, y: number) =>
        w * w * (1 + ((x + 0.5 - size / 2) * w) ** 2 + ((y + 0.5 - size / 2) * w) ** 2) ** -1.5;
    return { pixels, star, inspection, solidAngle, exposure: 1 / (1.2 * 2 ** displayEV100), pixelSolidAngle: w * w };
}

/** The halo's light per pixel as it was spread, its logarithmic curve undone, in cd/m²: a pixel's light less the core's
 *  Gaussian, which the star's own numbers give. */
function haloLight(drawn: Awaited<ReturnType<typeof drawOne>>, size: number, x: number, y: number): number {
    const at = (y * size + x) * 4;
    const shown = Math.max(drawn.pixels[at] ?? 0, drawn.pixels[at + 1] ?? 0, drawn.pixels[at + 2] ?? 0);
    const luminance = Y.reduce((sum, c, i) => sum + c * (drawn.pixels[at + i] ?? 0), 0);
    const [cx, cy] = drawn.star.pixel;
    const sigma = 0.7;
    const core =
        (drawn.star.light *
            drawn.star.core *
            Math.exp(-((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) / (2 * sigma * sigma))) /
        (2 * Math.PI * sigma * sigma * drawn.pixelSolidAngle);
    const m = Math.max(shown - core, 0) * drawn.exposure;
    const undo = m > 1e-12 ? (HALO_KNEE * Math.expm1(Math.min(m / HALO_KNEE, 80))) / m : 1;
    return Math.max(luminance - core, 0) * undo;
}

test("the halo's shares add up to all of its light, and its width moves it to coarser levels", () => {
    for (const width of [0, 0.3, 1, 4, 30, 300]) {
        const weights = haloWeights(width, 10);
        expect(weights.reduce((sum, w) => sum + w, 0)).toBeCloseTo(1, 12);
        expect(Math.min(...weights)).toBeGreaterThanOrEqual(0);
    }
    expect(haloWeights(0, 8)[0]).toBe(1);
    // A level's width nearly doubles from one to the next.
    expect(haloLevelWidth(5) / haloLevelWidth(4)).toBeCloseTo(2, 2);
    const mean = (w: Float64Array) => w.reduce((sum, v, k) => sum + v * k, 0);
    expect(mean(haloWeights(8, 10))).toBeGreaterThan(mean(haloWeights(2, 10)) + 1.5);
});

test("the halo shows the light the knee sends it, and its share", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    // Sirius-bright in a view a pixel of 5 arcminutes: its peak far past the knee.
    const [size, fov] = [512, 40 * DEG];
    for (const halo of [1, 0.3]) {
        const drawn = await drawOne(device, size, fov, -1.5, { halo });
        const { star, inspection } = drawn;
        expect(star.drawn).toBe(true);
        expect(star.light).toBeCloseTo(illuminanceFromMagnitude(-1.5), 9);
        // The core keeps little, the halo its share of the rest.
        expect(star.core).toBeLessThan(0.05);
        expect(star.halo).toBeCloseTo(halo * (1 - star.core), 2);
        // The grid as spread, before the curve: its finest level summed over its texels, two by two pixels each.
        const levels = inspection.halo?.levels ?? [];
        const finest = levels[0];
        if (!finest) throw new Error("no halos");
        let spread = 0;
        for (let i = 0; i < finest.width * finest.height; i++)
            spread += Y.reduce((sum, c, k) => sum + c * (finest.sum[i * 4 + k] ?? 0), 0) * 4;
        const sent = (star.light * star.halo * drawn.exposure) / drawn.pixelSolidAngle;
        expect(Math.abs(spread / sent - 1)).toBeLessThan(0.01);
        // And on the target, the curve undone per pixel: all of it but what falls past the target's edges.
        let shown = 0;
        for (let y = 0; y < size; y++)
            for (let x = 0; x < size; x++) shown += haloLight(drawn, size, x, y) * drawn.solidAngle(x, y);
        expect(Math.abs(shown / (star.light * star.halo) - 1)).toBeLessThan(0.02);
    }
});

test("a halo holds the same light whatever the target's resolution", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const fov = 40 * DEG;
    // The light the halo shows, its curve undone, summed over the target, of the light the knee sent it: the knee
    // itself takes more where a pixel spans more sky.
    const shown = async (size: number) => {
        const drawn = await drawOne(device, size, fov, -1.5, {});
        let sum = 0;
        for (let y = 0; y < size; y++)
            for (let x = 0; x < size; x++) sum += haloLight(drawn, size, x, y) * drawn.solidAngle(x, y);
        return sum / (drawn.star.light * drawn.star.halo);
    };
    const [small, large] = [await shown(128), await shown(512)];
    expect(Math.abs(small - 1)).toBeLessThan(0.02);
    expect(Math.abs(large - 1)).toBeLessThan(0.02);
});

test("without a halo nothing of it is made or run", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const made: string[] = [];
    const counting = new Proxy(device, {
        get(target, property) {
            if (property === "createBuffer" || property === "createTexture")
                return (descriptor: { label?: string }) => {
                    made.push(descriptor.label ?? "");
                    return (target[property] as (d: unknown) => unknown).call(target, descriptor);
                };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    const pass = await createStarsPass(counting, {
        format: "rgba32float",
        catalog: { count: 1, data: new Float32Array([-1.5, 0, 0, 0, 0, 1, 1, 1]), compact: false },
        toneMap: false,
        background: false,
    });
    const target = device.createTexture({
        size: [256, 256],
        format: "rgba32float",
        usage: GPUTextureUsage.STORAGE_BINDING,
    });
    const frame = (halo: number) => {
        pass.update({ halo, displayEV100: -9, inverseViewProjection: eastward(40 * DEG) });
        const passes: string[] = [];
        const encoder = device.createCommandEncoder();
        const watched = new Proxy(encoder, {
            get(t, property) {
                if (property === "beginComputePass")
                    return (descriptor: GPUComputePassDescriptor) => {
                        passes.push(descriptor.label ?? "");
                        return t.beginComputePass(descriptor);
                    };
                const value = Reflect.get(t, property, t);
                return typeof value === "function" ? value.bind(t) : value;
            },
        });
        pass.encode(watched, target);
        device.queue.submit([encoder.finish()]);
        return passes;
    };
    expect(frame(0)).not.toContain("sternenheer:halo");
    expect(made.filter((label) => /halo/i.test(label))).toEqual([]);
    expect(frame(1)).toContain("sternenheer:halo");
    expect(made.filter((label) => /halo/i.test(label)).length).toBeGreaterThan(0);
    await device.queue.onSubmittedWorkDone();
    target.destroy();
    pass.destroy();
});
