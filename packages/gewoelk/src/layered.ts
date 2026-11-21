import { blueNoiseTexture, type ToneCurve } from "@himmelszelt/helldunkel";
import { createHighSheet, type HighSheetPass } from "./highsheet.js";
import { createLayerMarch, type LayerMarch, type LayerMarchSettings } from "./layerpass.js";
import {
    DEFAULT_LAYERED_PARAMS,
    type LayeredParams,
    type LayeredSky,
    layeredSky,
    type Sky,
    type SkyDials,
} from "./layers.js";
import {
    type CloudParams,
    DEFAULT_CLOUD_PARAMS,
    DEFAULT_CLOUDSCAPE,
    DEFAULT_SHEET,
    PARAMS_SIZE,
    paramsData,
    SUNLIGHT_ENTRIES,
    SUNLIGHT_SIZE,
    sunlightData,
    sunlightRows,
} from "./params.js";
import { WEATHER, type WeatherName } from "./weather.js";
import * as wgsl from "./wgsl/index.js";
import compose from "./wgsl/layered.comp.wgsl";

/** How finely the layered clouds are made: the marched layers' share of the target, their steps, and the maps' texels. */
export interface LayeredQuality {
    /** The marched layers' size as a share of the target's: at 0.5, a quarter of the rays. */
    scale: number;
    /** Steps a ray takes at most through the layers. */
    maxSteps: number;
    /** Texels across a layer's map, and across the high sheet's, a power of two. */
    mapSize: number;
    highMapSize: number;
}

/** Qualities to pick from by name: for a phone, a laptop, and a desktop's graphics card. */
export const LAYERED_QUALITY = {
    low: { scale: 1 / 3, maxSteps: 64, mapSize: 256, highMapSize: 1024 },
    medium: { scale: 0.5, maxSteps: 128, mapSize: 512, highMapSize: 2048 },
    high: { scale: 1, maxSteps: 256, mapSize: 1024, highMapSize: 4096 },
} satisfies Record<string, LayeredQuality>;

export interface LayeredCloudPassOptions {
    /** Format of the target `encode` composes into, with `STORAGE_BINDING` usage, as for `createCloudPass`. */
    format: GPUTextureFormat;
    /** A quality by name, "medium" by default, or its numbers, those left out as "medium" has them. */
    quality?: keyof typeof LAYERED_QUALITY | Partial<LayeredQuality>;
    /** Tone map for a display, "neutral" by default, "agx", "aces", "clip"; `false` writes the exposed luminance, linear. */
    toneMap?: ToneCurve | false;
    headroom?: number;
    /** Dither the tone mapped output by a step of helldunkel's blue noise, false by default, and the noise to take. */
    dither?: boolean;
    blueNoise?: GPUTexture;
    /** Whether `encode` composes over a background in cd/m², true by default; without, the clouds alone, premultiplied. */
    background?: boolean;
    /** How the layers are marched and lit, where it differs from `DEFAULT_LAYER_MARCH`. */
    march?: Partial<LayerMarchSettings>;
    /** A detail noise to share, as a cloud pass' `detailTexture`; without, the pass makes its own. */
    detail?: GPUTexture;
}

/**
 * What the layered clouds are told, all of it optional and kept until told otherwise: the sky, as a weather's name,
 * the kinds of cloud in its places or its numbers, turned by `coverage` and `density`; what moves and bounds it; and
 * the light and the camera as the voxel model takes them.
 */
export interface LayeredCloudParams
    extends Partial<Omit<CloudParams, "cloudscape" | "sheets">>,
        SkyDials,
        Partial<Omit<LayeredParams, "sky" | "timeS">> {
    weather?: WeatherName | Sky | LayeredSky;
    /** Where the observer stands over the ground the clouds were laid out on, in km east and north: [0, 0] at first. */
    observerKm?: readonly [number, number];
    /** How the layers are marched and lit, where it is to change. */
    march?: Partial<LayerMarchSettings>;
    /**
     * The sun's illuminance in lux at an altitude in km for the sun's elevation there in radians, for a sunlight table
     * of the caller's own air: clouds aloft stay lit after sunset on the ground. It stands in for `sunlight`; `null`
     * clears it.
     */
    sunlightAt?: ((altitudeKm: number, elevation: number) => readonly [number, number, number]) | null;
}

export interface LayeredUpdateOptions {
    /** Timestamps around the bake of the layers' maps and of the high sheet's, where one runs. */
    timestampWrites?: { maps?: GPUComputePassTimestampWrites; highMap?: GPUComputePassTimestampWrites };
}

export interface LayeredEncodeOptions {
    /** The sky behind the clouds, in cd/m², the target's size: a float texture with `TEXTURE_BINDING` usage. */
    background?: GPUTexture;
    /** Timestamps around the march, the sheet's read and the composition, for timing each. */
    timestampWrites?: {
        march?: GPUComputePassTimestampWrites;
        high?: GPUComputePassTimestampWrites;
        compose?: GPUComputePassTimestampWrites;
    };
}

/** The layered model as one pass: three marched layers and a sheet of high cloud, composed over a background. */
export interface LayeredCloudPass {
    /** The sky's numbers as last resolved from the weather and the dials. */
    readonly sky: LayeredSky;
    /** The marched layers and the high sheet, each a pass of its own: for their maps and their output. */
    readonly layers: LayerMarch;
    readonly high: HighSheetPass;
    readonly memoryBytes: number;
    /** Takes the parameters over, writes the uniforms and bakes the maps whose shape changed; returns whether any was. */
    update(params: LayeredCloudParams, encoder: GPUCommandEncoder, options?: LayeredUpdateOptions): boolean;
    /** Records the clouds into `target`, which needs `STORAGE_BINDING` usage and the pass' format. */
    encode(encoder: GPUCommandEncoder, target: GPUTexture, options?: LayeredEncodeOptions): void;
    destroy(): void;
}

const TONE_CURVES: Record<string, number> = { neutral: 1, agx: 2, aces: 3, clip: 4 };
// Under this coverage a layer or the sheet is not there: nothing is marched or read for it.
const NONE = 0.005;

/**
 * The layered model's clouds: `update` them with a weather and the frame's light, `encode` them into a target. Creates
 * no device, canvas or context of its own.
 */
export async function createLayeredCloudPass(
    device: GPUDevice,
    options: LayeredCloudPassOptions,
): Promise<LayeredCloudPass> {
    const { format, toneMap = "neutral", headroom = 1, background = true, dither = false } = options;
    const named = typeof options.quality === "string" ? LAYERED_QUALITY[options.quality] : options.quality;
    const quality: LayeredQuality = { ...LAYERED_QUALITY.medium, ...named };
    if (!(quality.scale > 0 && quality.scale <= 1)) throw new Error("gewoelk: the scale is above 0 and at most 1");
    const storable = ["rgba8unorm", "rgba16float", "rgba32float"].includes(format);
    if (!storable && !(format === "bgra8unorm" && device.features.has("bgra8unorm-storage"))) {
        throw new Error(`gewoelk: the pass writes ${format} as a storage texture, which this device cannot`);
    }
    const blueNoise = options.blueNoise ?? blueNoiseTexture(device);
    const [layers, high, pipeline] = await Promise.all([
        createLayerMarch(device, {
            ...options.march,
            mapSize: quality.mapSize,
            maxSteps: quality.maxSteps,
            ...(options.detail && { detail: options.detail }),
        }),
        createHighSheet(device, { mapSize: quality.highMapSize }),
        device.createComputePipelineAsync({
            label: "gewoelk:layered",
            layout: "auto",
            compute: {
                module: device.createShaderModule({
                    label: "gewoelk:layered",
                    code: [wgsl.params, wgsl.whitebalance, wgsl.tonemap, wgsl.cloudOutput(format), compose].join("\n"),
                }),
                entryPoint: "gwLayeredCompose",
                constants: {
                    GW_TONE_MAP: toneMap === false ? 0 : (TONE_CURVES[toneMap] ?? 1),
                    GW_HEADROOM: headroom,
                    GW_DITHER: dither ? 1 : 0,
                    GW_BACKGROUND: background ? 1 : 0,
                },
            },
        }),
    ]);
    const uniform = (label: string, size: number) =>
        device.createBuffer({ label, size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const params = uniform("gewoelk:layeredParams", PARAMS_SIZE);
    const sunlight = uniform("gewoelk:layeredSunlight", SUNLIGHT_SIZE);
    const placed = uniform("gewoelk:layeredPlaced", 16);
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    // Bound where no background is composed over: the binding stays in the layout whatever the override says.
    const noBackground = device.createTexture({
        label: "gewoelk:noBackground",
        size: [1, 1],
        format: "rgba32float",
        usage: GPUTextureUsage.TEXTURE_BINDING,
    });

    let current: LayeredCloudParams = {};
    let sky = layeredSky({});
    let frame = 0;
    const there = { layers: false, high: false };

    return {
        get sky() {
            return sky;
        },
        layers,
        high,
        get memoryBytes() {
            return layers.memoryBytes + high.memoryBytes;
        },
        update(next, encoder, { timestampWrites } = {}) {
            current = { ...current, ...next };
            frame += 1;
            const { weather = "fair", coverage, density, observerKm = [0, 0], march, sunlightAt, ...rest } = current;
            const chosen: Sky = typeof weather === "string" ? (WEATHER[weather].layers ?? {}) : weather;
            sky = layeredSky(chosen, {
                ...(coverage !== undefined && { coverage }),
                ...(density !== undefined && { density }),
            });
            const marched = [sky.low, sky.deep, sky.middle].filter((layer) => layer.coverage > NONE);
            there.layers = marched.length > 0;
            there.high = sky.high.coverage > NONE;
            // The sunlight table's rows stand at a cloudscape's base and top and at a sheet's altitude: those of the layers.
            const base = Math.min(...marched.map((layer) => layer.baseKm), sky.low.baseKm);
            const top = Math.max(
                ...marched.map((layer) => layer.baseKm + layer.depthKm),
                sky.low.baseKm + sky.low.depthKm,
            );
            const light: CloudParams = {
                ...DEFAULT_CLOUD_PARAMS,
                ...rest,
                cloudscape: {
                    ...DEFAULT_CLOUDSCAPE,
                    enabled: false,
                    baseKm: base,
                    heightKm: top - base,
                    towerScale: 1,
                    size: 1,
                },
                sheets: [{ ...DEFAULT_SHEET, enabled: false, altitudeKm: sky.high.altitudeKm }],
            };
            if (sunlightAt) {
                const rows = sunlightRows(light);
                const steps = Array.from({ length: SUNLIGHT_ENTRIES }, (_, k) => k / (SUNLIGHT_ENTRIES - 1));
                const table = rows.flatMap((row) =>
                    steps.map((t) => sunlightAt(row.altitudeKm, row.fromRad + (row.toRad - row.fromRad) * t)),
                );
                Object.assign(light, { sunlight: table, sunlightRows: rows });
            }
            device.queue.writeBuffer(params, 0, paramsData(light, frame));
            device.queue.writeBuffer(sunlight, 0, sunlightData(light));
            device.queue.writeBuffer(
                placed,
                0,
                new Float32Array([sky.high.altitudeKm, there.layers ? 1 : 0, there.high ? 1 : 0, 0]),
            );
            const { wind, highWind, shear, evolution, evolutionOffset, seed, clearingKm, clearingFromKm } = {
                ...DEFAULT_LAYERED_PARAMS,
                ...rest,
            };
            const layered: LayeredParams = {
                sky,
                wind,
                highWind,
                shear,
                evolution,
                ...(evolutionOffset !== undefined && { evolutionOffset }),
                seed,
                clearingKm,
                clearingFromKm,
                timeS: light.timeS,
            };
            const { maps, highMap } = timestampWrites ?? {};
            const baked = layers.update(layered, encoder, {
                observerKm,
                ...(march && { settings: march }),
                ...(maps && { timestampWrites: maps }),
            });
            return high.update(layered, encoder, { observerKm, ...(highMap && { timestampWrites: highMap }) }) || baked;
        },
        encode(encoder, target, { background: behind, timestampWrites } = {}) {
            const { width, height } = target;
            if (there.layers) {
                layers.encode(encoder, {
                    params,
                    sunlight,
                    width: Math.max(1, Math.round(width * quality.scale)),
                    height: Math.max(1, Math.round(height * quality.scale)),
                    ...(timestampWrites?.march && { timestampWrites: timestampWrites.march }),
                });
            }
            if (there.high) {
                high.encode(encoder, {
                    params,
                    sunlight,
                    width,
                    height,
                    ...(timestampWrites?.high && { timestampWrites: timestampWrites.high }),
                });
            }
            const pass = encoder.beginComputePass({
                label: "gewoelk:layered",
                ...(timestampWrites?.compose && { timestampWrites: timestampWrites.compose }),
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(
                0,
                device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: params } },
                        { binding: 1, resource: layers.texture.createView() },
                        { binding: 2, resource: sampler },
                        { binding: 3, resource: high.texture.createView() },
                        { binding: 4, resource: (behind ?? noBackground).createView() },
                        { binding: 5, resource: blueNoise.createView() },
                        { binding: 6, resource: { buffer: placed } },
                    ],
                }),
            );
            pass.setBindGroup(
                1,
                device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(1),
                    entries: [{ binding: 0, resource: target.createView() }],
                }),
            );
            pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
            pass.end();
        },
        destroy() {
            layers.destroy();
            high.destroy();
            for (const buffer of [params, sunlight, placed]) buffer.destroy();
            noBackground.destroy();
        },
    };
}
