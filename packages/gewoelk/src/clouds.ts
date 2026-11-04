import type { ToneCurve } from "@himmelszelt/helldunkel";
import {
    CLOUDSCAPE_SIZE,
    type CloudParams,
    cloudscapeData,
    DEFAULT_CLOUD_PARAMS,
    evolutionAt,
    MAX_SHEETS,
    MODEL_SIZE,
    modelData,
    PARAMS_SIZE,
    paramsData,
} from "./params.js";
import * as wgsl from "./wgsl/index.js";

/** The cloudscape's voxel grid: `size` voxels east and north over its extent, `layers` over its height. */
export interface GridOptions {
    size?: number;
    layers?: number;
}

export interface CloudPassOptions {
    /** Format of the target `encode` composes into, with `STORAGE_BINDING` usage: rgba8unorm for a display, bgra8unorm
     *  with "bgra8unorm-storage", rgba16float or rgba32float for linear output or an HDR canvas. */
    format: GPUTextureFormat;
    /** Tone map for a display, as dunstkreis' sky pass: "neutral" by default, "agx", "aces", "clip"; `false` writes the
     *  exposed luminance, linear. */
    toneMap?: ToneCurve | false;
    headroom?: number;
    dither?: boolean;
    /** Whether `encode` composes over a background in cd/m², true by default. Without, it writes the clouds alone,
     *  premultiplied, with their transmittance in alpha, for a renderer that composites itself. */
    background?: boolean;
    /** Texels across a cloud map, 512 by default. */
    mapSize?: number;
    /** The cloudscape's voxel grid, 256 x 256 x 32 by default. */
    grid?: GridOptions;
    /** Texels on a side of the detail noise, 128 by default. */
    detailSize?: number;
    /** The cloud layer's size as a share of the target's, 1 by default: at 0.5, a quarter of the rays. */
    scale?: number;
    /** Steps a ray takes at most through the cloudscape, 256 by default, and detailed light samples per step, 2. */
    maxSteps?: number;
    nearLightSamples?: number;
}

export interface EncodeOptions {
    /** The sky behind the clouds, in cd/m², the target's size: a float texture with `TEXTURE_BINDING` usage. */
    background?: GPUTexture;
    /** Timestamps around the pass, for timing it. */
    timestampWrites?: GPUComputePassTimestampWrites;
}

/**
 * A cloud pass: compute passes that write the clouds along every pixel's ray and compose them over a background, into a
 * target the caller owns. It creates no device, canvas or context of its own.
 */
export interface CloudPass {
    /** The clouds as last rendered, premultiplied luminance in cd/m² and transmittance, rgba16float, at the scaled size. */
    readonly cloudsTexture: GPUTexture | null;
    /** The cloud maps, one layer per cloud layer, the cloudscape's first, and the cloudscape's voxel grids: Nubis3's
     *  modeling data and its summed light. For inspection; nothing in a render path needs them. */
    readonly mapTexture: GPUTexture;
    readonly modelingTexture: GPUTexture;
    readonly lightTexture: GPUTexture;
    /** The detail noise, 3D, four channels of billows and wisps. */
    readonly detailTexture: GPUTexture;
    /**
     * Takes the parameters over and writes the uniforms, and rebuilds what they changed: a cloud map when its shape
     * evolved, the cloudscape's voxels and distance field after its map, and its light after that or when the sun
     * moved. Submitted on its own, or recorded into `encoder` to go with the frame's own submission.
     */
    update(params: Partial<CloudParams>, encoder?: GPUCommandEncoder): void;
    /** Records the clouds into `target`, which needs `STORAGE_BINDING` usage and the pass' format. */
    encode(encoder: GPUCommandEncoder, target: GPUTexture, options?: EncodeOptions): void;
    destroy(): void;
}

const EIGHT_BIT = ["rgba8unorm", "bgra8unorm"];
const TONE_CURVES: Record<string, number> = { neutral: 1, agx: 2, aces: 3, clip: 4 };
const dispatch = (n: number, group: number) => Math.ceil(n / group);

export async function createCloudPass(device: GPUDevice, options: CloudPassOptions): Promise<CloudPass> {
    const {
        format,
        toneMap = "neutral",
        headroom = 1,
        background = true,
        mapSize = 512,
        detailSize = 128,
        scale = 1,
        maxSteps = 256,
        nearLightSamples = 2,
    } = options;
    const grid = { size: 256, layers: 32, ...options.grid };
    const dither = options.dither ?? (toneMap !== false && EIGHT_BIT.includes(format));
    const storable = ["rgba8unorm", "rgba16float", "rgba32float"].includes(format);
    if (!storable && !(format === "bgra8unorm" && device.features.has("bgra8unorm-storage"))) {
        throw new Error(`gewoelk: the pass writes ${format} as a storage texture, which this device cannot`);
    }
    if (!(scale > 0 && scale <= 1)) throw new Error("gewoelk: the scale is above 0 and at most 1");
    if (grid.size > 1024 || grid.layers > 1024) throw new Error("gewoelk: the grid packs its coordinates in 10 bits");

    // Copyable too, so the maps and grids can be read back for inspection.
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const layers = 1 + MAX_SHEETS;
    const map = device.createTexture({
        label: "gewoelk:cloudMap",
        size: [mapSize, mapSize, layers],
        format: "rgba16float",
        usage,
    });
    const volume = (label: string, format: GPUTextureFormat) =>
        device.createTexture({ label, dimension: "3d", size: [grid.size, grid.size, grid.layers], format, usage });
    const flood = [volume("gewoelk:floodA", "r32uint"), volume("gewoelk:floodB", "r32uint")] as const;
    const modeling = volume("gewoelk:modeling", "rgba8unorm");
    const light = volume("gewoelk:light", "rgba16float");
    const detail = device.createTexture({
        label: "gewoelk:detail",
        dimension: "3d",
        size: [detailSize, detailSize, detailSize],
        format: "rgba8unorm",
        usage,
    });
    // East and north wrap, the height clamps: the volume's own sampler, and the map's and the detail noise's.
    const volumeSampler = device.createSampler({
        addressModeU: "repeat",
        addressModeV: "repeat",
        addressModeW: "clamp-to-edge",
        magFilter: "linear",
        minFilter: "linear",
    });
    const cloudsSampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    // Bound where no background is composed over: the binding stays in the layout whatever the override says.
    const noBackground = device.createTexture({
        label: "gewoelk:noBackground",
        size: [1, 1],
        format: "rgba32float",
        usage: GPUTextureUsage.TEXTURE_BINDING,
    });

    const uniform = (label: string, size: number) =>
        device.createBuffer({ label, size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const params = uniform("gewoelk:params", PARAMS_SIZE);
    const cloudscape = uniform("gewoelk:cloudscape", CLOUDSCAPE_SIZE);
    const models = Array.from({ length: layers }, (_, i) => uniform(`gewoelk:model${i}`, MODEL_SIZE));
    // The flood's jumps, halving from half the grid's largest side down to 1.
    const jumps: number[] = [];
    for (let step = Math.max(grid.size, grid.layers) >> 1; step >= 1; step >>= 1) jumps.push(step);
    const jumpBuffers = jumps.map((step) => {
        const buffer = uniform(`gewoelk:jump${step}`, 16);
        device.queue.writeBuffer(buffer, 0, new Uint32Array([step, 0, 0, 0]));
        return buffer;
    });

    const module = (label: string, code: string[]) => device.createShaderModule({ label, code: code.join("\n") });
    const pipeline = (label: string, module: GPUShaderModule, entryPoint: string, constants?: Record<string, number>) =>
        device.createComputePipelineAsync({
            label: `gewoelk:${label}`,
            layout: "auto",
            compute: { module, entryPoint, ...(constants ? { constants } : {}) },
        });
    const voxelModule = module("gewoelk:voxel", [wgsl.params, wgsl.voxel]);
    const [
        cloudMapPipeline,
        floodInitPipeline,
        floodJumpPipeline,
        modelingPipeline,
        detailPipeline,
        lightPipeline,
        cloudsPipeline,
        composePipeline,
    ] = await Promise.all([
        pipeline("cloudMap", module("gewoelk:cloudMap", [wgsl.noise, wgsl.params, wgsl.cloudmap]), "gwCloudMap"),
        pipeline("floodInit", voxelModule, "gwFloodInit"),
        pipeline("floodJump", voxelModule, "gwFloodJump"),
        pipeline("modeling", voxelModule, "gwModeling"),
        pipeline("detail", module("gewoelk:detail", [wgsl.noise, wgsl.detail]), "gwDetail"),
        pipeline("light", module("gewoelk:light", [wgsl.params, wgsl.light]), "gwLight"),
        pipeline(
            "clouds",
            module("gewoelk:clouds", [wgsl.params, wgsl.camera, wgsl.cloudOutput("rgba16float"), wgsl.clouds]),
            "gwClouds",
            { GW_MAX_STEPS: maxSteps, GW_NEAR_LIGHT_SAMPLES: nearLightSamples },
        ),
        pipeline(
            "compose",
            module("gewoelk:compose", [wgsl.params, wgsl.tonemap, wgsl.cloudOutput(format), wgsl.compose]),
            "gwCompose",
            {
                GW_TONE_MAP: toneMap === false ? 0 : (TONE_CURVES[toneMap] ?? 1),
                GW_HEADROOM: headroom,
                GW_DITHER: dither ? 1 : 0,
                GW_BACKGROUND: background ? 1 : 0,
            },
        ),
    ]);

    const bindGroup = (pipeline: GPUComputePipeline, entries: GPUBindGroupEntry[], group = 0) =>
        device.createBindGroup({ layout: pipeline.getBindGroupLayout(group), entries });
    const mapArray = map.createView({ dimension: "2d-array" });
    const cloudMapBindGroups = models.map((model) =>
        bindGroup(cloudMapPipeline, [
            { binding: 0, resource: { buffer: model } },
            { binding: 1, resource: mapArray },
        ]),
    );
    const modelEntries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: models[0] as GPUBuffer } },
        { binding: 1, resource: mapArray },
        { binding: 2, resource: volumeSampler },
    ];
    const floodInitBindGroup = bindGroup(floodInitPipeline, [
        ...modelEntries,
        { binding: 4, resource: flood[0].createView() },
    ]);
    const floodJumpBindGroups = jumpBuffers.map((buffer, i) =>
        bindGroup(floodJumpPipeline, [
            { binding: 3, resource: (flood[i % 2] as GPUTexture).createView() },
            { binding: 4, resource: (flood[(i + 1) % 2] as GPUTexture).createView() },
            { binding: 5, resource: { buffer } },
            { binding: 6, resource: { buffer: cloudscape } },
        ]),
    );
    const modelingBindGroup = bindGroup(modelingPipeline, [
        ...modelEntries,
        { binding: 3, resource: (flood[jumps.length % 2] as GPUTexture).createView() },
        { binding: 6, resource: { buffer: cloudscape } },
        { binding: 7, resource: modeling.createView() },
    ]);
    const detailBindGroup = bindGroup(detailPipeline, [{ binding: 0, resource: detail.createView() }]);
    const lightBindGroup = bindGroup(lightPipeline, [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: modeling.createView() },
        { binding: 2, resource: volumeSampler },
        { binding: 3, resource: light.createView() },
    ]);
    const cloudsBindGroup = bindGroup(cloudsPipeline, [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: mapArray },
        { binding: 2, resource: volumeSampler },
        { binding: 3, resource: modeling.createView() },
        { binding: 4, resource: light.createView() },
        { binding: 5, resource: detail.createView() },
    ]);

    // The detail noise, once.
    {
        const encoder = device.createCommandEncoder({ label: "gewoelk:detail" });
        const pass = encoder.beginComputePass({ label: "gewoelk:detail" });
        pass.setPipeline(detailPipeline);
        pass.setBindGroup(0, detailBindGroup);
        pass.dispatchWorkgroups(dispatch(detailSize, 4), dispatch(detailSize, 4), dispatch(detailSize, 4));
        pass.end();
        device.queue.submit([encoder.finish()]);
    }

    let current: CloudParams = { ...DEFAULT_CLOUD_PARAMS };
    let frame = 0;
    const mapKeys = Array.from({ length: layers }, () => "");
    let volumeKey = "";
    let lightKey = "";
    let clouds: GPUTexture | null = null;
    let cloudsView: GPUTextureView | null = null;
    const composeGroups = new WeakMap<GPUTexture, GPUBindGroup>();
    const outputs = new WeakMap<GPUTexture, GPUBindGroup>();
    let composeAlone: GPUBindGroup | null = null;

    const sweep = (pass: GPUComputePassEncoder, pipeline: GPUComputePipeline, group: GPUBindGroup) => {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(dispatch(grid.size, 4), dispatch(grid.size, 4), dispatch(grid.layers, 4));
    };

    return {
        get cloudsTexture() {
            return clouds;
        },
        mapTexture: map,
        modelingTexture: modeling,
        lightTexture: light,
        detailTexture: detail,

        update(next, frameEncoder) {
            current = { ...current, ...next };
            frame += 1;
            const { cloudscape: c, sheets, timeS } = current;
            device.queue.writeBuffer(params, 0, paramsData(current, frame));
            device.queue.writeBuffer(cloudscape, 0, cloudscapeData(c, timeS, current.sunIlluminance));

            // Which maps changed shape: the cloudscape's first, then the sheets'.
            const shapes = [
                { model: c, evolution: evolutionAt(c.evolution, timeS), offset: c.offset },
                ...sheets
                    .slice(0, MAX_SHEETS)
                    .map((s) => ({ model: s, evolution: evolutionAt(s.evolution, timeS), offset: 0 })),
            ];
            const changed: number[] = [];
            shapes.forEach(({ model, evolution, offset }, layer) => {
                const { coverage, sharpness, seed, octaves, cells } = model;
                const key = `${coverage},${sharpness},${evolution},${seed},${octaves},${cells},${mapSize}`;
                if (key === mapKeys[layer]) return;
                mapKeys[layer] = key;
                changed.push(layer);
                device.queue.writeBuffer(models[layer] as GPUBuffer, 0, modelData(layer, model, evolution, offset));
            });
            const nextVolumeKey = `${mapKeys[0]},${c.offset},${c.extentKm},${c.heightKm},${c.profileDepthKm},${c.sdfRangeKm}`;
            const rebuildVolume = c.enabled && nextVolumeKey !== volumeKey;
            const nextLightKey = `${nextVolumeKey},${current.sunDirection.join(",")}`;
            const rebuildLight = c.enabled && nextLightKey !== lightKey;
            if (changed.length === 0 && !rebuildVolume && !rebuildLight) return;
            volumeKey = c.enabled ? nextVolumeKey : volumeKey;
            lightKey = c.enabled ? nextLightKey : lightKey;

            const encoder = frameEncoder ?? device.createCommandEncoder({ label: "gewoelk:update" });
            const pass = encoder.beginComputePass({ label: "gewoelk:update" });
            for (const layer of changed) {
                pass.setPipeline(cloudMapPipeline);
                pass.setBindGroup(0, cloudMapBindGroups[layer] as GPUBindGroup);
                pass.dispatchWorkgroups(dispatch(mapSize, 8), dispatch(mapSize, 8));
            }
            if (rebuildVolume) {
                sweep(pass, floodInitPipeline, floodInitBindGroup);
                for (const group of floodJumpBindGroups) sweep(pass, floodJumpPipeline, group);
                sweep(pass, modelingPipeline, modelingBindGroup);
            }
            if (rebuildLight) sweep(pass, lightPipeline, lightBindGroup);
            pass.end();
            if (!frameEncoder) device.queue.submit([encoder.finish()]);
        },

        encode(encoder, target, encodeOptions = {}) {
            const { background: behind, timestampWrites } = encodeOptions;
            if (background && !behind) throw new Error("gewoelk: this pass composes over a background; pass one");
            const width = Math.max(1, Math.round(target.width * scale));
            const height = Math.max(1, Math.round(target.height * scale));
            if (!clouds || clouds.width !== width || clouds.height !== height) {
                clouds?.destroy();
                clouds = device.createTexture({
                    label: "gewoelk:clouds",
                    size: [width, height],
                    format: "rgba16float",
                    usage,
                });
                cloudsView = clouds.createView();
                composeAlone = null;
            }
            const cloudsOutput = bindGroup(cloudsPipeline, [{ binding: 0, resource: cloudsView as GPUTextureView }], 1);
            const composeEntries: GPUBindGroupEntry[] = [
                { binding: 0, resource: { buffer: params } },
                { binding: 1, resource: cloudsView as GPUTextureView },
                { binding: 2, resource: cloudsSampler },
            ];
            let composeGroup: GPUBindGroup;
            if (behind) {
                const cached = composeGroups.get(behind);
                composeGroup =
                    cached ??
                    bindGroup(composePipeline, [...composeEntries, { binding: 3, resource: behind.createView() }]);
                if (!cached) composeGroups.set(behind, composeGroup);
            } else {
                composeAlone ??= bindGroup(composePipeline, [
                    ...composeEntries,
                    { binding: 3, resource: noBackground.createView() },
                ]);
                composeGroup = composeAlone;
            }
            let output = outputs.get(target);
            if (!output) {
                output = bindGroup(composePipeline, [{ binding: 0, resource: target.createView() }], 1);
                outputs.set(target, output);
            }
            const pass = encoder.beginComputePass({
                label: "gewoelk:clouds",
                ...(timestampWrites ? { timestampWrites } : {}),
            });
            pass.setPipeline(cloudsPipeline);
            pass.setBindGroup(0, cloudsBindGroup);
            pass.setBindGroup(1, cloudsOutput);
            pass.dispatchWorkgroups(dispatch(width, 8), dispatch(height, 8));
            pass.setPipeline(composePipeline);
            pass.setBindGroup(0, composeGroup);
            pass.setBindGroup(1, output);
            pass.dispatchWorkgroups(dispatch(target.width, 8), dispatch(target.height, 8));
            pass.end();
        },

        destroy() {
            for (const texture of [map, ...flood, modeling, light, detail, noBackground]) texture.destroy();
            clouds?.destroy();
            for (const buffer of [params, cloudscape, ...models, ...jumpBuffers]) buffer.destroy();
        },
    };
}
