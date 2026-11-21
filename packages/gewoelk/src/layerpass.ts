import type { CloudLayer, LayeredParams } from "./layers.js";
import { drift, evolutionAt } from "./params.js";
import * as wgsl from "./wgsl/index.js";
import layermap from "./wgsl/layermap.comp.wgsl";
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
};

/** What a layer march is created with: its settings, and what cannot change afterwards. */
export interface LayerMarchOptions extends Partial<LayerMarchSettings> {
    /** Texels across a layer's map, 512 by default. */
    mapSize?: number;
    /** A detail noise to share, as a cloud pass' `detailTexture`; without, the march makes its own, 128 texels a side. */
    detail?: GPUTexture;
    /** Steps a ray takes at most, 128 by default. */
    maxSteps?: number;
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
    /** The layers' maps, an array of the low, the deep and the middle layer's: for inspection. */
    readonly maps: GPUTexture;
    /** Bytes of the textures the march holds: the maps, its output, and the detail noise where it is its own. */
    readonly memoryBytes: number;
    /** Writes the uniforms for `params` and bakes the maps whose shape changed; returns whether any was baked. */
    update(params: LayeredParams, encoder: GPUCommandEncoder, options?: LayerUpdateOptions): boolean;
    /** Records the march into `texture`, sized `width` by `height`. */
    encode(encoder: GPUCommandEncoder, options: LayerEncodeOptions): void;
    destroy(): void;
}

const LAYERS = 3;
const DETAIL_SIZE = 128;
// Byte sizes of `GwLayerModel` in layermap.comp.wgsl, and of `GwLayered` and a `GwCloudLayer` in layers.comp.wgsl.
const MODEL_SIZE = 48;
const LAYERED_SIZE = 256;
const LAYER_OFFSET = 64;
const LAYER_SIZE = 64;
// How fast each layer drifts, as a share of the wind: the deep clouds slower, the middle ones faster.
const WIND_SHARE = [1, 0.6, 1.8] as const;
// The map's columns from a front's leading edge to its back, of which its towers stand in one.
const FRONT_COLUMNS = 12;
const DEG = Math.PI / 180;
const dispatch = (n: number, group: number) => Math.ceil(n / group);

/** Creates the layered model's march on `device`; it owns its maps and its output, not the frame's uniforms. */
export async function createLayerMarch(device: GPUDevice, options: LayerMarchOptions = {}): Promise<LayerMarch> {
    const { mapSize = 512, maxSteps = 128, detail: sharedDetail, ...given } = options;
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
    const [mapPipeline, marchPipeline, detailPipeline] = await Promise.all([
        pipeline("layerMap", [wgsl.noise, layermap], "gwLayerMap"),
        pipeline("layers", [wgsl.params, wgsl.camera, wgsl.cloudOutput("rgba16float"), layers], "gwLayers", {
            GW_LAYER_MAX_STEPS: maxSteps,
        }),
        ownDetail ? pipeline("layerDetail", [wgsl.noise, wgsl.detail], "gwDetail") : null,
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
        return { texture, group: bindGroup(marchPipeline, [{ binding: 0, resource: texture.createView() }], 1) };
    };
    let out = output(1, 1);
    // The group that takes the frame's uniforms, remade only when they are other buffers.
    let inputs: { params: GPUBuffer; sunlight: GPUBuffer; group: GPUBindGroup } | null = null;
    const baked = Array.from({ length: LAYERS }, () => "");

    return {
        get texture() {
            return out.texture;
        },
        maps,
        get memoryBytes() {
            const noise = ownDetail ? DETAIL_SIZE ** 3 * 4 : 0;
            return mapSize * mapSize * LAYERS * 8 + out.texture.width * out.texture.height * 8 + noise;
        },

        update(params, encoder, { settings: changed, observerKm, timestampWrites } = {}) {
            settings = { ...settings, ...changed };
            observer = observerKm ?? observer;
            const { sky, wind, timeS } = params;
            const speed = Math.hypot(wind[0], wind[1]);
            // Where the wind blows to. Without one the clouds stand upright and the anvils spread evenly.
            const along = speed > 0 ? ([wind[0] / speed, wind[1] / speed] as const) : ([0, 0] as const);
            const evolution = evolutionAt(params.evolution, timeS, params.evolutionOffset);
            const bearing = sky.deep.frontBearing * DEG;
            const heading = [Math.sin(bearing), Math.cos(bearing)] as const;

            const buffer = new ArrayBuffer(LAYERED_SIZE);
            const f = new Float32Array(buffer);
            const u = new Uint32Array(buffer);
            f.set([settings.noiseKm, settings.reachKm, settings.stepKm, settings.stepGrowth], 0);
            f.set([settings.multiScatter, settings.ambient, settings.fadeKm, params.clearingKm], 4);
            f.set([params.clearingFromKm, 0, along[0] * params.shear, along[1] * params.shear, ...observer], 8);

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
                const reach = (kind === 0 ? 0 : anvil) / Math.max(Math.hypot(x, y), 1e-6);
                const model = new ArrayBuffer(MODEL_SIZE);
                new Uint32Array(model).set([kind, i, (params.seed + i * 17) >>> 0, cells], 0);
                const extent = [front ? frontDepthKm : tileKm, tileKm];
                const shape = [layer.coverage, layer.sharpness, layer.lumps, evolution];
                new Float32Array(model).set([...shape, x * reach, y * reach, ...extent], 4);
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
                pass.dispatchWorkgroups(dispatch(mapSize, 8), dispatch(mapSize, 8));
            }
            pass.end();
            return true;
        },

        encode(encoder, { params, sunlight, width, height, timestampWrites }) {
            const [w, h] = [Math.max(1, Math.round(width)), Math.max(1, Math.round(height))];
            if (out.texture.width !== w || out.texture.height !== h) {
                out.texture.destroy();
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
                ]);
                inputs = { params, sunlight, group };
            }
            const pass = encoder.beginComputePass({
                label: "gewoelk:layers",
                ...(timestampWrites ? { timestampWrites } : {}),
            });
            pass.setPipeline(marchPipeline);
            pass.setBindGroup(0, inputs.group);
            pass.setBindGroup(1, out.group);
            pass.dispatchWorkgroups(dispatch(w, 8), dispatch(h, 8));
            pass.end();
        },

        destroy() {
            for (const texture of [maps, out.texture, ownDetail]) texture?.destroy();
            for (const buffer of [layered, ...models]) buffer.destroy();
        },
    };
}
