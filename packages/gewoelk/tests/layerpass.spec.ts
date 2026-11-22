import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { expect, test } from "@playwright/test";
import { cloudOutput } from "../src/wgsl/output.js";
import { compileWgsl, gpuDevice } from "./gpu.js";

/** A shader by name, this package's or dunstkreis' camera, which it bundles. */
function wgslSource(name: string): string {
    const owner = name === "camera" ? "../../dunstkreis/src/wgsl" : "../src/wgsl";
    const read = (file: string) => readFileSync(new URL(`${owner}/${file}`, import.meta.url), "utf8");
    try {
        return read(`${name}.wgsl`);
    } catch {
        return read(`${name}.comp.wgsl`);
    }
}

// Each pass with exactly the fragments its header names, so none grows a dependency it does not declare.
const PASSES: Record<string, readonly string[]> = {
    layermap: ["noise", "layermap"],
    layerpyramid: ["layerpyramid"],
    layers: ["params", "camera", "rainbow", "layerread", "layers", "godrays"],
};
const OUTPUTS: Record<string, string> = { layers: cloudOutput("rgba16float") };

// The pass from its source, which imports its shaders as the bundler inlines them: as strings.
const wgslAsStrings = () =>
    registerHooks({
        load(url, context, nextLoad) {
            if (!url.endsWith(".wgsl")) return nextLoad(url, context);
            const source = `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))};`;
            return { format: "module", source, shortCircuit: true };
        },
    });

for (const [name, fragments] of Object.entries(PASSES)) {
    test(`the ${name} pass compiles from its declared fragments`, async () => {
        const device = await gpuDevice();
        test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
        if (!device) return;
        const errors = await compileWgsl(device, [OUTPUTS[name] ?? "", ...fragments.map(wgslSource)].join("\n"));
        expect(errors, `${name}:\n${errors.join("\n")}`).toEqual([]);
    });
}

test("the layers bake their maps and march into a texture of finite light, some of it cloud, and rain under towers", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    wgslAsStrings();
    const { readTexture } = await import("@himmelszelt/dunstkreis");
    const { createLayerMarch, DEFAULT_LAYER_MARCH } = await import("../src/layerpass.js");
    const { DEFAULT_LAYERED_PARAMS, DEFAULT_LAYERED_SKY } = await import("../src/layers.js");
    const { DEFAULT_CLOUD_PARAMS, paramsData, sunlightData } = await import("../src/params.js");

    device.pushErrorScope("validation");
    const uniform = (data: ArrayBuffer) => {
        const buffer = device.createBuffer({
            size: data.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(buffer, 0, data);
        return buffer;
    };
    // Looking north along the horizon from the ground, the sun 60 degrees up in the north.
    const frame = { ...DEFAULT_CLOUD_PARAMS };
    const [params, sunlight] = [uniform(paramsData(frame, 1)), uniform(sunlightData(frame))];
    const march = await createLayerMarch(device, { mapSize: 128 });
    const sky = { ...DEFAULT_LAYERED_SKY, deep: { ...DEFAULT_LAYERED_SKY.deep, coverage: 0.6 } };
    const size = 48;
    const render = () => {
        const encoder = device.createCommandEncoder();
        const baked = march.update({ ...DEFAULT_LAYERED_PARAMS, sky }, encoder);
        march.encode(encoder, { params, sunlight, width: size, height: size });
        device.queue.submit([encoder.finish()]);
        return baked;
    };
    // The first update bakes the maps; the same sky again leaves them.
    expect(render()).toBe(true);
    expect(render()).toBe(false);
    expect([march.texture.width, march.texture.height]).toEqual([size, size]);
    const { data } = await readTexture(device, march.texture);
    // The depth beside it, distances summed by their shares of the pixel and the shares: where a pixel is mostly cloud
    // their quotient is a distance within the march's reach.
    const { data: depth } = await readTexture(device, march.depth);
    expect([march.depth.width, march.depth.height]).toEqual([size, size]);
    const shown = Array.from({ length: size * size }, (_, i) => [depth[i * 4] ?? 0, depth[i * 4 + 1] ?? 0] as const);
    const cloud = shown.filter(([, share]) => share > 0.5).map(([sum, share]) => sum / share);
    expect(cloud.length).toBeGreaterThan(size);
    expect(cloud.every((km) => Number.isFinite(km) && km > 0 && km < DEFAULT_LAYER_MARCH.reachKm)).toBe(true);
    expect(
        shown.every(
            ([sum, share], i) =>
                share <= 1 && (share > 0 || sum === 0) && (share < 0.6 || (data[i * 4 + 3] ?? 1) < 0.5),
        ),
    ).toBe(true);
    // The lowest rows look into the ground, short of any cloud.
    expect(shown.slice(size * (size - 4)).every(([sum, share]) => sum === 0 && share === 0)).toBe(true);
    const through = (frame: ArrayLike<number>) =>
        Array.from(frame).reduce((sum, x, i) => sum + (i % 4 === 3 ? x : 0), 0);
    const dry = through(data);
    // Rain under the towers: its phase function's table is made, and the rain hides more of what lies behind.
    sky.deep.rain = 10;
    render();
    const { data: wet } = await readTexture(device, march.texture);
    expect(await device.popErrorScope()).toBeNull();
    expect(wet.every((value, i) => Number.isFinite(value) && value >= 0 && (i % 4 < 3 || value <= 1))).toBe(true);
    expect(through(wet)).toBeLessThan(dry);

    // No light below none, and no more let through than all of it.
    expect(data.every((value, i) => Number.isFinite(value) && value >= 0 && (i % 4 < 3 || value <= 1))).toBe(true);
    // Clouds in a good share of the upper half, the sky above the horizon: lit, and hiding what lies behind.
    const above = Array.from({ length: (size * size) / 2 }, (_, i) => [data[i * 4 + 1] ?? 0, data[i * 4 + 3] ?? 1]);
    const cloudy = above.filter(([green, through]) => (through as number) < 0.5 && (green as number) > 100);
    expect(cloudy.length).toBeGreaterThan(above.length / 10);
    // A sky without clouds lets everything through, and is nowhere.
    Object.assign(sky, { low: { ...sky.low, coverage: 0 }, middle: { ...sky.middle, coverage: 0 } });
    sky.deep.coverage = 0;
    render();
    const { data: none } = await readTexture(device, march.texture);
    expect(none.every((value, i) => value === (i % 4 < 3 ? 0 : 1))).toBe(true);
    expect((await readTexture(device, march.depth)).data.every((value) => value === 0)).toBe(true);
    march.destroy();
    params.destroy();
    sunlight.destroy();
});

test("a clearing set off from the observer leaves a patch of cloud where it is centered, and none elsewhere", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    wgslAsStrings();
    const { readTexture } = await import("@himmelszelt/dunstkreis");
    const { createLayerMarch } = await import("../src/layerpass.js");
    const { CLOUD_TYPES, DEFAULT_LAYERED_PARAMS, DEFAULT_LAYERED_SKY } = await import("../src/layers.js");
    const { DEFAULT_CLOUD_PARAMS, paramsData, sunlightData } = await import("../src/params.js");

    device.pushErrorScope("validation");
    const frame = { ...DEFAULT_CLOUD_PARAMS };
    const usage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    const [params, sunlight] = [paramsData(frame, 1), sunlightData(frame)].map((data) => {
        const buffer = device.createBuffer({ size: data.byteLength, usage });
        device.queue.writeBuffer(buffer, 0, data);
        return buffer;
    }) as [GPUBuffer, GPUBuffer];
    const march = await createLayerMarch(device, { mapSize: 128 });
    const none = { coverage: 0 };
    // Looking north along the horizon from the ground, under a closed deck cleared to a disc of 12 km.
    const sky = {
        ...DEFAULT_LAYERED_SKY,
        low: { ...DEFAULT_LAYERED_SKY.low, ...CLOUD_TYPES.low.deck, coverage: 1 },
        deep: { ...DEFAULT_LAYERED_SKY.deep, ...none },
        middle: { ...DEFAULT_LAYERED_SKY.middle, ...none },
    };
    const size = 48;
    const patch = async (clearingCenterKm?: readonly [number, number]) => {
        const encoder = device.createCommandEncoder();
        const cleared = { clearingKm: 12, clearingFromKm: 10, ...(clearingCenterKm && { clearingCenterKm }) };
        march.update({ ...DEFAULT_LAYERED_PARAMS, sky, ...cleared }, encoder);
        march.encode(encoder, { params, sunlight, width: size, height: size });
        device.queue.submit([encoder.finish()]);
        return (await readTexture(device, march.texture)).data;
    };
    // The sky's rows, over the horizon: how many of their pixels are mostly cloud.
    const cloudy = (data: Float32Array) =>
        Array.from({ length: (size * size) / 2 }, (_, i) => data[i * 4 + 3] ?? 1).filter((a) => a < 0.5).length;
    const around = await patch();
    // Centered on the observer it is the clearing as it was, to the bit.
    expect(new Uint32Array((await patch([0, 0])).buffer)).toEqual(new Uint32Array(around.buffer));
    const ahead = await patch([0, 15]);
    const behind = await patch([0, -15]);
    expect(await device.popErrorScope()).toBeNull();
    // A disc 15 km to the north stands in the view, low over the horizon; one as far south is nowhere in it.
    expect(cloudy(ahead)).toBeGreaterThan(size);
    expect(cloudy(behind)).toBe(0);
    expect(ahead.every((value) => Number.isFinite(value))).toBe(true);
    march.destroy();
    params.destroy();
    sunlight.destroy();
});

test("god rays dim the sky seen under a deck's edge, without grain, and leave a sky without clouds alone", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    wgslAsStrings();
    const { readTexture } = await import("@himmelszelt/dunstkreis");
    const { createLayerMarch } = await import("../src/layerpass.js");
    const { CLOUD_TYPES, DEFAULT_LAYERED_PARAMS, DEFAULT_LAYERED_SKY } = await import("../src/layers.js");
    const { DEFAULT_CLOUD_PARAMS, paramsData, sunlightData } = await import("../src/params.js");

    device.pushErrorScope("validation");
    const uniform = (data: ArrayBuffer) => {
        const buffer = device.createBuffer({
            size: data.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(buffer, 0, data);
        return buffer;
    };
    // Looking north along the horizon from the ground, the sun 60 degrees up in the north, under a deck that ends 12 km
    // out: the rows just over the horizon see the sky beyond its edge, through air the deck shades.
    const frame = { ...DEFAULT_CLOUD_PARAMS };
    const [params, sunlight] = [uniform(paramsData(frame, 1)), uniform(sunlightData(frame))];
    const march = await createLayerMarch(device, { mapSize: 128, godRays: true });
    const none = { coverage: 0 };
    const deck = (coverage: number) => ({
        ...DEFAULT_LAYERED_SKY,
        low: { ...DEFAULT_LAYERED_SKY.low, ...CLOUD_TYPES.low.deck, coverage },
        deep: { ...DEFAULT_LAYERED_SKY.deep, ...none },
        middle: { ...DEFAULT_LAYERED_SKY.middle, ...none },
    });
    const size = 96;
    const strip = async (coverage: number, index: number) => {
        device.queue.writeBuffer(params, 0, paramsData(frame, index));
        const encoder = device.createCommandEncoder();
        march.update({ ...DEFAULT_LAYERED_PARAMS, sky: deck(coverage), clearingKm: 12, clearingFromKm: 8 }, encoder);
        march.encode(encoder, { params, sunlight, width: size, height: size });
        device.queue.submit([encoder.finish()]);
        const { data } = await readTexture(device, march.texture);
        expect(data.every((value, i) => Number.isFinite(value) && value >= 0 && (i % 4 < 3 || value <= 1))).toBe(true);
        // What the three rows over the horizon let through.
        const from = (size / 2 - 3) * size;
        return Array.from({ length: 3 * size }, (_, i) => data[(from + i) * 4 + 3] ?? 1);
    };
    const mean = (values: number[]) => values.reduce((sum, x) => sum + x, 0) / values.length;
    const shaded = await strip(1, 1);
    const again = await strip(1, 2);
    const clear = await strip(0.01, 3);
    expect(await device.popErrorScope()).toBeNull();
    expect(mean(shaded)).toBeLessThan(0.97);
    expect(mean(shaded)).toBeGreaterThan(0.5);
    // The table has no samples to jitter: another frame's rays give the same shade.
    expect(Math.max(...shaded.map((x, i) => Math.abs(x - (again[i] ?? 0))))).toBeLessThan(2e-3);
    expect(mean(clear)).toBeGreaterThan(0.995);
    march.destroy();
    params.destroy();
    sunlight.destroy();
});

test("blue noise jitters the rays as much and the same every frame, and an adaptive stride sees the same clouds by pyramids that hold each block's most", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    wgslAsStrings();
    const { readTexture } = await import("@himmelszelt/dunstkreis");
    const { createLayerMarch } = await import("../src/layerpass.js");
    const { DEFAULT_LAYERED_PARAMS, DEFAULT_LAYERED_SKY } = await import("../src/layers.js");
    const { DEFAULT_CLOUD_PARAMS, paramsData, sunlightData } = await import("../src/params.js");

    device.pushErrorScope("validation");
    const frame = { ...DEFAULT_CLOUD_PARAMS };
    const usage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    const params = device.createBuffer({ size: paramsData(frame, 1).byteLength, usage });
    const sunlight = device.createBuffer({ size: sunlightData(frame).byteLength, usage });
    device.queue.writeBuffer(sunlight, 0, sunlightData(frame));
    const mapSize = 128;
    const [blind, adaptive] = await Promise.all([
        createLayerMarch(device, { mapSize }),
        createLayerMarch(device, { mapSize, adaptiveStride: true }),
    ]);
    expect(blind.pyramids).toBeNull();
    // Heaps, towers with anvils and a middle layer, thinning out towards a clearing.
    const sky = { ...DEFAULT_LAYERED_SKY, deep: { ...DEFAULT_LAYERED_SKY.deep, coverage: 0.5 } };
    const size = 64;
    const through = async (march: typeof blind, index: number, blueNoise: boolean) => {
        device.queue.writeBuffer(params, 0, paramsData(frame, index));
        const encoder = device.createCommandEncoder();
        const layered = { ...DEFAULT_LAYERED_PARAMS, sky, clearingKm: 120, clearingFromKm: 30 };
        march.update(layered, encoder, { settings: { blueNoise } });
        march.encode(encoder, { params, sunlight, width: size, height: size });
        device.queue.submit([encoder.finish()]);
        const { data } = await readTexture(device, march.texture);
        expect(data.every((value, i) => Number.isFinite(value) && value >= 0 && (i % 4 < 3 || value <= 1))).toBe(true);
        return Array.from({ length: size * size }, (_, i) => data[i * 4 + 3] ?? 1);
    };
    const mean = (values: number[]) => values.reduce((sum, x) => sum + x, 0) / values.length;
    const apart = (a: number[], b: number[]) => a.filter((x, i) => Math.abs(x - (b[i] ?? 0)) > 0.5).length;
    const differing = (a: number[], b: number[]) => a.filter((x, i) => x !== b[i]).length;

    // Interleaved gradient noise is another every frame; the blue noise stays, and hides as much sky on the whole.
    const gradient = await through(blind, 1, false);
    expect(differing(gradient, await through(blind, 2, false))).toBeGreaterThan(size);
    const blue = await through(blind, 1, true);
    expect(differing(blue, gradient)).toBeGreaterThan(size);
    expect(differing(blue, await through(blind, 2, true))).toBe(0);
    expect(Math.abs(mean(blue) - mean(gradient))).toBeLessThan(0.01);
    expect(mean(gradient)).toBeLessThan(0.9);

    // The adaptive stride: the same clouds, but for the grain at their edges, and none lost.
    const strided = await through(adaptive, 1, false);
    expect(Math.abs(mean(strided) - mean(gradient))).toBeLessThan(0.01);
    expect(apart(strided, gradient)).toBeLessThan(0.01 * size * size);

    // Its pyramids: a block of the first level holds the most of its two by two texels of the map, the last the whole map's.
    const pyramids = adaptive.pyramids as GPUTexture;
    expect([pyramids.width, pyramids.mipLevelCount]).toEqual([mapSize / 2, Math.log2(mapSize / 2) + 1]);
    for (const layer of [0, 1, 2]) {
        const map = (await readTexture(device, adaptive.maps, layer)).data;
        const first = (await readTexture(device, pyramids, layer, 0)).data;
        const last = (await readTexture(device, pyramids, layer, pyramids.mipLevelCount - 1)).data;
        let short = 0;
        const most = [0, 0, 0, 0];
        for (let y = 0; y < mapSize; y++) {
            for (let x = 0; x < mapSize; x++) {
                for (let c = 0; c < 4; c++) {
                    const value = map[(y * mapSize + x) * 4 + c] ?? 0;
                    most[c] = Math.max(most[c] ?? 0, value);
                    if ((first[((y >> 1) * (mapSize / 2) + (x >> 1)) * 4 + c] ?? 0) < value) short += 1;
                }
            }
        }
        expect(short).toBe(0);
        expect(Array.from(last)).toEqual(most);
    }
    expect(await device.popErrorScope()).toBeNull();
    for (const march of [blind, adaptive]) march.destroy();
    params.destroy();
    sunlight.destroy();
});

test("towers without an anvil have no skirt in their map, and with one they have it in any wind and in none", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    wgslAsStrings();
    const { readTexture } = await import("@himmelszelt/dunstkreis");
    const { createLayerMarch } = await import("../src/layerpass.js");
    const { CLOUD_TYPES, DEFAULT_LAYERED_PARAMS, DEFAULT_LAYERED_SKY } = await import("../src/layers.js");

    device.pushErrorScope("validation");
    const mapSize = 128;
    const march = await createLayerMarch(device, { mapSize });
    // The skirts of a kind's map, texel by texel, and how many of its texels are tower.
    const skirts = async (kind: object, wind: readonly [number, number]) => {
        const deep = { ...DEFAULT_LAYERED_SKY.deep, ...kind, coverage: 0.6 };
        const encoder = device.createCommandEncoder();
        march.update({ ...DEFAULT_LAYERED_PARAMS, sky: { ...DEFAULT_LAYERED_SKY, deep }, wind }, encoder);
        device.queue.submit([encoder.finish()]);
        const { data } = await readTexture(device, march.maps, 1);
        const texels = Array.from({ length: mapSize * mapSize }, (_, i) => [data[i * 4] ?? 0, data[i * 4 + 1] ?? 0]);
        expect(texels.filter(([tower]) => (tower as number) > 0.5).length).toBeGreaterThan(mapSize);
        return texels.map(([, skirt]) => skirt as number);
    };
    const count = (values: number[]) => values.filter((x) => x > 0).length;
    const { congestus, towers } = CLOUD_TYPES.deep;
    expect(count(await skirts(congestus, [3.4, 9.4]))).toBe(0);
    expect(count(await skirts(congestus, [0, 0]))).toBe(0);
    const blown = count(await skirts(towers, [3.4, 9.4]));
    const still = count(await skirts(towers, [0, 0]));
    expect(await device.popErrorScope()).toBeNull();
    expect(still).toBeGreaterThan(mapSize);
    // The wind stretches a skirt.
    expect(blown).toBeGreaterThan(still);
    march.destroy();
});
