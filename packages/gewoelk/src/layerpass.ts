import { blueNoiseTexture } from "@himmelszelt/helldunkel";
import type { CloudLayer, LayeredParams } from "./layers.js";
import { drift, evolutionAt, steppedS } from "./params.js";
import { rainbowTable, rainExtinction } from "./rainbow.js";
import godrays from "./wgsl/godrays.comp.wgsl";
import * as wgsl from "./wgsl/index.js";
import layermap from "./wgsl/layermap.comp.wgsl";
import layerpyramid from "./wgsl/layerpyramid.comp.wgsl";
import layers from "./wgsl/layers.comp.wgsl";

/**
 * The layered model's march: three layers of cloud, each read from a map of its own, marched together per pixel with
 * no volume built first. It writes the layers alone, as the voxel march writes its cloudscape, from the same frame
 * uniform and sunlight table, for a compose pass that takes either.
 */

/** How the layers are marched and lit. Lengths in km. */
export interface LayerMarchSettings {
    /** The first step's length, and how steps grow with the distance, per km. */
    stepKm: number;
    stepGrowth: number;
    /** How far the march goes through the layers. */
    reachKm: number;
    /** The distance at which a cloud has faded to 1/e into the horizon's light: the air in between. */
    fadeKm: number;
    /** One tile of the detail noise. */
    noiseKm: number;
    /** Each further order of scattering's share of the one before, 0 for single scattering alone. */
    multiScatter: number;
    /** What the sky's and the ground's light on the clouds is multiplied by. */
    ambient: number;
    /**
     * Whether a ray's jitter is helldunkel's blue noise, the same every frame, not interleaved gradient noise: grain
     * without a lattice at the clouds' edges, where a few steps decide what a ray sees.
     */
    blueNoise: boolean;
}

/** The march's settings as the research figure's sliders had them. */
export const DEFAULT_LAYER_MARCH: LayerMarchSettings = {
    stepKm: 0.06,
    stepGrowth: 0.03,
    reachKm: 200,
    fadeKm: 90,
    noiseKm: 1.6,
    multiScatter: 0.6,
    ambient: 1,
    blueNoise: false,
};

/** What a layer march is created with: its settings, and what cannot change afterwards. */
export interface LayerMarchOptions extends Partial<LayerMarchSettings> {
    /** Texels across a layer's map, 512 by default. */
    mapSize?: number;
    /** A detail noise to share, as a cloud pass' `detailTexture`; without, the march makes its own, 128 texels a side. */
    detail?: GPUTexture;
    /** Steps a ray takes at most, 128 by default. */
    maxSteps?: number;
    /**
     * God rays: the shafts of sunlight and of the clouds' shade in the air, from a table of the layers' shade made anew
     * with every march, a quarter of `mapSize` by `mapSize` texels. Off by default: the air's shade is one number a ray.
     */
    godRays?: boolean;
    /**
     * An adaptive stride: a max pyramid of every map, a third of a map's texels in all and filled with it, tells a ray
     * whether the air ahead is clear, and where it is the ray strides as far as 32 km at once. The same picture but for
     * its grain, and as measured no faster: air outside the layers' slabs is cheap already, and within them a block that
     * is clear of cloud, bulge and shear included, is rare where clouds stand as close as they are wide. Off by default:
     * a ray strides 2.5 steps blindly through clear air and steps back at a cloud.
     */
    adaptiveStride?: boolean;
    /** The blue noise the rays are jittered by where `blueNoise` is set, helldunkel's `blueNoiseTexture(device)` by default. */
    blueNoiseTexture?: GPUTexture;
}

/** What an update may change besides the sky. */
export interface LayerUpdateOptions {
    /** Settings of the march to change, kept from then on. */
    settings?: Partial<LayerMarchSettings>;
    /** Where the observer stands over the ground the layers were laid out on, km east and north; kept, [0, 0] at first. */
    observerKm?: readonly [number, number];
    /** Timestamps around the maps' bake, where one runs. */
    timestampWrites?: GPUComputePassTimestampWrites;
}

/** A frame's inputs to the march: the voxel march's uniform and sunlight table, and the size to march at. */
export interface LayerEncodeOptions {
    /** `GwParams`, as `paramsData` packs it, and `GwSunlight`, as `sunlightData` does: uniform buffers. */
    params: GPUBuffer;
    sunlight: GPUBuffer;
    width: number;
    height: number;
    /** Timestamps around the pass, for timing it. */
    timestampWrites?: GPUComputePassTimestampWrites;
}

/** A layer march: its maps baked when their shape changes, and the layers marched into a texture of its own. */
export interface LayerMarch {
    /** The layers as last marched, premultiplied luminance in cd/m² and what they let through, rgba16float. */
    readonly texture: GPUTexture;
    /**
     * x the distances in km of what each pixel of `texture` shows, summed by their shares of the pixel, y those shares:
     * their quotient is the mean distance; rgba16float.
     */
    readonly depth: GPUTexture;
    /** `GwLayered` as the march reads it, `wgsl.layerread`'s: for a pass that reads the layers' maps itself. */
    readonly uniforms: GPUBuffer;
    /** The layers' maps, an array of the low, the deep and the middle layer's: for inspection. */
    readonly maps: GPUTexture;
    /** The maps' max pyramids with an adaptive stride, a layer of the array each and its levels: for inspection. */
    readonly pyramids: GPUTexture | null;
    /** The detail noise the layers' surfaces are heaped by, rgba8unorm, a volume that tiles: its own or the shared one. */
    readonly detail: GPUTexture;
    /** Bytes of the textures the march holds: the maps, their pyramids, its output and depth, and the detail noise where it is its own. */
    readonly memoryBytes: number;
    /** Writes the uniforms for `params` and bakes the maps whose shape changed; returns whether any was baked. */
    update(params: LayeredParams, encoder: GPUCommandEncoder, options?: LayerUpdateOptions): boolean;
    /** Records the march into `texture`, sized `width` by `height`. */
    encode(encoder: GPUCommandEncoder, options: LayerEncodeOptions): void;
    destroy(): void;
}

const LAYERS = 3;
const DETAIL_SIZE = 128;
// Texels a side of the tile a workgroup bakes of a layer's map, `GW_LAYER_MAP_TILE` in layermap.comp.wgsl.
const LAYER_MAP_TILE = 15;
// Byte sizes of `GwLayerModel` in layermap.comp.wgsl, and of `GwLayered` and a `GwCloudLayer` in layers.comp.wgsl.
const MODEL_SIZE = 56;
export const LAYERED_SIZE = 272;
const LAYER_OFFSET = 80;
const LAYER_SIZE = 64;
// How fast each layer drifts, as a share of the wind: the deep clouds slower, the middle ones faster.
const WIND_SHARE = [1, 0.6, 1.8] as const;
// How far rain lags behind its cloud per km it falls, in km for each m/s of wind: the air below is slower by some 0.3
// of the wind, and a drop of half a millimeter falls at 6.5 m/s.
const RAIN_LAG = 0.3 / 6.5;
// The map's columns from a front's leading edge to its back, of which its towers stand in one.
const FRONT_COLUMNS = 12;
const DEG = Math.PI / 180;
const dispatch = (n: number, group: number) => Math.ceil(n / group);

/** `values` as half floats, to the nearest, for a texture of 16 bit floats. */
function halfFloats(values: Float32Array): Uint16Array<ArrayBuffer> {
    const bits = new Uint32Array(values.buffer, values.byteOffset, values.length);
    return Uint16Array.from(bits, (x) => {
        const sign = (x >>> 16) & 0x8000;
        const exponent = ((x >>> 23) & 0xff) - 112;
        const mantissa = x & 0x7fffff;
        if (exponent <= 0)
            return exponent < -10 ? sign : sign | ((((mantissa | 0x800000) >>> (1 - exponent)) + 0x1000) >>> 13);
        if (exponent >= 31) return sign | 0x7bff;
        return (sign | (exponent << 10) | (mantissa >>> 13)) + ((mantissa >>> 12) & 1);
    });
}

/** Creates the layered model's march on `device`; it owns its maps and its output, not the frame's uniforms. */
export async function createLayerMarch(device: GPUDevice, options: LayerMarchOptions = {}): Promise<LayerMarch> {
    const { mapSize = 512, maxSteps = 128, godRays = false, adaptiveStride = false, ...rest } = options;
    const { detail: sharedDetail, blueNoiseTexture: blueNoise = blueNoiseTexture(device), ...given } = rest;
    let settings: LayerMarchSettings = { ...DEFAULT_LAYER_MARCH, ...given };
    let observer: readonly [number, number] = [0, 0];

    // Copyable too, so the maps and the march can be read back for inspection.
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const maps = device.createTexture({
        label: "gewoelk:layerMaps",
        size: [mapSize, mapSize, LAYERS],
        format: "rgba16float",
        usage,
    });
    // The pyramids' first level is half a map across, their last one texel: without them a texel of nothing.
    const pyramidSize = adaptiveStride ? Math.max(1, mapSize >> 1) : 1;
    const pyramidLevels = Math.floor(Math.log2(pyramidSize)) + 1;
    const pyramids = device.createTexture({
        label: "gewoelk:layerPyramids",
        size: [pyramidSize, pyramidSize, LAYERS],
        mipLevelCount: pyramidLevels,
        format: "rgba16float",
        usage,
    });
    const ownDetail = sharedDetail
        ? null
        : device.createTexture({
              label: "gewoelk:layerDetail",
              dimension: "3d",
              size: [DETAIL_SIZE, DETAIL_SIZE, DETAIL_SIZE],
              format: "rgba8unorm",
              usage,
          });
    const detailNoise = sharedDetail ?? (ownDetail as GPUTexture);
    const sampler = device.createSampler({
        addressModeU: "repeat",
        addressModeV: "repeat",
        addressModeW: "repeat",
        magFilter: "linear",
        minFilter: "linear",
    });
    const uniform = (label: string, size: number) =>
        device.createBuffer({ label, size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const layered = uniform("gewoelk:layered", LAYERED_SIZE);
    const models = Array.from({ length: LAYERS }, (_, i) => uniform(`gewoelk:layerModel${i}`, MODEL_SIZE));

    const pipeline = (label: string, code: string[], entryPoint: string, constants?: Record<string, number>) =>
        device.createComputePipelineAsync({
            label: `gewoelk:${label}`,
            layout: "auto",
            compute: {
                module: device.createShaderModule({ label: `gewoelk:${label}`, code: code.join("\n") }),
                entryPoint,
                ...(constants ? { constants } : {}),
            },
        });
    const read = [wgsl.params, wgsl.camera, wgsl.rainbow, wgsl.layerread];
    const march = [wgsl.noise, ...read, wgsl.cloudOutput("rgba16float"), layers, godrays];
    const constants = {
        GW_LAYER_MAX_STEPS: maxSteps,
        GW_GOD_RAYS: godRays ? 1 : 0,
        GW_LAYER_ADAPTIVE: adaptiveStride ? 1 : 0,
    };
    const [mapPipeline, marchPipeline, detailPipeline, shadePipeline, meansPipeline, pyramidPipeline] =
        await Promise.all([
            pipeline("layerMap", [wgsl.noise, layermap], "gwLayerMap"),
            pipeline("layers", march, "gwLayers", constants),
            ownDetail ? pipeline("layerDetail", [wgsl.noise, wgsl.detail], "gwDetail") : null,
            godRays ? pipeline("godRaysShade", march, "gwGodRaysShade") : null,
            godRays ? pipeline("godRaysMeans", march, "gwGodRaysMeans") : null,
            adaptiveStride ? pipeline("layerPyramid", [layerpyramid], "gwLayerPyramid") : null,
        ]);
    const bindGroup = (pipeline: GPUComputePipeline, entries: GPUBindGroupEntry[], group = 0) =>
        device.createBindGroup({ layout: pipeline.getBindGroupLayout(group), entries });
    const mapArray = maps.createView({ dimension: "2d-array" });
    const mapGroups = models.map((model) =>
        bindGroup(mapPipeline, [
            { binding: 0, resource: { buffer: model } },
            { binding: 1, resource: mapArray },
        ]),
    );
    // A map's pyramid, level by level: each from the level below, the first from the map.
    const pyramidGroups = models.map((_, layer) =>
        Array.from({ length: pyramidPipeline ? pyramidLevels : 0 }, (_, level) => {
            const one = { dimension: "2d", baseArrayLayer: layer, arrayLayerCount: 1, mipLevelCount: 1 } as const;
            const below = level === 0 ? maps.createView(one) : pyramids.createView({ ...one, baseMipLevel: level - 1 });
            return bindGroup(pyramidPipeline as GPUComputePipeline, [
                { binding: 0, resource: below },
                { binding: 1, resource: pyramids.createView({ ...one, baseMipLevel: level }) },
            ]);
        }),
    );

    // The detail noise, once.
    if (ownDetail && detailPipeline) {
        const encoder = device.createCommandEncoder({ label: "gewoelk:layerDetail" });
        const pass = encoder.beginComputePass({ label: "gewoelk:layerDetail" });
        pass.setPipeline(detailPipeline);
        pass.setBindGroup(0, bindGroup(detailPipeline, [{ binding: 0, resource: ownDetail.createView() }]));
        pass.dispatchWorkgroups(dispatch(DETAIL_SIZE, 4), dispatch(DETAIL_SIZE, 4), dispatch(DETAIL_SIZE, 4));
        pass.end();
        device.queue.submit([encoder.finish()]);
    }

    const output = (width: number, height: number) => {
        const texture = device.createTexture({
            label: "gewoelk:layers",
            size: [width, height],
            format: "rgba16float",
            usage,
        });
        const depth = device.createTexture({
            label: "gewoelk:layerDepth",
            size: [width, height],
            format: "rgba16float",
            usage,
        });
        const entries = [texture, depth].map((target, binding) => ({ binding, resource: target.createView() }));
        return { texture, depth, group: bindGroup(marchPipeline, entries, 1) };
    };
    let out = output(1, 1);
    // The rain's phase function, computed when it first rains: until then a texel of nothing.
    let rainbow = device.createTexture({
        label: "gewoelk:rainbow",
        size: [1, 1],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    let raining = false;
    const letItRain = () => {
        const table = rainbowTable();
        rainbow.destroy();
        rainbow = device.createTexture({
            label: "gewoelk:rainbow",
            size: [table.width, 1],
            format: "rgba16float",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture: rainbow }, halfFloats(table.data), {}, [table.width, 1]);
        raining = true;
        inputs = null;
    };
    // The god rays' table, a row for each direction and a column for each distance, and the shade it is summed from:
    // without god rays a texel of nothing each.
    const [columns, rows] = godRays ? [Math.max(2, mapSize / 4), mapSize] : [1, 1];
    const [shade, table] = ["godRaysShade", "godRays"].map((label) =>
        device.createTexture({ label: `gewoelk:${label}`, size: [columns, rows], format: "rgba16float", usage }),
    ) as [GPUTexture, GPUTexture];
    const rays = shadePipeline &&
        meansPipeline && {
            shade: shadePipeline,
            means: meansPipeline,
            shadeOut: bindGroup(shadePipeline, [{ binding: 0, resource: shade.createView() }], 1),
            summed: bindGroup(meansPipeline, [{ binding: 7, resource: shade.createView() }]),
            meansOut: bindGroup(meansPipeline, [{ binding: 0, resource: table.createView() }], 1),
        };
    // The groups that take the frame's uniforms, remade only when they are other buffers.
    let inputs: { params: GPUBuffer; sunlight: GPUBuffer; group: GPUBindGroup; shade: GPUBindGroup | null } | null =
        null;
    const baked = Array.from({ length: LAYERS }, () => "");

    return {
        get texture() {
            return out.texture;
        },
        get depth() {
            return out.depth;
        },
        maps,
        uniforms: layered,
        pyramids: adaptiveStride ? pyramids : null,
        detail: detailNoise,
        get memoryBytes() {
            const noise = ownDetail ? DETAIL_SIZE ** 3 * 4 : 0;
            const tables = 2 * columns * rows * 8;
            // A pyramid's levels sum to four thirds of its first, a little less.
            const maxima = Math.ceil((pyramidSize * pyramidSize * LAYERS * 8 * 4) / 3);
            const marched = out.texture.width * out.texture.height * (8 + 8);
            return mapSize * mapSize * LAYERS * 8 + maxima + marched + noise + tables;
        },

        update(params, encoder, { settings: changed, observerKm, timestampWrites } = {}) {
            settings = { ...settings, ...changed };
            observer = observerKm ?? observer;
            const { sky, wind, timeS } = params;
            const speed = Math.hypot(wind[0], wind[1]);
            // Where the wind blows to. Without one the clouds stand upright and the anvils spread evenly.
            const along = speed > 0 ? ([wind[0] / speed, wind[1] / speed] as const) : ([0, 0] as const);
            const evolution = evolutionAt(
                params.evolution,
                steppedS(timeS, params.evolutionEveryS),
                params.evolutionOffset,
            );
            const bearing = sky.deep.frontBearing * DEG;
            const heading = [Math.sin(bearing), Math.cos(bearing)] as const;

            const buffer = new ArrayBuffer(LAYERED_SIZE);
            const f = new Float32Array(buffer);
            const u = new Uint32Array(buffer);
            f.set([settings.noiseKm, settings.reachKm, settings.stepKm, settings.stepGrowth], 0);
            f.set([settings.multiScatter, settings.ambient, settings.fadeKm, params.clearingKm], 4);
            const rain = sky.deep.coverage > 0.005 ? rainExtinction(Math.max(sky.deep.rain, 0)) : 0;
            if (rain > 0 && !raining) letItRain();
            const lean = RAIN_LAG * speed;
            f.set([params.clearingFromKm, rain, along[0] * params.shear, along[1] * params.shear, ...observer], 8);
            f.set([along[0] * lean, along[1] * lean], 14);
            u[16] = settings.blueNoise ? 1 : 0;
            f.set(params.clearingCenterKm ?? [0, 0], 18);

            const changedMaps: number[] = [];
            const all: readonly CloudLayer[] = [sky.low, sky.deep, sky.middle];
            all.forEach((layer, i) => {
                const share = WIND_SHARE[i] as number;
                const front = i === 1 && sky.deep.kind === "front";
                const kind = i !== 1 ? 0 : front ? 3 : 2;
                const enabled = layer.coverage > 0.005;
                // A front comes on with the wind, its edge nearer by as much as its layer has drifted, whichever way
                // the wind blows; its billows come with it.
                const moved = (speed * share * timeS) / 1000;
                const drifted = front
                    ? drift([-heading[0] * speed * share, -heading[1] * speed * share], timeS)
                    : drift([wind[0] * share, wind[1] * share], timeS);
                const at = (LAYER_OFFSET + i * LAYER_SIZE) / 4;
                const { baseKm, depthKm, tileKm, sizeKm, extinction, detail, bulge } = layer;
                const { frontKm, frontDepthKm, anvil } = sky.deep;
                u.set([enabled ? 1 : 0, kind], at);
                f.set([baseKm, depthKm, tileKm, sizeKm, extinction, detail, bulge], at + 2);
                if (front) f.set([frontKm - moved, frontDepthKm], at + 9);
                f.set([...drifted, ...heading], at + 12);
                if (!enabled) return;

                const cells = Math.max(1, Math.round(tileKm / Math.max(sizeKm, 1e-3)));
                // The wind in the map's cells: a front's map lies along its bearing, its columns from its edge to its
                // back. The anvils reach `anvil` cells along it.
                const [x, y] = front
                    ? [
                          ((along[0] * heading[0] + along[1] * heading[1]) * FRONT_COLUMNS) / frontDepthKm,
                          ((along[0] * heading[1] - along[1] * heading[0]) * cells) / tileKm,
                      ]
                    : along;
                const anvils = kind === 0 ? 0 : anvil;
                const reach = anvils / Math.max(Math.hypot(x, y), 1e-6);
                const model = new ArrayBuffer(MODEL_SIZE);
                new Uint32Array(model).set([kind, i, (params.seed + i * 17) >>> 0, cells], 0);
                const extent = [front ? frontDepthKm : tileKm, tileKm];
                const shape = [layer.coverage, layer.sharpness, layer.lumps, evolution];
                new Float32Array(model).set([...shape, x * reach, y * reach, ...extent, anvils], 4);
                // A map is its model: baked again when a bit of it differs from what the map was last baked from.
                const key = new Uint32Array(model).join();
                if (key === baked[i]) return;
                baked[i] = key;
                changedMaps.push(i);
                device.queue.writeBuffer(models[i] as GPUBuffer, 0, model);
            });
            device.queue.writeBuffer(layered, 0, buffer);
            if (changedMaps.length === 0) return false;

            const pass = encoder.beginComputePass({
                label: "gewoelk:layerMaps",
                ...(timestampWrites ? { timestampWrites } : {}),
            });
            pass.setPipeline(mapPipeline);
            for (const i of changedMaps) {
                pass.setBindGroup(0, mapGroups[i] as GPUBindGroup);
                pass.dispatchWorkgroups(dispatch(mapSize, LAYER_MAP_TILE), dispatch(mapSize, LAYER_MAP_TILE));
            }
            if (pyramidPipeline) {
                pass.setPipeline(pyramidPipeline);
                for (const i of changedMaps) {
                    (pyramidGroups[i] as GPUBindGroup[]).forEach((group, level) => {
                        pass.setBindGroup(0, group);
                        pass.dispatchWorkgroups(dispatch(pyramidSize >> level, 8), dispatch(pyramidSize >> level, 8));
                    });
                }
            }
            pass.end();
            return true;
        },

        encode(encoder, { params, sunlight, width, height, timestampWrites }) {
            const [w, h] = [Math.max(1, Math.round(width)), Math.max(1, Math.round(height))];
            if (out.texture.width !== w || out.texture.height !== h) {
                out.texture.destroy();
                out.depth.destroy();
                out = output(w, h);
            }
            if (inputs?.params !== params || inputs.sunlight !== sunlight) {
                const group = bindGroup(marchPipeline, [
                    { binding: 0, resource: { buffer: params } },
                    { binding: 1, resource: { buffer: sunlight } },
                    { binding: 2, resource: { buffer: layered } },
                    { binding: 3, resource: mapArray },
                    { binding: 4, resource: sampler },
                    { binding: 5, resource: detailNoise.createView() },
                    { binding: 6, resource: rainbow.createView() },
                    { binding: 7, resource: table.createView() },
                    { binding: 8, resource: blueNoise.createView() },
                    { binding: 9, resource: pyramids.createView({ dimension: "2d-array" }) },
                ]);
                const lines = rays
                    ? bindGroup(rays.shade, [
                          { binding: 0, resource: { buffer: params } },
                          { binding: 2, resource: { buffer: layered } },
                          { binding: 3, resource: mapArray },
                          { binding: 4, resource: sampler },
                          { binding: 5, resource: detailNoise.createView() },
                      ])
                    : null;
                inputs = { params, sunlight, group, shade: lines };
            }
            const pass = encoder.beginComputePass({
                label: "gewoelk:layers",
                ...(timestampWrites ? { timestampWrites } : {}),
            });
            // The god rays' table first, for this frame's sun, clouds and observer: its shade, then that summed.
            if (rays && inputs.shade) {
                pass.setPipeline(rays.shade);
                pass.setBindGroup(0, inputs.shade);
                pass.setBindGroup(1, rays.shadeOut);
                pass.dispatchWorkgroups(dispatch(columns, 8), dispatch(rows, 8));
                pass.setPipeline(rays.means);
                pass.setBindGroup(0, rays.summed);
                pass.setBindGroup(1, rays.meansOut);
                pass.dispatchWorkgroups(1, dispatch(rows, 64));
            }
            pass.setPipeline(marchPipeline);
            pass.setBindGroup(0, inputs.group);
            pass.setBindGroup(1, out.group);
            pass.dispatchWorkgroups(dispatch(w, 8), dispatch(h, 8));
            pass.end();
        },

        destroy() {
            for (const texture of [maps, pyramids, out.texture, out.depth, ownDetail, rainbow, shade, table])
                texture?.destroy();
            for (const buffer of [layered, ...models]) buffer.destroy();
        },
    };
}
