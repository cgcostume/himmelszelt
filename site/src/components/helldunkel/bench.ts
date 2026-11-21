// The benchmark behind the chapter's "What it costs", for `scripts/bench.mjs helldunkel`: the tone curve with its dither
// as a pass of its own, the bloom and the light meter, each timed on the GPU's own clock, the cases in turn round after
// round, and the GPU memory each holds, counted from the buffers and textures it makes.
import { blueNoiseTexture, createBloomPass, createMeterPass, wgsl } from "@himmelszelt/helldunkel";
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
import { COST_ROWS, type CostKey } from "./cost-rows";

const CODE = import.meta.glob("../../../../packages/helldunkel/dist/*.js", { query: "?raw", import: "default" });

// A display's last step: the exposed light through Khronos PBR Neutral, dithered by blue noise into 8 bits.
const TONE = `
@group(0) @binding(0) var toneSource: texture_2d<f32>;
@group(0) @binding(1) var toneNoise: texture_2d<f32>;
@group(0) @binding(2) var toneOutput: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(toneOutput))) {
        return;
    }
    let shown = hdToneMapNeutral(textureLoad(toneSource, id.xy, 0).rgb);
    textureStore(toneOutput, id.xy, vec4f(hdDitherBlue(shown, id.xy, 255.0, toneNoise), 1.0));
}`;

export async function bench(options: BenchOptions): Promise<CostsResult & { code: number }> {
    const device = gpuDevice();
    const textures: GPUTexture[] = [];
    const texture = (
        width: number,
        height: number,
        format: GPUTextureFormat,
        usage: number,
        layers = 1,
    ): GPUTexture => {
        const made = device.createTexture({
            label: "sternwarte:costs",
            size: { width, height, depthOrArrayLayers: layers },
            format,
            usage,
        });
        textures.push(made);
        return made;
    };
    const SOURCE = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    // A light that varies over the image as a photograph's might: ten stops from corner to corner, and a grain of some
    // tenths of a stop per channel, so the curve and the meter see a scene and not one value.
    const halves = new Uint16Array(1 << 12);
    for (let i = 0; i < halves.length; i++) {
        const bits = new Uint32Array(new Float32Array([2 ** ((10 * i) / halves.length - 7)]).buffer)[0] ?? 0;
        halves[i] = ((bits >> 16) & 0x8000) | ((((bits >> 23) & 0xff) - 112) << 10) | ((bits >> 13) & 0x3ff);
    }
    const sources = new Map<string, GPUTexture>();
    const sourceOf = (width: number, height: number, layers = 1) => {
        const key = `${width} ${height} ${layers}`;
        let made = sources.get(key);
        if (!made) {
            made = texture(width, height, "rgba16float", SOURCE, layers);
            const plane = new Uint16Array(width * height * 4);
            let seed = 1;
            const grain = () => {
                seed = (seed * 1664525 + 1013904223) >>> 0;
                return (seed >>> 24) - 128;
            };
            for (let y = 0; y < height; y++)
                for (let x = 0; x < width; x++) {
                    const at = Math.floor(((x + y) / (width + height)) * (halves.length - 129)) + 64;
                    const i = (y * width + x) * 4;
                    plane[i] = halves[at + (grain() >> 1)] ?? 0;
                    plane[i + 1] = halves[at + (grain() >> 1)] ?? 0;
                    plane[i + 2] = halves[at + (grain() >> 1)] ?? 0;
                    plane[i + 3] = 0x3c00;
                }
            for (let layer = 0; layer < layers; layer++)
                device.queue.writeTexture(
                    { texture: made, origin: { x: 0, y: 0, z: layer } },
                    plane,
                    { bytesPerRow: width * 8, rowsPerImage: height },
                    { width, height },
                );
            sources.set(key, made);
        }
        return made;
    };

    const memory: Partial<Record<CostKey, number>> = {};
    // The tone curve: what it holds is the blue noise.
    const toneCount = counting(device);
    const noise = blueNoiseTexture(toneCount.device);
    const tonePipeline = await device.createComputePipelineAsync({
        label: "sternwarte:costsTone",
        layout: "auto",
        compute: { module: device.createShaderModule({ code: [wgsl.exposure, wgsl.tonemap, TONE].join("\n") }) },
    });
    const toneFrame = (width: number, height: number) => {
        const target = texture(width, height, "rgba8unorm", GPUTextureUsage.STORAGE_BINDING);
        const group = device.createBindGroup({
            layout: tonePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: sourceOf(width, height).createView() },
                { binding: 1, resource: noise.createView() },
                { binding: 2, resource: target.createView() },
            ],
        });
        return () => {
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass({ label: "sternwarte:costsTone" });
            pass.setPipeline(tonePipeline);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
            pass.end();
            device.queue.submit([encoder.finish()]);
        };
    };
    memory.tone1080 = memory.tone2160 = toneCount.total();

    // The bloom with its defaults, a pass per size, so each keeps its own chains.
    const bloomFrame = async (key: CostKey, width: number, height: number) => {
        const count = counting(device);
        const bloom = await createBloomPass(count.device);
        const source = sourceOf(width, height);
        const target = texture(width, height, "rgba16float", GPUTextureUsage.STORAGE_BINDING);
        const frame = () => {
            const encoder = device.createCommandEncoder();
            bloom.encode(encoder, source, target);
            device.queue.submit([encoder.finish()]);
        };
        frame();
        memory[key] = count.total();
        return { frame, destroy: () => bloom.destroy() };
    };
    const blooms = [await bloomFrame("bloom1080", 1920, 1080), await bloomFrame("bloom2160", 3840, 2160)];

    // The meter, every texel counted: over a cube map as the sky lights a scene with, 512 a face, and over an HDRI of 4K.
    const meterFrame = async (key: CostKey, kind: "cube" | "equirectangular", source: GPUTexture) => {
        const count = counting(device);
        const meter = await createMeterPass(count.device, { source: kind });
        memory[key] = count.total();
        const frame = () => {
            const encoder = device.createCommandEncoder();
            meter.encode(encoder, source);
            device.queue.submit([encoder.finish()]);
        };
        return { frame, destroy: () => meter.destroy() };
    };
    const meters = [
        await meterFrame("meterCube", "cube", sourceOf(512, 512, 6)),
        await meterFrame("meterHdri", "equirectangular", sourceOf(4096, 2048)),
    ];

    const frames: Record<CostKey, () => void> = {
        tone1080: toneFrame(1920, 1080),
        tone2160: toneFrame(3840, 2160),
        bloom1080: blooms[0]?.frame ?? (() => {}),
        bloom2160: blooms[1]?.frame ?? (() => {}),
        meterCube: meters[0]?.frame ?? (() => {}),
        meterHdri: meters[1]?.frame ?? (() => {}),
    };
    const cases = (options.cases as CostKey[] | undefined) ?? [...COST_ROWS];
    const measured = await interleaved(
        cases,
        options.rounds,
        async (key) => {
            const ms = await timeFrames(device, frames[key], options);
            if (ms !== null) options.progress?.(`${key} ${ms.toFixed(4)} ms`);
            return ms === null ? null : { ms };
        },
        options.progress,
    );
    for (const pass of [...blooms, ...meters]) pass.destroy();
    for (const made of textures) made.destroy();

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
