import type { ToneCurve } from "@himmelszelt/helldunkel";
import {
    AERIAL_OFFSET,
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
    SUNLIGHT_SIZE,
    type SunlightRow,
    sizedCloudscape,
    sunlightData,
    sunlightRows,
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

/**
 * An aerial perspective volume in RGB, as Hillaire's: froxels over the camera's frustum, x and y following the target
 * from its top left, slice k of the depth at `maxDistanceKm * ((k + 0.5) / depth) ** 2`. Two 3D textures, filterable,
 * with `TEXTURE_BINDING` usage: the light the air adds in cd/m² times `scale` in rgb, and what it lets through in rgb.
 * dunstkreis' volume holds four wavelengths; turned into RGB, with its `skyViewScale`, it fits.
 */
export interface AerialPerspective {
    luminance: GPUTexture;
    transmittance: GPUTexture;
    maxDistanceKm: number;
    scale: number;
}

export interface EncodeOptions {
    /** The sky behind the clouds, in cd/m², the target's size: a float texture with `TEXTURE_BINDING` usage. */
    background?: GPUTexture;
    /** The air between the camera and the clouds, for their aerial perspective; without, they fade into the
     *  background, or into `horizonLuminance` without one, by `horizonFadeKm`. */
    aerialPerspective?: AerialPerspective;
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
     *  modeling data, its summed light towards the sun at four elevations, and towards the sky and the ground. For
     *  inspection; nothing in a render path needs them. */
    readonly mapTexture: GPUTexture;
    readonly modelingTexture: GPUTexture;
    readonly lightTexture: GPUTexture;
    readonly ambientTexture: GPUTexture;
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
    const shape = volume("gewoelk:shape", "r32uint");
    const modeling = volume("gewoelk:modeling", "rgba8unorm");
    const light = volume("gewoelk:light", "rgba16float");
    const ambient = volume("gewoelk:ambient", "rgba8unorm");
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
    const sunlight = uniform("gewoelk:sunlight", SUNLIGHT_SIZE);
    const coverage = device.createBuffer({
        label: "gewoelk:coverage",
        size: 4 * grid.layers,
        usage: GPUBufferUsage.STORAGE,
    });
    const models = Array.from({ length: layers }, (_, i) => uniform(`gewoelk:model${i}`, MODEL_SIZE));
    // The flood's jumps, halving down to 1 from what reaches a quarter of the grid across, beyond the stored distance's
    // range, and its whole height.
    const jumps: number[] = [];
    const reach = Math.min(Math.max(grid.size >> 3, grid.layers >> 1), Math.max(grid.size, grid.layers) >> 1);
    for (let step = reach; step >= 1; step >>= 1) jumps.push(step);
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
    const voxelModule = module("gewoelk:voxel", [wgsl.noise, wgsl.params, wgsl.voxel]);
    const lightModule = module("gewoelk:light", [wgsl.params, wgsl.light]);
    const [
        cloudMapPipeline,
        shapePipeline,
        floodInitPipeline,
        floodJumpPipeline,
        modelingPipeline,
        detailPipeline,
        lightPipeline,
        coveragePipeline,
        ambientPipeline,
        cloudsPipeline,
        composePipeline,
    ] = await Promise.all([
        pipeline("cloudMap", module("gewoelk:cloudMap", [wgsl.noise, wgsl.params, wgsl.cloudmap]), "gwCloudMap"),
        pipeline("shape", voxelModule, "gwShape"),
        pipeline("floodInit", voxelModule, "gwFloodInit"),
        pipeline("floodJump", voxelModule, "gwFloodJump"),
        pipeline("modeling", voxelModule, "gwModeling"),
        pipeline("detail", module("gewoelk:detail", [wgsl.noise, wgsl.detail]), "gwDetail"),
        pipeline("light", lightModule, "gwLight"),
        pipeline("coverage", lightModule, "gwCoverageMean"),
        pipeline("ambient", lightModule, "gwAmbient"),
        pipeline(
            "clouds",
            module("gewoelk:clouds", [
                wgsl.noise,
                wgsl.params,
                wgsl.camera,
                wgsl.sheet,
                wgsl.cloudOutput("rgba16float"),
                wgsl.clouds,
            ]),
            "gwClouds",
            { GW_MAX_STEPS: maxSteps, GW_NEAR_LIGHT_SAMPLES: nearLightSamples, GW_BACKGROUND: background ? 1 : 0 },
        ),
        pipeline(
            "compose",
            module("gewoelk:compose", [
                wgsl.noise,
                wgsl.params,
                wgsl.camera,
                wgsl.sheet,
                wgsl.tonemap,
                wgsl.cloudOutput(format),
                wgsl.compose,
            ]),
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
    const shapeBindGroup = bindGroup(shapePipeline, [
        ...modelEntries,
        { binding: 6, resource: { buffer: cloudscape } },
        { binding: 8, resource: shape.createView() },
    ]);
    const floodInitBindGroup = bindGroup(floodInitPipeline, [
        { binding: 4, resource: flood[0].createView() },
        { binding: 9, resource: shape.createView() },
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
        { binding: 9, resource: shape.createView() },
    ]);
    const detailBindGroup = bindGroup(detailPipeline, [{ binding: 0, resource: detail.createView() }]);
    const lightBindGroup = bindGroup(lightPipeline, [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: modeling.createView() },
        { binding: 2, resource: volumeSampler },
        { binding: 3, resource: light.createView() },
        { binding: 5, resource: { buffer: coverage } },
    ]);
    const coverageBindGroup = bindGroup(coveragePipeline, [
        { binding: 1, resource: modeling.createView() },
        { binding: 4, resource: { buffer: coverage } },
    ]);
    const ambientBindGroup = bindGroup(ambientPipeline, [
        { binding: 1, resource: modeling.createView() },
        { binding: 2, resource: volumeSampler },
        { binding: 6, resource: ambient.createView() },
    ]);
    // With the sky behind them, which far clouds fade into: one per background, as the compose pass' groups.
    const cloudsEntries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: mapArray },
        { binding: 2, resource: volumeSampler },
        { binding: 3, resource: modeling.createView() },
        { binding: 4, resource: light.createView() },
        { binding: 5, resource: detail.createView() },
        { binding: 6, resource: { buffer: sunlight } },
        { binding: 7, resource: ambient.createView() },
    ];
    const clampSampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    // Bound where no aerial perspective volume is: the shaders read it only with a reach above 0.
    const noAir = device.createTexture({
        label: "gewoelk:noAir",
        dimension: "3d",
        size: [1, 1, 1],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    // The groups that take the frame's background and air, remade only when those change.
    let lastInputs: readonly (GPUTexture | GPUTextureView | null)[] = [];
    let inputGroups: [GPUBindGroup, GPUBindGroup] | null = null;
    const groupsFor = (behind: GPUTexture, air: AerialPerspective | undefined) => {
        const inputs = [behind, air?.luminance ?? noAir, air?.transmittance ?? noAir, cloudsView];
        if (inputGroups && inputs.every((x, i) => x === lastInputs[i])) return inputGroups;
        lastInputs = inputs;
        const luminance = (air?.luminance ?? noAir).createView();
        const transmittance = (air?.transmittance ?? noAir).createView();
        inputGroups = [
            bindGroup(cloudsPipeline, [
                ...cloudsEntries,
                { binding: 8, resource: behind.createView() },
                { binding: 9, resource: luminance },
                { binding: 10, resource: transmittance },
                { binding: 11, resource: clampSampler },
            ]),
            bindGroup(composePipeline, [
                { binding: 0, resource: { buffer: params } },
                { binding: 1, resource: cloudsView as GPUTextureView },
                { binding: 2, resource: cloudsSampler },
                { binding: 3, resource: behind.createView() },
                { binding: 4, resource: mapArray },
                { binding: 5, resource: volumeSampler },
                { binding: 6, resource: { buffer: sunlight } },
                { binding: 7, resource: luminance },
                { binding: 8, resource: transmittance },
                { binding: 9, resource: clampSampler },
            ]),
        ];
        return inputGroups;
    };

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
    const outputs = new WeakMap<GPUTexture, GPUBindGroup>();

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
        ambientTexture: ambient,
        detailTexture: detail,

        update(next, frameEncoder) {
            current = { ...current, ...next };
            frame += 1;
            const { sheets, timeS } = current;
            const c = sizedCloudscape(current.cloudscape);
            device.queue.writeBuffer(params, 0, paramsData(current, frame));
            const { fromRad, toRad } = sunlightRows(current)[0] as SunlightRow;
            device.queue.writeBuffer(cloudscape, 0, cloudscapeData(c, timeS, [fromRad, toRad]));
            device.queue.writeBuffer(sunlight, 0, sunlightData(current));

            // Which maps changed shape: the cloudscape's first, then the sheets'.
            const growth = {
                towers: c.towers ?? 0,
                billows: c.billows ?? 0,
                billowCells: Math.max(1, Math.round(c.extentKm / (c.billowKm ?? 0.5))),
                towerScale: Math.max(1, c.towerScale ?? 1),
            };
            const shapes = [
                { model: c, evolution: evolutionAt(c.evolution, timeS), offset: c.offset, growth },
                ...sheets.slice(0, MAX_SHEETS).map((s) => ({
                    model: s,
                    evolution: evolutionAt(s.evolution, timeS),
                    offset: 0,
                    growth: undefined,
                })),
            ];
            const changed: number[] = [];
            shapes.forEach(({ model, evolution, offset, growth }, layer) => {
                const { coverage, sharpness, seed, octaves, cells } = model;
                const key = `${coverage},${sharpness},${evolution},${seed},${octaves},${cells},${mapSize},${growth?.towers}`;
                if (key === mapKeys[layer]) return;
                mapKeys[layer] = key;
                changed.push(layer);
                const data = modelData(layer, model, evolution, offset, growth);
                device.queue.writeBuffer(models[layer] as GPUBuffer, 0, data);
            });
            // The billows only shape the voxels: a change rewrites the cloudscape's model without remaking its map.
            if (!changed.includes(0))
                device.queue.writeBuffer(
                    models[0] as GPUBuffer,
                    0,
                    modelData(0, c, evolutionAt(c.evolution, timeS), c.offset, growth),
                );
            const nextVolumeKey = `${mapKeys[0]},${c.offset},${c.extentKm},${c.heightKm},${c.profileDepthKm},${c.sdfRangeKm},${growth.billows},${growth.billowCells},${growth.towerScale}`;
            const rebuildVolume = c.enabled && nextVolumeKey !== volumeKey;
            const nextLightKey = `${nextVolumeKey},${c.baseKm},${current.observerHeightM},${current.planetRadiusKm},${current.sunDirection.join(",")}`;
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
                sweep(pass, shapePipeline, shapeBindGroup);
                sweep(pass, floodInitPipeline, floodInitBindGroup);
                for (const group of floodJumpBindGroups) sweep(pass, floodJumpPipeline, group);
                sweep(pass, modelingPipeline, modelingBindGroup);
                sweep(pass, ambientPipeline, ambientBindGroup);
                pass.setPipeline(coveragePipeline);
                pass.setBindGroup(0, coverageBindGroup);
                pass.dispatchWorkgroups(grid.layers);
            }
            if (rebuildLight) sweep(pass, lightPipeline, lightBindGroup);
            pass.end();
            if (!frameEncoder) device.queue.submit([encoder.finish()]);
        },

        encode(encoder, target, encodeOptions = {}) {
            const { background: behind, aerialPerspective: air, timestampWrites } = encodeOptions;
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
            }
            const cloudsOutput = bindGroup(cloudsPipeline, [{ binding: 0, resource: cloudsView as GPUTextureView }], 1);
            const [cloudsGroup, composeGroup] = groupsFor(behind ?? noBackground, air);
            // The air's reach and scale, into the cloudscape's block of the frame's uniforms.
            const aerial = air ? [air.maxDistanceKm, air.scale] : [0, 1];
            device.queue.writeBuffer(params, AERIAL_OFFSET, new Float32Array(aerial));
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
            pass.setBindGroup(0, cloudsGroup);
            pass.setBindGroup(1, cloudsOutput);
            pass.dispatchWorkgroups(dispatch(width, 8), dispatch(height, 8));
            pass.setPipeline(composePipeline);
            pass.setBindGroup(0, composeGroup);
            pass.setBindGroup(1, output);
            pass.dispatchWorkgroups(dispatch(target.width, 8), dispatch(target.height, 8));
            pass.end();
        },

        destroy() {
            for (const texture of [map, ...flood, shape, modeling, light, ambient, detail, noBackground, noAir])
                texture.destroy();
            clouds?.destroy();
            for (const buffer of [params, cloudscape, sunlight, coverage, ...models, ...jumpBuffers]) buffer.destroy();
        },
    };
}
