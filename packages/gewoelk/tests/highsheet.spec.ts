import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { expect, test } from "@playwright/test";
import { type Contrail, contrailBehind } from "../src/contrails.js";
import { DEFAULT_LAYERED_PARAMS } from "../src/layers.js";
import { DEFAULT_CLOUD_PARAMS, paramsData, sunlightData } from "../src/params.js";
import { cloudOutput } from "../src/wgsl/output.js";
import { compileWgsl, composedSource, gpuDevice } from "./gpu.js";

const source = (path: string) => composedSource(path) ?? readFileSync(new URL(path, import.meta.url), "utf8");

// Each shader with exactly the fragments its header names, so none grows a dependency it does not declare.
const PASSES: Record<string, readonly string[]> = {
    highmap: ["noise", "../src/wgsl/highmap.comp.wgsl"],
    highsheet: ["params", "../../dunstkreis/src/wgsl/camera.wgsl", "../src/wgsl/highsheet.comp.wgsl"],
};
const OUTPUTS: Record<string, string> = { highsheet: cloudOutput("rgba16float") };

for (const [name, fragments] of Object.entries(PASSES)) {
    test(`the ${name} shader compiles from its declared fragments`, async () => {
        const device = await gpuDevice();
        test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
        if (!device) return;
        const errors = await compileWgsl(device, [OUTPUTS[name] ?? "", ...fragments.map(source)].join("\n"));
        expect(errors, `${name}:\n${errors.join("\n")}`).toEqual([]);
    });
}

/** The pass from its source, its shaders imported as the strings the build inlines them as. */
function highSheetSource(): Promise<typeof import("../src/highsheet.js")> {
    registerHooks({
        load(url, context, nextLoad) {
            if (!url.endsWith(".wgsl")) return nextLoad(url, context);
            const source = `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))};`;
            return { format: "module", shortCircuit: true, source };
        },
    });
    return import("../src/highsheet.js");
}

test("the high sheet bakes its map once and covers some of the sky overhead", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const { readTexture } = await import("@himmelszelt/dunstkreis");
    const { createHighSheet } = await highSheetSource();
    device.pushErrorScope("validation");
    const pass = await createHighSheet(device, { mapSize: 1024 });
    const uniform = (data: ArrayBuffer) => {
        const buffer = device.createBuffer({
            size: data.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(buffer, 0, data);
        return buffer;
    };
    // Looking straight up, north at the top, 90 degrees across.
    const inverseViewProjection = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0]);
    const frame = { ...DEFAULT_CLOUD_PARAMS, inverseViewProjection };
    const [params, sunlight] = [uniform(paramsData(frame, 0)), uniform(sunlightData(frame))];
    const [width, height] = [64, 48];

    const encoder = device.createCommandEncoder();
    expect(pass.update(DEFAULT_LAYERED_PARAMS, encoder)).toBe(true);
    expect(pass.update(DEFAULT_LAYERED_PARAMS, encoder)).toBe(false);
    // The billows creep and the sheet drifts without another bake; a new shape is one.
    expect(pass.update({ ...DEFAULT_LAYERED_PARAMS, timeS: 60 }, encoder)).toBe(false);
    const ribbed = { ...DEFAULT_LAYERED_PARAMS.sky.high, ribs: 0.5, combing: 3 };
    const sky = { ...DEFAULT_LAYERED_PARAMS.sky, high: ribbed };
    expect(pass.update({ ...DEFAULT_LAYERED_PARAMS, sky }, encoder)).toBe(true);
    // A sheet without clear patches, so there is cloud overhead whatever the seed.
    const closed = {
        ...DEFAULT_LAYERED_PARAMS.sky,
        high: { ...DEFAULT_LAYERED_PARAMS.sky.high, coverage: 1, flakes: 0 },
    };
    pass.update({ ...DEFAULT_LAYERED_PARAMS, sky: closed }, encoder);
    pass.encode(encoder, { params, sunlight, width, height });
    device.queue.submit([encoder.finish()]);
    expect([pass.texture.width, pass.texture.height]).toEqual([width, height]);
    expect(pass.memoryBytes).toBeGreaterThan(1024 * 1024 * 4);

    const { data } = await readTexture(device, pass.texture);
    // A clearing centered far off leaves no sheet overhead; centered on the observer it keeps it.
    const cleared = async (clearingCenterKm: readonly [number, number]) => {
        const encoder = device.createCommandEncoder();
        pass.update(
            { ...DEFAULT_LAYERED_PARAMS, sky: closed, clearingKm: 12, clearingFromKm: 10, clearingCenterKm },
            encoder,
        );
        pass.encode(encoder, { params, sunlight, width, height });
        device.queue.submit([encoder.finish()]);
        return Math.min(...(await readTexture(device, pass.texture)).data.filter((_, i) => i % 4 === 3));
    };
    expect(await cleared([0, 0])).toBeLessThan(0.9);
    expect(await cleared([40, 0])).toBe(1);
    // Without a sheet the sky overhead is clear, until a contrail crosses it.
    const none = { ...DEFAULT_LAYERED_PARAMS.sky, high: { ...DEFAULT_LAYERED_PARAMS.sky.high, coverage: 0 } };
    const streaked = async (contrails: readonly Contrail[]) => {
        const encoder = device.createCommandEncoder();
        pass.update({ ...DEFAULT_LAYERED_PARAMS, sky: none, contrails }, encoder);
        pass.encode(encoder, { params, sunlight, width, height });
        device.queue.submit([encoder.finish()]);
        return Math.min(...(await readTexture(device, pass.texture)).data.filter((_, i) => i % 4 === 3));
    };
    expect(await streaked([])).toBe(1);
    const overhead = { fromKm: [-5, 0], toKm: [5, 0], fromWidthKm: 0.5, toWidthKm: 1, opticalDepth: 0.5 } as const;
    expect(await streaked([overhead])).toBeLessThan(0.95);
    expect(await device.popErrorScope()).toBeNull();
    expect(data.every(Number.isFinite)).toBe(true);
    const through = data.filter((_, i) => i % 4 === 3);
    expect(Math.max(...through)).toBeLessThanOrEqual(1);
    expect(Math.min(...through)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...through)).toBeLessThan(0.9);
    // Where it holds light back, it sends some of its own.
    expect(Math.max(...data.filter((_, i) => i % 4 === 1))).toBeGreaterThan(100);
    pass.destroy();
    params.destroy();
    sunlight.destroy();
});

test("a contrail lies behind its aircraft, as long as it flew while the trail lasted, less the wind's drift", () => {
    const north = { atKm: [3, 4], headingDeg: 0, speedMps: 200 } as const;
    const still = contrailBehind(north, { persistenceS: 100 });
    expect(still.fromKm).toEqual([3, 4]);
    expect(still.toKm[0]).toBeCloseTo(3, 9);
    expect(still.toKm[1]).toBeCloseTo(4 - 20, 9);
    expect(still.toWidthKm).toBeGreaterThan(still.fromWidthKm);
    // A tailwind as fast as the aircraft carries the trail along with it; a crosswind turns it off the heading.
    expect(contrailBehind(north, { persistenceS: 100, wind: [0, 200] }).toKm[1]).toBeCloseTo(4, 9);
    expect(contrailBehind(north, { persistenceS: 100, wind: [50, 0] }).toKm[0]).toBeCloseTo(3 + 5, 9);
});
