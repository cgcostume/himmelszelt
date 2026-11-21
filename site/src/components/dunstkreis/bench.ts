// The benchmark behind the chapter's "What it costs", for `scripts/bench.mjs dunstkreis`: each piece of the sky on the
// clock that runs it, timed on the GPU's own clock, the pieces in turn round after round, and the GPU memory each holds,
// counted from the buffers and textures it makes.
import {
    type AtmosphereLUTs,
    createSkyPass,
    DEFAULT_ATMOSPHERE_MODEL,
    DEFAULT_TEXTURE_CONFIG,
    precomputeAtmosphere,
} from "@himmelszelt/dunstkreis";
import {
    type BenchOptions,
    type CostRow,
    type CostsResult,
    codeBytes,
    counting,
    interleaved,
    timeFrames,
} from "../bench";
import { gpu, gpuDevice } from "./atmosphere";
import { type CostKey, CUBE_SIZE, MEASURED } from "./cost-rows";

// A Sun a little higher each time, so every update rebuilds the sky view; a camera turned a little each time, so every
// update rebuilds the volume.
const sunAt = (i: number): [number, number, number] => {
    const altitude = (10 + (i % 20)) * (Math.PI / 180);
    return [0, Math.cos(altitude), Math.sin(altitude)];
};
function cameraAt(i: number) {
    const [c, s] = [Math.cos(i * 0.01), Math.sin(i * 0.01)];
    return new Float32Array([c, s, 0, 0, 0, 0, 1, 0, s, -c, 0, 1, 0, 1, 0, 0]);
}

// The code that ships, as `codeBytes` counts it.
const CODE = import.meta.glob("../../../../packages/dunstkreis/dist/*.js", { query: "?raw", import: "default" });
export async function bench(options: BenchOptions): Promise<CostsResult & { code: number }> {
    const device = gpuDevice();
    const model = DEFAULT_ATMOSPHERE_MODEL;
    const config = DEFAULT_TEXTURE_CONFIG;
    const send = (record: (encoder: GPUCommandEncoder) => void) => {
        const encoder = device.createCommandEncoder();
        record(encoder);
        device.queue.submit([encoder.finish()]);
    };

    const memory: Partial<Record<CostKey, number>> = {};
    const tablesCount = counting(device);
    const luts: AtmosphereLUTs = await precomputeAtmosphere(tablesCount.device, { model, config });
    memory.tables = tablesCount.total();

    // As the chapter's sky has it: exposed by its meter, dithered.
    const skyCount = counting(device);
    const sky = await createSkyPass(skyCount.device, { luts, format: "rgba8unorm", dither: true, autoExposure: true });
    sky.update({ sunDirection: sunAt(0), observerHeightM: 10, inverseViewProjection: cameraAt(0) });
    memory.skyView = skyCount.total();
    const target = (width: number, height: number, format: GPUTextureFormat, usage: number) =>
        device.createTexture({ label: "sternwarte:costs", size: [width, height], format, usage });
    const hd = target(1920, 1080, "rgba8unorm", GPUTextureUsage.STORAGE_BINDING);
    const uhd = target(3840, 2160, "rgba8unorm", GPUTextureUsage.STORAGE_BINDING);
    memory.sky1080 = 0;
    memory.sky2160 = 0;
    memory.skyBare = 0;
    const bare = await createSkyPass(device, {
        luts,
        format: "rgba8unorm",
        dither: true,
        autoExposure: true,
        aureole: false,
    });
    bare.update({ sunDirection: sunAt(0), observerHeightM: 10, inverseViewProjection: cameraAt(0) });

    const cubeCount = counting(device);
    const cube = cubeCount.device.createTexture({
        label: "sternwarte:costsCube",
        size: { width: CUBE_SIZE, height: CUBE_SIZE, depthOrArrayLayers: 6 },
        mipLevelCount: Math.log2(CUBE_SIZE) + 1,
        format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        textureBindingViewDimension: "cube",
    });
    const cubePass = await sky.createCubePass({ format: "rgba16float", samples: 8 });
    memory.cube = cubeCount.total();

    // The volume at its default shape, and the pass that lays it over a scene of 1920 by 1080 pixels.
    const aerialCount = counting(device);
    const aerial = await createSkyPass(aerialCount.device, {
        luts,
        format: "rgba16float",
        autoExposure: true,
        aerialPerspective: true,
    });
    memory.aerial = aerialCount.total() - memory.skyView;
    aerial.update({ sunDirection: sunAt(0), observerHeightM: 10, inverseViewProjection: cameraAt(0) });
    const apply = await aerial.createAerialPerspectivePass({ format: "rgba16float" });
    const scene = {
        color: target(1920, 1080, "rgba16float", GPUTextureUsage.TEXTURE_BINDING),
        depth: target(1920, 1080, "depth32float", GPUTextureUsage.TEXTURE_BINDING),
    };
    const lit = target(1920, 1080, "rgba16float", GPUTextureUsage.STORAGE_BINDING);

    const frames: Record<CostKey, (i: number) => void | Promise<void>> = {
        tables: async () => (await precomputeAtmosphere(device, { model, config })).destroy(),
        skyView: (i) => send((encoder) => sky.update({ sunDirection: sunAt(i) }, encoder)),
        sky1080: () => send((encoder) => sky.encode(encoder, hd)),
        sky2160: () => send((encoder) => sky.encode(encoder, uhd)),
        skyBare: () => send((encoder) => bare.encode(encoder, hd)),
        cube: () => send((encoder) => cubePass.encode(encoder, cube)),
        aerial: (i) =>
            send((encoder) => {
                aerial.update({ inverseViewProjection: cameraAt(i + 1) }, encoder);
                apply.encode(encoder, lit, scene);
            }),
    };
    const own = options.cases as CostKey[] | undefined;
    const cases = own ?? [...MEASURED];
    const measured = await interleaved(
        cases,
        options.rounds,
        async (key) => {
            // The tables make their pipelines anew each time, on the CPU between their passes: fewer, their passes summed.
            const tables = key === "tables";
            const ms = await timeFrames(device, frames[key], {
                warmup: tables ? Math.ceil(options.warmup / 40) : options.warmup,
                frames: tables ? Math.ceil(options.frames / 20) : options.frames,
                sum: tables,
            });
            if (ms !== null) options.progress?.(`${key} ${ms.toFixed(4)} ms`);
            return ms === null ? null : { ms };
        },
        options.progress,
    );

    for (const pass of [sky, bare, aerial]) pass.destroy();
    for (const texture of [hd, uhd, cube, scene.color, scene.depth, lit]) texture.destroy();
    luts.destroy();

    const rows: Record<string, CostRow> = {};
    for (const key of cases) rows[key] = { ms: measured.get(key)?.ms, memory: memory[key] };
    return {
        gpu: gpu.adapterName ?? "unknown",
        rounds: options.rounds,
        frames: options.frames,
        warmup: options.warmup,
        rows,
        code: await codeBytes(CODE),
    };
}
