import { blueNoiseTexture, type ToneCurve } from "@himmelszelt/helldunkel";
import {
    AERIAL_OFFSET,
    CLOUDSCAPE_SIZE,
    type CloudParams,
    type CloudscapeParams,
    cloudscapeData,
    DEFAULT_CLOUD_PARAMS,
    evolutionAt,
    MAX_SHEETS,
    MODEL_SIZE,
    modelData,
    PARAMS_SIZE,
    paramsData,
    SUNLIGHT_ENTRIES,
    SUNLIGHT_SIZE,
    type SunlightRow,
    sizedCloudscape,
    steppedHeightM,
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
    /**
     * Dither the tone mapped output against banding by a step of helldunkel's blue noise, false by default: for an
     * 8-bit target over smooth gradients.
     */
    dither?: boolean;
    /** The blue noise to dither by, helldunkel's `blueNoiseTexture(device)` by default: one for a frame's passes. */
    blueNoise?: GPUTexture;
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
    /** The air the sunlight comes through, for the sunlight table computed here on the GPU, in the frame's own encoder,
     *  as the sun moves: dunstkreis' `AtmosphereLUTs` as they are. A `sunlight` table given to `update` overrides it. */
    atmosphere?: SunlightAtmosphere;
    /** Whether the cloudscape changes by keyframes, false by default: its volumes are then built ahead, over as many
     *  frames as the caller likes, and the march reads a blend of the last two, see `Keyframes`. Three more sets of
     *  the volumes in memory. */
    keyframes?: boolean;
    /** Timestamps around the detail noise's pass, the one thing computed at creation, for timing it. */
    timestampWrites?: GPUComputePassTimestampWrites;
}

/** Where a keyframe's passes go and how they are timed: the frame's own encoder, or one submitted at once. */
export interface KeyframeOptions {
    encoder?: GPUCommandEncoder;
    /** Timestamps from the first pass of the call to its last; a step that only copies has no pass. */
    timestampWrites?: GPUComputePassTimestampWrites;
}

/**
 * The cloudscape by keyframes: the clouds as last updated are built into a set of volumes of their own, step by step,
 * while the march reads a blend of the two sets before it. The caller paces it: `begin` when `stale`, `advance` a few
 * steps a frame, `blend` towards the newest every frame, and `promote` the one that waits once the blend reached 1.
 */
export interface Keyframes {
    /** Whether the cloudscape as last updated differs from the newest keyframe, built or being built. */
    readonly stale: boolean;
    /** Steps left of the build that runs, 0 for none. */
    readonly pending: number;
    /** Whether a built keyframe waits to be promoted. */
    readonly ready: boolean;
    /** Starts a build of the cloudscape as last updated; false while one runs or waits, or with the cloudscape off. */
    begin(): boolean;
    /** Runs up to `count` steps of the build and returns their names; those of plain copies start with "copy:". */
    advance(count: number, options?: KeyframeOptions): string[];
    /** The keyframe that waits becomes the one blended towards, the one before it the one blended from. */
    promote(): void;
    /** Writes the volumes the march reads, between the last two keyframes: `t` 0 for the older, 1 for the newer. */
    blend(t: number, options?: KeyframeOptions): void;
}

/**
 * The air for the sunlight table: dunstkreis' `DkAtmosphere` uniform, its transmittance table and the sampler for it,
 * as its `AtmosphereLUTs` hold them, of the dunstkreis version gewoelk was built with. The table's rays start in the
 * sun's apparent direction: `apparentElevation` lifts a true elevation in radians at an altitude in km to it, none by
 * default, as dunstkreis' `refractionAngle` traces it.
 */
export interface SunlightAtmosphere {
    atmosphereBuffer: GPUBuffer;
    transmittance: GPUTexture;
    sampler: GPUSampler;
    apparentElevation?: (altitudeKm: number, elevation: number) => number;
}

/**
 * An aerial perspective volume: the `aerialPerspective` of dunstkreis' sky pass as it is, made for the same camera.
 * Froxels over the camera's frustum in linear sRGB, two 3D rgba16float textures that hold their own reach and
 * exponent, as dunstkreis' `wgsl.aerial` lays them out; its lookup is bundled here.
 */
export interface AerialPerspective {
    luminance: GPUTexture;
    transmittance: GPUTexture;
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
    /** The cloudscape's keyframes, with `keyframes`; null without. */
    readonly keyframes: Keyframes | null;
    /** Bytes of the textures the pass holds: maps, volumes, the flood's and the detail noise. */
    readonly memoryBytes: number;
    /**
     * Takes the parameters over and writes the uniforms, and rebuilds what they changed: a cloud map when its shape
     * evolved, the cloudscape's voxels and distance field after its map, and its light after that or when the sun
     * moved. Submitted on its own, or recorded into `encoder` to go with the frame's own submission. With `keyframes`
     * the cloudscape is left to them, but for the first, built here at once unless `firstKeyframe` is false and the
     * caller builds that too. Returns whether anything was rebuilt in a pass of its own, which `timestampWrites` then
     * times.
     */
    update(
        params: Partial<CloudParams>,
        encoder?: GPUCommandEncoder,
        options?: { timestampWrites?: GPUComputePassTimestampWrites; firstKeyframe?: boolean },
    ): boolean;
    /** Records the clouds into `target`, which needs `STORAGE_BINDING` usage and the pass' format. */
    encode(encoder: GPUCommandEncoder, target: GPUTexture, options?: EncodeOptions): void;
    destroy(): void;
}

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
    const dither = options.dither ?? false;
    const keyframed = options.keyframes ?? false;
    // Bound whatever `dither` says: the binding stays in the layout.
    const blueNoise = options.blueNoise ?? blueNoiseTexture(device);
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
    const volume = (label: string, format: GPUTextureFormat, across = grid.size) =>
        device.createTexture({ label, dimension: "3d", size: [across, across, grid.layers], format, usage });
    const flood = [volume("gewoelk:floodA", "r32uint"), volume("gewoelk:floodB", "r32uint")] as const;
    const shape = volume("gewoelk:shape", "r32uint");
    const modeling = volume("gewoelk:modeling", "rgba8unorm");
    const light = volume("gewoelk:light", "rgba16float");
    // Smooth across, as light through the clouds around is: half the grid's voxels east and north, a quarter the rays.
    const ambient = volume("gewoelk:ambient", "rgba16float", Math.max(1, grid.size >> 1));
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
    // The detail noise tiles in all three axes: clamping its height would break the filter at every tile edge, a seam
    // through every cloud.
    const detailSampler = device.createSampler({
        addressModeU: "repeat",
        addressModeV: "repeat",
        addressModeW: "repeat",
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
    // What the deck lets through to the ground on average, the sun's light and the sky's; all of it until measured.
    const deck = device.createBuffer({
        label: "gewoelk:deck",
        size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(deck, 0, new Float32Array([1, 1, 1, 1]));
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
        deckPipeline,
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
        pipeline("deck", lightModule, "gwDeck"),
        pipeline(
            "clouds",
            module("gewoelk:clouds", [
                wgsl.noise,
                wgsl.params,
                wgsl.camera,
                wgsl.aerial,
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
                wgsl.aerial,
                wgsl.sheet,
                wgsl.whitebalance,
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

    // The sunlight table from the air's transmittance, with `atmosphere`: per entry an altitude and the sine of the
    // sun's apparent elevation in, the illuminance out, copied into the table's place in the sunlight uniform.
    const air = options.atmosphere;
    const tableEntries = 4 * SUNLIGHT_ENTRIES;
    const sunTable = air
        ? await (async () => {
              const tablePipeline = await pipeline(
                  "sunlight",
                  module("gewoelk:sunlight", [wgsl.airLookup, wgsl.sunlight]),
                  "gwSunlightTable",
              );
              const query = device.createBuffer({
                  label: "gewoelk:sunlightQuery",
                  size: tableEntries * 8,
                  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
              });
              const values = device.createBuffer({
                  label: "gewoelk:sunlightTable",
                  size: tableEntries * 16,
                  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
              });
              const group = bindGroup(tablePipeline, [
                  { binding: 0, resource: { buffer: air.atmosphereBuffer } },
                  { binding: 1, resource: air.transmittance.createView() },
                  { binding: 2, resource: air.sampler },
                  { binding: 3, resource: { buffer: query } },
                  { binding: 4, resource: { buffer: values } },
              ]);
              return { pipeline: tablePipeline, query, values, group };
          })()
        : null;
    const mapArray = map.createView({ dimension: "2d-array" });
    const cloudMapGroup = (model: GPUBuffer, view: GPUTextureView) =>
        bindGroup(cloudMapPipeline, [
            { binding: 0, resource: { buffer: model } },
            { binding: 1, resource: view },
        ]);
    const floodInitBindGroup = bindGroup(floodInitPipeline, [
        { binding: 4, resource: flood[0].createView() },
        { binding: 9, resource: shape.createView() },
    ]);
    // What a build writes, the volumes the march reads or a keyframe's own, and the uniforms it reads.
    type Volumes = { mapView: GPUTextureView; modeling: GPUTexture; light: GPUTexture; ambient: GPUTexture };
    type Uniforms = { params: GPUBuffer; cloudscape: GPUBuffer; model: GPUBuffer };
    const buildGroups = (to: Volumes & { deck: GPUBuffer }, from: Uniforms) => {
        const modelEntries: GPUBindGroupEntry[] = [
            { binding: 0, resource: { buffer: from.model } },
            { binding: 1, resource: to.mapView },
            { binding: 2, resource: volumeSampler },
        ];
        return {
            cloudMap: cloudMapGroup(from.model, to.mapView),
            shape: bindGroup(shapePipeline, [
                ...modelEntries,
                { binding: 6, resource: { buffer: from.cloudscape } },
                { binding: 8, resource: shape.createView() },
            ]),
            floodJumps: jumpBuffers.map((buffer, i) =>
                bindGroup(floodJumpPipeline, [
                    { binding: 3, resource: (flood[i % 2] as GPUTexture).createView() },
                    { binding: 4, resource: (flood[(i + 1) % 2] as GPUTexture).createView() },
                    { binding: 5, resource: { buffer } },
                    { binding: 6, resource: { buffer: from.cloudscape } },
                ]),
            ),
            modeling: bindGroup(modelingPipeline, [
                ...modelEntries,
                { binding: 3, resource: (flood[jumps.length % 2] as GPUTexture).createView() },
                { binding: 6, resource: { buffer: from.cloudscape } },
                { binding: 7, resource: to.modeling.createView() },
                { binding: 9, resource: shape.createView() },
            ]),
            light: bindGroup(lightPipeline, [
                { binding: 0, resource: { buffer: from.params } },
                { binding: 1, resource: to.modeling.createView() },
                { binding: 2, resource: volumeSampler },
                { binding: 3, resource: to.light.createView() },
                { binding: 5, resource: { buffer: coverage } },
            ]),
            coverage: bindGroup(coveragePipeline, [
                { binding: 1, resource: to.modeling.createView() },
                { binding: 4, resource: { buffer: coverage } },
            ]),
            ambient: bindGroup(ambientPipeline, [
                { binding: 0, resource: { buffer: from.params } },
                { binding: 1, resource: to.modeling.createView() },
                { binding: 2, resource: volumeSampler },
                { binding: 5, resource: { buffer: coverage } },
                { binding: 6, resource: to.ambient.createView() },
            ]),
            deck: bindGroup(deckPipeline, [
                { binding: 0, resource: { buffer: from.params } },
                { binding: 7, resource: to.light.createView() },
                { binding: 8, resource: to.ambient.createView() },
                { binding: 9, resource: { buffer: to.deck } },
            ]),
        };
    };
    // Without keyframes a build writes the volumes the march reads, from the frame's own uniforms.
    const live = buildGroups(
        { mapView: mapArray, modeling, light, ambient, deck },
        { params, cloudscape, model: models[0] as GPUBuffer },
    );
    const cloudMapBindGroups = models.map((model, i) => (i === 0 ? live.cloudMap : cloudMapGroup(model, mapArray)));
    const detailBindGroup = bindGroup(detailPipeline, [{ binding: 0, resource: detail.createView() }]);

    // With keyframes: three sets of the cloudscape's map and volumes, the two the march's are blended from and the one
    // being built, and the uniforms as they were when its build began, so a build over many frames sees one moment.
    type CloudscapeKeys = { map: string; volume: string; light: string; ambient: string };
    type Step = {
        name: string;
        pass?: (pass: GPUComputePassEncoder) => void;
        copy?: (encoder: GPUCommandEncoder) => void;
    };
    const snapshot = keyframed
        ? {
              params: uniform("gewoelk:keyframeParams", PARAMS_SIZE),
              cloudscape: uniform("gewoelk:keyframeCloudscape", CLOUDSCAPE_SIZE),
              model: uniform("gewoelk:keyframeModel", MODEL_SIZE),
          }
        : null;
    const frames = snapshot
        ? [0, 1, 2].map((i) => {
              const copyable = usage | GPUTextureUsage.COPY_DST;
              const own = (label: string, format: GPUTextureFormat, across = grid.size) =>
                  device.createTexture({
                      label: `gewoelk:${label}${i}`,
                      dimension: "3d",
                      size: [across, across, grid.layers],
                      format,
                      usage: copyable,
                  });
              const frameMap = device.createTexture({
                  label: `gewoelk:keyframeMap${i}`,
                  size: [mapSize, mapSize, 1],
                  format: "rgba16float",
                  usage: copyable,
              });
              const frameDeck = device.createBuffer({
                  label: `gewoelk:keyframeDeck${i}`,
                  size: 16,
                  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
              });
              device.queue.writeBuffer(frameDeck, 0, new Float32Array([1, 1, 1, 1]));
              const volumes = {
                  map: frameMap,
                  mapView: frameMap.createView({ dimension: "2d-array" }),
                  modeling: own("keyframeModeling", "rgba8unorm"),
                  light: own("keyframeLight", "rgba16float"),
                  ambient: own("keyframeAmbient", "rgba16float", ambient.width),
                  deck: frameDeck,
              };
              return { ...volumes, groups: buildGroups(volumes, snapshot), keys: null as CloudscapeKeys | null };
          })
        : [];
    const morph = keyframed
        ? await (async () => {
              const morphModule = module("gewoelk:morph", [wgsl.morph]);
              const [volumePipeline, ambientPipeline, mapPipeline] = await Promise.all([
                  pipeline("morphVolume", morphModule, "gwMorphVolume"),
                  pipeline("morphAmbient", morphModule, "gwMorphAmbient"),
                  pipeline("morphMap", morphModule, "gwMorphMap"),
              ]);
              return { volumePipeline, ambientPipeline, mapPipeline, t: uniform("gewoelk:morph", 16) };
          })()
        : null;
    const mapLayer0 = map.createView({ dimension: "2d", baseArrayLayer: 0, arrayLayerCount: 1 });
    const morphGroups = new Map<string, [GPUBindGroup, GPUBindGroup, GPUBindGroup]>();
    const morphGroupsFor = (a: number, b: number) => {
        const cached = morphGroups.get(`${a},${b}`);
        const [from, to] = [frames[a], frames[b]];
        if (cached || !morph || !from || !to) return cached;
        const t = { binding: 0, resource: { buffer: morph.t } };
        const groups: [GPUBindGroup, GPUBindGroup, GPUBindGroup] = [
            bindGroup(morph.volumePipeline, [
                t,
                { binding: 1, resource: from.modeling.createView() },
                { binding: 2, resource: to.modeling.createView() },
                { binding: 3, resource: modeling.createView() },
                { binding: 4, resource: from.light.createView() },
                { binding: 5, resource: to.light.createView() },
                { binding: 6, resource: light.createView() },
            ]),
            bindGroup(morph.ambientPipeline, [
                t,
                { binding: 7, resource: from.ambient.createView() },
                { binding: 8, resource: to.ambient.createView() },
                { binding: 9, resource: ambient.createView() },
            ]),
            bindGroup(morph.mapPipeline, [
                t,
                { binding: 10, resource: from.map.createView({ dimension: "2d" }) },
                { binding: 11, resource: to.map.createView({ dimension: "2d" }) },
                { binding: 12, resource: mapLayer0 },
                { binding: 13, resource: { buffer: from.deck } },
                { binding: 14, resource: { buffer: to.deck } },
                { binding: 15, resource: { buffer: deck } },
            ]),
        ];
        morphGroups.set(`${a},${b}`, groups);
        return groups;
    };
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
        { binding: 12, resource: { buffer: deck } },
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
                { binding: 13, resource: detailSampler },
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
                { binding: 10, resource: light.createView() },
                { binding: 11, resource: { buffer: deck } },
                { binding: 12, resource: blueNoise.createView() },
            ]),
        ];
        return inputGroups;
    };

    // The detail noise, once.
    {
        const encoder = device.createCommandEncoder({ label: "gewoelk:detail" });
        const { timestampWrites } = options;
        const pass = encoder.beginComputePass({ label: "gewoelk:detail", ...(timestampWrites && { timestampWrites }) });
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
    let deckKey = "";
    let ambientKey = "";
    let clouds: GPUTexture | null = null;
    let cloudsView: GPUTextureView | null = null;
    const outputs = new WeakMap<GPUTexture, GPUBindGroup>();

    const sweep = (pass: GPUComputePassEncoder, pipeline: GPUComputePipeline, group: GPUBindGroup) => {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(dispatch(grid.size, 4), dispatch(grid.size, 4), dispatch(grid.layers, 4));
    };
    const runCloudMap = (pass: GPUComputePassEncoder, group: GPUBindGroup) => {
        pass.setPipeline(cloudMapPipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(dispatch(mapSize, 8), dispatch(mapSize, 8));
    };
    const runCoverage = (pass: GPUComputePassEncoder, group: GPUBindGroup) => {
        pass.setPipeline(coveragePipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(grid.layers);
    };
    const runAmbient = (pass: GPUComputePassEncoder, group: GPUBindGroup) => {
        pass.setPipeline(ambientPipeline);
        pass.setBindGroup(0, group);
        const across = dispatch(ambient.width, 4);
        pass.dispatchWorkgroups(across, across, dispatch(grid.layers, 4));
    };
    const runDeck = (pass: GPUComputePassEncoder, group: GPUBindGroup) => {
        pass.setPipeline(deckPipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
    };

    // What the cloudscape's map, its volume, its light and its ambient light each depend on: a change of the key is a
    // rebuild of that part. The ambient grid depends on the density too, which the light grid leaves out.
    const cloudscapeGrowth = (c: CloudscapeParams) => ({
        towers: c.towers ?? 0,
        billows: c.billows ?? 0,
        billowCells: Math.max(1, Math.round(c.extentKm / (c.billowKm ?? 0.5))),
        towerScale: Math.max(1, c.towerScale ?? 1),
    });
    const mapKeyOf = (
        model: { coverage: number; sharpness: number; seed: number; octaves: number; cells: number },
        evolution: number,
        towers: number | undefined,
    ) =>
        `${model.coverage},${model.sharpness},${evolution},${model.seed},${model.octaves},${model.cells},${mapSize},${towers}`;
    const cloudscapeKeys = (c: CloudscapeParams, p: CloudParams) => {
        const growth = cloudscapeGrowth(c);
        const map = mapKeyOf(c, evolutionAt(c.evolution, p.timeS, c.evolutionOffset), growth.towers);
        const volume = `${map},${c.offset},${c.extentKm},${c.heightKm},${c.profileDepthKm},${c.sdfRangeKm},${growth.billows},${growth.billowCells},${growth.towerScale}`;
        const deck = `${c.extinction},${c.forwardG}`;
        return {
            map,
            volume,
            light: `${volume},${c.baseKm},${steppedHeightM(p.observerHeightM)},${p.planetRadiusKm},${p.sunDirection.join(",")}`,
            deck,
            ambient: `${volume},${c.baseKm},${p.planetRadiusKm},${deck}`,
        };
    };

    // The keyframes blended from and towards, the one that waits to be promoted and the build that runs, as indices
    // into `frames`; -1 for none.
    let from = -1;
    let to = -1;
    let waiting = -1;
    let building: { index: number; steps: Step[]; at: number } | null = null;
    const newestKeys = () => frames[building?.index ?? (waiting >= 0 ? waiting : to)]?.keys ?? null;
    const keyframes: Keyframes | null = keyframed
        ? {
              get stale() {
                  const c = sizedCloudscape(current.cloudscape);
                  if (!c.enabled) return false;
                  const [keys, newest] = [cloudscapeKeys(c, current), newestKeys()];
                  return !newest || (["map", "volume", "light", "ambient"] as const).some((k) => keys[k] !== newest[k]);
              },
              get pending() {
                  return building ? building.steps.length - building.at : 0;
              },
              get ready() {
                  return waiting >= 0;
              },
              begin() {
                  const c = sizedCloudscape(current.cloudscape);
                  if (!snapshot || building || waiting >= 0 || !c.enabled) return false;
                  const index = [0, 1, 2].find((i) => i !== from && i !== to) ?? 0;
                  const target = frames[index] as (typeof frames)[number];
                  // The newest keyframe is the one blended towards: what it shares with this one is copied from it.
                  const newest = frames[to] ?? null;
                  const keys = cloudscapeKeys(c, current);
                  const { fromRad, toRad } = sunlightRows(current)[0] as SunlightRow;
                  const evolution = evolutionAt(c.evolution, current.timeS, c.evolutionOffset);
                  device.queue.writeBuffer(snapshot.params, 0, paramsData(current, frame));
                  device.queue.writeBuffer(snapshot.cloudscape, 0, cloudscapeData(c, current.timeS, [fromRad, toRad]));
                  device.queue.writeBuffer(
                      snapshot.model,
                      0,
                      modelData(0, c, evolution, c.offset, cloudscapeGrowth(c)),
                  );
                  const groups = target.groups;
                  const copied = (name: string, a: GPUTexture, b: GPUTexture): Step => ({
                      name: `copy:${name}`,
                      copy: (encoder) =>
                          encoder.copyTextureToTexture({ texture: a }, { texture: b }, [
                              a.width,
                              a.height,
                              a.depthOrArrayLayers,
                          ]),
                  });
                  const steps: Step[] = [];
                  const same = (key: keyof CloudscapeKeys) => newest?.keys?.[key] === keys[key];
                  if (newest && same("map")) steps.push(copied("map", newest.map, target.map));
                  else steps.push({ name: "cloudMap", pass: (pass) => runCloudMap(pass, groups.cloudMap) });
                  if (newest && same("volume")) steps.push(copied("modeling", newest.modeling, target.modeling));
                  else {
                      steps.push(
                          { name: "shape", pass: (pass) => sweep(pass, shapePipeline, groups.shape) },
                          { name: "floodInit", pass: (pass) => sweep(pass, floodInitPipeline, floodInitBindGroup) },
                          ...groups.floodJumps.map((group, i) => ({
                              name: `floodJump${jumps[i]}`,
                              pass: (pass: GPUComputePassEncoder) => sweep(pass, floodJumpPipeline, group),
                          })),
                          { name: "modeling", pass: (pass) => sweep(pass, modelingPipeline, groups.modeling) },
                          { name: "coverage", pass: (pass) => runCoverage(pass, groups.coverage) },
                      );
                  }
                  if (newest && same("ambient")) steps.push(copied("ambient", newest.ambient, target.ambient));
                  else steps.push({ name: "ambient", pass: (pass) => runAmbient(pass, groups.ambient) });
                  if (newest && same("light")) steps.push(copied("light", newest.light, target.light));
                  else steps.push({ name: "light", pass: (pass) => sweep(pass, lightPipeline, groups.light) });
                  if (newest && same("ambient") && same("light")) {
                      const copy = (encoder: GPUCommandEncoder) =>
                          encoder.copyBufferToBuffer(newest.deck, 0, target.deck, 0, 16);
                      steps.push({ name: "copy:deck", copy });
                  } else steps.push({ name: "deck", pass: (pass) => runDeck(pass, groups.deck) });
                  target.keys = keys;
                  building = { index, steps, at: 0 };
                  return true;
              },
              advance(count, { encoder: frameEncoder, timestampWrites } = {}) {
                  if (!building || !(count > 0)) return [];
                  const batch = building.steps.slice(building.at, building.at + count);
                  const encoder = frameEncoder ?? device.createCommandEncoder({ label: "gewoelk:keyframe" });
                  const passes = batch.filter((step) => step.pass);
                  for (const step of batch) {
                      step.copy?.(encoder);
                      if (!step.pass) continue;
                      // The batch's timestamps: the first pass' beginning and the last one's end.
                      const stamps = timestampWrites && {
                          querySet: timestampWrites.querySet,
                          ...(step === passes[0] && {
                              beginningOfPassWriteIndex: timestampWrites.beginningOfPassWriteIndex,
                          }),
                          ...(step === passes.at(-1) && { endOfPassWriteIndex: timestampWrites.endOfPassWriteIndex }),
                      };
                      const timed = stamps && (step === passes[0] || step === passes.at(-1));
                      const pass = encoder.beginComputePass({
                          label: `gewoelk:${step.name}`,
                          ...(timed ? { timestampWrites: stamps } : {}),
                      });
                      step.pass(pass);
                      pass.end();
                  }
                  building.at += batch.length;
                  if (building.at >= building.steps.length) {
                      waiting = building.index;
                      building = null;
                  }
                  if (!frameEncoder) device.queue.submit([encoder.finish()]);
                  return batch.map((step) => step.name);
              },
              promote() {
                  if (waiting < 0) return;
                  from = to >= 0 ? to : waiting;
                  to = waiting;
                  waiting = -1;
              },
              blend(t, { encoder: frameEncoder, timestampWrites } = {}) {
                  const groups = morphGroupsFor(from, to);
                  if (!morph || !groups) return;
                  device.queue.writeBuffer(morph.t, 0, new Float32Array([t, 0, 0, 0]));
                  const encoder = frameEncoder ?? device.createCommandEncoder({ label: "gewoelk:morph" });
                  const pass = encoder.beginComputePass({
                      label: "gewoelk:morph",
                      ...(timestampWrites ? { timestampWrites } : {}),
                  });
                  sweep(pass, morph.volumePipeline, groups[0]);
                  pass.setPipeline(morph.ambientPipeline);
                  pass.setBindGroup(0, groups[1]);
                  const across = dispatch(ambient.width, 4);
                  pass.dispatchWorkgroups(across, across, dispatch(grid.layers, 4));
                  pass.setPipeline(morph.mapPipeline);
                  pass.setBindGroup(0, groups[2]);
                  pass.dispatchWorkgroups(dispatch(mapSize, 8), dispatch(mapSize, 8));
                  pass.end();
                  if (!frameEncoder) device.queue.submit([encoder.finish()]);
              },
          }
        : null;

    const texel: Partial<Record<GPUTextureFormat, number>> = { r32uint: 4, rgba8unorm: 4, rgba16float: 8 };
    const memoryBytes = [
        map,
        ...flood,
        shape,
        modeling,
        light,
        ambient,
        detail,
        ...frames.flatMap((f) => [f.map, f.modeling, f.light, f.ambient]),
    ]
        .map((t) => t.width * t.height * t.depthOrArrayLayers * (texel[t.format] ?? 4))
        .reduce((a, b) => a + b, 0);

    return {
        get cloudsTexture() {
            return clouds;
        },
        mapTexture: map,
        modelingTexture: modeling,
        lightTexture: light,
        ambientTexture: ambient,
        detailTexture: detail,
        keyframes,
        memoryBytes,

        update(next, frameEncoder, { timestampWrites, firstKeyframe = true } = {}) {
            current = { ...current, ...next };
            // The rows go with their table: a new table without them is for the current rows.
            if ("sunlight" in next && !("sunlightRows" in next)) current.sunlightRows = null;
            frame += 1;
            const { sheets, timeS } = current;
            const c = sizedCloudscape(current.cloudscape);
            device.queue.writeBuffer(params, 0, paramsData(current, frame));
            const { fromRad, toRad } = sunlightRows(current)[0] as SunlightRow;
            device.queue.writeBuffer(cloudscape, 0, cloudscapeData(c, timeS, [fromRad, toRad]));
            const computed = sunTable && !current.sunlight;
            // Computed, only the rows: the table itself is copied in after it.
            device.queue.writeBuffer(sunlight, 0, sunlightData(current), 0, computed ? 64 : SUNLIGHT_SIZE);
            if (computed) {
                const query = new Float32Array(tableEntries * 2);
                const lift = air?.apparentElevation ?? ((_: number, e: number) => e);
                sunlightRows(current).forEach((row, i) => {
                    for (let k = 0; k < SUNLIGHT_ENTRIES; k++) {
                        const elevation = row.fromRad + ((row.toRad - row.fromRad) * k) / (SUNLIGHT_ENTRIES - 1);
                        query.set(
                            [row.altitudeKm, Math.sin(lift(row.altitudeKm, elevation))],
                            (i * SUNLIGHT_ENTRIES + k) * 2,
                        );
                    }
                });
                device.queue.writeBuffer(sunTable.query, 0, query);
                const encoder = frameEncoder ?? device.createCommandEncoder({ label: "gewoelk:sunlight" });
                const pass = encoder.beginComputePass({ label: "gewoelk:sunlight" });
                pass.setPipeline(sunTable.pipeline);
                pass.setBindGroup(0, sunTable.group);
                pass.dispatchWorkgroups(dispatch(tableEntries, 64));
                pass.end();
                encoder.copyBufferToBuffer(sunTable.values, 0, sunlight, 64, tableEntries * 16);
                if (!frameEncoder) device.queue.submit([encoder.finish()]);
            }

            // With keyframes the cloudscape is theirs: only the first is built here, at once, so the clouds show.
            const first = firstKeyframe && keyframes && c.enabled && to < 0 && !building && waiting < 0;
            if (first && keyframes.begin()) {
                keyframes.advance(Number.POSITIVE_INFINITY, frameEncoder ? { encoder: frameEncoder } : {});
                keyframes.promote();
                keyframes.blend(1, frameEncoder ? { encoder: frameEncoder } : {});
            }

            // Which maps changed shape: the cloudscape's first, then the sheets'.
            const growth = cloudscapeGrowth(c);
            const shapes = [
                { model: c, evolution: evolutionAt(c.evolution, timeS, c.evolutionOffset), offset: c.offset, growth },
                ...sheets.slice(0, MAX_SHEETS).map((s) => ({
                    model: s,
                    evolution: evolutionAt(s.evolution, timeS, s.evolutionOffset),
                    offset: 0,
                    growth: undefined,
                })),
            ];
            const changed: number[] = [];
            shapes.forEach(({ model, evolution, offset, growth }, layer) => {
                if (keyframes && layer === 0) return;
                const key = mapKeyOf(model, evolution, growth?.towers);
                if (key === mapKeys[layer]) return;
                mapKeys[layer] = key;
                changed.push(layer);
                const data = modelData(layer, model, evolution, offset, growth);
                device.queue.writeBuffer(models[layer] as GPUBuffer, 0, data);
            });
            // The billows only shape the voxels: a change rewrites the cloudscape's model without remaking its map.
            if (!keyframes && !changed.includes(0))
                device.queue.writeBuffer(
                    models[0] as GPUBuffer,
                    0,
                    modelData(0, c, evolutionAt(c.evolution, timeS, c.evolutionOffset), c.offset, growth),
                );
            const keys = cloudscapeKeys(c, current);
            const rebuilt = c.enabled && !keyframes;
            const rebuildVolume = rebuilt && keys.volume !== volumeKey;
            const rebuildLight = rebuilt && keys.light !== lightKey;
            const rebuildDeck = rebuilt && keys.deck !== deckKey;
            const rebuildAmbient = rebuilt && keys.ambient !== ambientKey;
            if (changed.length === 0 && !rebuildVolume && !rebuildLight && !rebuildDeck && !rebuildAmbient)
                return false;
            if (rebuilt)
                [deckKey, ambientKey, volumeKey, lightKey] = [keys.deck, keys.ambient, keys.volume, keys.light];

            const encoder = frameEncoder ?? device.createCommandEncoder({ label: "gewoelk:update" });
            const pass = encoder.beginComputePass({
                label: "gewoelk:update",
                ...(timestampWrites ? { timestampWrites } : {}),
            });
            for (const layer of changed) runCloudMap(pass, cloudMapBindGroups[layer] as GPUBindGroup);
            if (rebuildVolume) {
                sweep(pass, shapePipeline, live.shape);
                sweep(pass, floodInitPipeline, floodInitBindGroup);
                for (const group of live.floodJumps) sweep(pass, floodJumpPipeline, group);
                sweep(pass, modelingPipeline, live.modeling);
                runCoverage(pass, live.coverage);
            }
            if (rebuildAmbient) runAmbient(pass, live.ambient);
            if (rebuildLight) sweep(pass, lightPipeline, live.light);
            if (rebuildLight || rebuildAmbient) runDeck(pass, live.deck);
            pass.end();
            if (!frameEncoder) device.queue.submit([encoder.finish()]);
            return true;
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
            // Whether the air comes from a volume, into the cloudscape's block of the frame's uniforms.
            device.queue.writeBuffer(params, AERIAL_OFFSET, new Float32Array([air ? 1 : 0]));
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
            for (const buffer of [params, cloudscape, sunlight, coverage, ...models, ...jumpBuffers, deck])
                buffer.destroy();
            for (const f of frames)
                for (const owned of [f.map, f.modeling, f.light, f.ambient, f.deck]) owned.destroy();
            for (const buffer of [snapshot?.params, snapshot?.cloudscape, snapshot?.model, morph?.t]) buffer?.destroy();
            sunTable?.query.destroy();
            sunTable?.values.destroy();
        },
    };
}
