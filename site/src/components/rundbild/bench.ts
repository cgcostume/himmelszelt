// The benchmark behind the chapter's "What it costs", for `scripts/bench.mjs rundbild`: HDRIs made cube maps, as sharp
// as they are or as small as lighting takes, the diffuse light, a fade between two environments and a panorama laid out,
// each timed on the GPU's own clock, the cases in turn round after round; the GPU memory each holds, counted from the
// textures and buffers it makes; and what each HDRI downloads, as Poly Haven's API lists the chapter's first one.
import {
    createCubeFromPanoramaPass,
    createEnvironmentBlendPass,
    createIrradiancePass,
    createPanoramaPass,
} from "@himmelszelt/rundbild";
import {
    type BenchOptions,
    type CostRow,
    type CostsResult,
    codeBytes,
    counting,
    interleaved,
    timeFrames,
} from "../bench";
import { gpu, gpuDevice } from "../dunstkreis/atmosphere";
import { DEFAULT_HDRI } from "../environment/hdri";
import { COST_ROWS, type CostKey, CUBE_SIZE } from "./cost-rows";

const CODE = import.meta.glob("../../../../packages/rundbild/dist/*.js", { query: "?raw", import: "default" });

// Each HDRI, its file's size, the cube map's face and the lookups per texel: as sharp as the panorama, a face at least
// a third of its width and a power of two, or as small as lighting takes it, a quarter of the 1K, four lookups a texel.
const HDRIS = {
    hdri1k: { size: "1k", face: 512, samples: 1 },
    hdri4k: { size: "4k", face: 2048, samples: 1 },
    light4k: { size: "4k", face: 256, samples: 4 },
} as const;

type HdriCase = (typeof HDRIS)[keyof typeof HDRIS];

export async function bench(options: BenchOptions): Promise<CostsResult & { code: number; hdri: string }> {
    const device = gpuDevice();
    const textures: GPUTexture[] = [];
    const track = (texture: GPUTexture) => {
        textures.push(texture);
        return texture;
    };
    const cubeOf = (on: GPUDevice, size: number) =>
        track(
            on.createTexture({
                label: "sternwarte:costsCube",
                size: { width: size, height: size, depthOrArrayLayers: 6 },
                mipLevelCount: Math.log2(size) + 1,
                format: "rgba16float",
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
                textureBindingViewDimension: "cube",
            }),
        );
    const send = (record: (encoder: GPUCommandEncoder) => void) => {
        const encoder = device.createCommandEncoder();
        record(encoder);
        device.queue.submit([encoder.finish()]);
    };
    const memory: Partial<Record<CostKey, number>> = {};
    const frames: Partial<Record<CostKey, () => void>> = {};

    // The HDRIs: the panorama in half floats as the site uploads it, its contents beside the point, and the cube map.
    for (const [key, { size, face, samples }] of Object.entries(HDRIS) as [keyof typeof HDRIS, HdriCase][]) {
        const width = Number.parseInt(size, 10) * 1024;
        const fromPanorama = await createCubeFromPanoramaPass(device, { samples });
        const count = counting(device);
        const panorama = track(
            count.device.createTexture({
                label: "sternwarte:costsHdri",
                size: [width, width / 2],
                format: "rgba16float",
                usage: GPUTextureUsage.TEXTURE_BINDING,
            }),
        );
        const cube = cubeOf(count.device, face);
        memory[key] = count.total();
        frames[key] = () => send((encoder) => fromPanorama.encode(encoder, panorama, cube));
    }

    const [a, b] = [cubeOf(device, CUBE_SIZE), cubeOf(device, CUBE_SIZE)] as [GPUTexture, GPUTexture];
    const irradianceCount = counting(device);
    const ibl = await createIrradiancePass(irradianceCount.device);
    memory.irradiance = irradianceCount.total();
    frames.irradiance = () => send((encoder) => ibl.encode(encoder, a));

    const blendCount = counting(device);
    const blend = await createEnvironmentBlendPass(blendCount.device);
    const mixed = cubeOf(blendCount.device, CUBE_SIZE);
    memory.blend = blendCount.total();
    frames.blend = () => send((encoder) => blend.encode(encoder, a, b, mixed, 0.5));

    const panoramaCount = counting(device);
    const layout = await createPanoramaPass(panoramaCount.device, {
        projection: "equirectangular",
        format: "rgba16float",
    });
    const flat = track(
        panoramaCount.device.createTexture({
            label: "sternwarte:costsPanorama",
            size: [4 * CUBE_SIZE, 2 * CUBE_SIZE],
            format: "rgba16float",
            usage: GPUTextureUsage.STORAGE_BINDING,
        }),
    );
    memory.panorama = panoramaCount.total();
    frames.panorama = () => send((encoder) => layout.encode(encoder, a, flat));

    const cases = (options.cases as CostKey[] | undefined) ?? [...COST_ROWS];
    const measured = await interleaved(
        cases,
        options.rounds,
        async (key) => {
            const frame = frames[key];
            const ms = frame ? await timeFrames(device, frame, options) : null;
            if (ms !== null) options.progress?.(`${key} ${ms.toFixed(4)} ms`);
            return ms === null ? null : { ms };
        },
        options.progress,
    );
    ibl.destroy();
    blend.destroy();
    for (const texture of textures) texture.destroy();

    // The files' sizes as Poly Haven lists them; none where its API is out of reach.
    const download: Partial<Record<CostKey, number>> = {};
    try {
        const files = await (await fetch(`https://api.polyhaven.com/files/${DEFAULT_HDRI}`)).json();
        for (const [key, { size }] of Object.entries(HDRIS) as [keyof typeof HDRIS, HdriCase][])
            download[key] = Number(files.hdri?.[size]?.hdr?.size) || undefined;
    } catch {
        options.progress?.("Poly Haven's API out of reach, no download sizes");
    }

    const rows: Record<string, CostRow> = {};
    for (const key of cases) rows[key] = { ms: measured.get(key)?.ms, memory: memory[key], download: download[key] };
    return {
        gpu: gpu.adapterName ?? "unknown",
        rounds: options.rounds,
        frames: options.frames,
        warmup: options.warmup,
        rows,
        code: await codeBytes(CODE),
        hdri: DEFAULT_HDRI,
    };
}
