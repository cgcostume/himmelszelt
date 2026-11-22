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
    layers: ["params", "camera", "rainbow", "layers", "godrays"],
};
const OUTPUTS: Record<string, string> = { layers: cloudOutput("rgba16float") };

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
    // The pass from its source, which imports its shaders as the bundler inlines them: as strings.
    registerHooks({
        load(url, context, nextLoad) {
            if (!url.endsWith(".wgsl")) return nextLoad(url, context);
            const source = `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))};`;
            return { format: "module", source, shortCircuit: true };
        },
    });
    const { readTexture } = await import("@himmelszelt/dunstkreis");
    const { createLayerMarch } = await import("../src/layerpass.js");
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
    march.destroy();
    params.destroy();
    sunlight.destroy();
});

test("god rays dim the sky seen under a deck's edge, without grain, and leave a sky without clouds alone", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    registerHooks({
        load(url, context, nextLoad) {
            if (!url.endsWith(".wgsl")) return nextLoad(url, context);
            const source = `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))};`;
            return { format: "module", source, shortCircuit: true };
        },
    });
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
