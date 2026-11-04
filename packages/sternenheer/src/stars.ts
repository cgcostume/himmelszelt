import type { ToneCurve } from "@himmelszelt/helldunkel";
import { AIR_SAMPLES, type AirTable } from "./air.js";
import { STAR_FIELDS, type StarCatalog } from "./catalog.js";
import type { MilkyWay } from "./milkyway.js";
import * as wgsl from "./wgsl/index.js";

export interface StarsPassOptions {
    /** Format of the target `encode` writes, with `STORAGE_BINDING` usage: rgba8unorm for a display, bgra8unorm with
     *  "bgra8unorm-storage", rgba16float or rgba32float for linear output, or an HDR canvas. */
    format: GPUTextureFormat;
    /** The stars to draw, `loadCatalog`; without, the Milky Way alone. */
    catalog?: StarCatalog | null;
    /** The Milky Way, `loadMilkyWay`; without, the stars alone. */
    milkyWay?: MilkyWay | null;
    /** Tone map for a display, as dunstkreis' sky pass: "neutral" by default, "agx", "aces", "clip"; `false` writes the
     *  exposed luminance, linear, for a renderer that composes more over it, the Moon say. */
    toneMap?: ToneCurve | false;
    /** How many times SDR white an HDR display shows, 1 by default. */
    headroom?: number;
    /** Dither the tone mapped output against banding, by default for an 8-bit target only. */
    dither?: boolean;
    /** Whether `encode` composes over a background in cd/m², true by default. Without, it writes the stars' light
     *  alone, with alpha 0, for a renderer that adds it. */
    background?: boolean;
    /** The stars and the sky behind them as the eye sees them at night rather than a camera, by helldunkel's
     *  `hdNightVision`, on the composed light before the exposure. With a background only; off by default. */
    nightVision?: boolean;
    /** The tiles the stars are binned into, 16 pixels by default, and how many stars a tile holds, 64: beyond that
     *  the ones that come later in the catalog are dropped. */
    tileSize?: number;
    capacity?: number;
}

/** Everything that can change per frame. Directions ENU (x east, y north, z up). */
export interface StarsParams {
    /** The rotation from the catalog's J2000 equatorial frame into ENU, nine numbers column major: sternzeit's
     *  `stars.horizontalMatrix` for the moment and the place. Identity by default: the equinox east on the horizon. */
    skyRotation: Float32Array;
    /** Years since J2000.0, for the stars' proper motion; 0 by default. */
    years: number;
    /** Inverse view-projection, column major, and the projection's bend, as `@himmelszelt/dunstkreis`' sky pass. */
    inverseViewProjection: Float32Array;
    projectionDistance: number;
    /** Exposure in EV100: a moonless sky meters around -9, a moonlit one around -6. */
    ev100: number;
    /** The z below which a ray hits the ground; -1 by default, the whole sphere. */
    horizonZ: number;
    /** The air, `airTable`: bends every star and the Milky Way up near the horizon, dims and reddens them, and hides
     *  what lies below the horizon it finds. Null by default, no air. */
    air: AirTable | null;
    /** The width of a star's image on the target, in pixels: the standard deviation of its Gaussian point spread, 0.8
     *  by default, the viewer's eye blurring a point on the screen. Never under 0.6, so no star falls between pixels.
     *  On the sky the image narrows as the view zooms in, and the star brightens, as it does in a telescope. */
    psfPixels: number;
    /** How strongly the stars twinkle, 1 for what the eye sees, 0 for none; and the time in seconds the twinkling
     *  runs on, which a renderer advances per frame. */
    scintillation: number;
    time: number;
    /** The viewer's eye's veil around a bright star, CIE's glare equation by the angle on the viewer's own field of
     *  view, 1 for the eye's own, 0 for none, a camera. */
    glare: number;
    /** How many degrees of the viewer's field of view the target's height spans, for the veil: 30 by default, a
     *  screen at arm's length. */
    viewerFov: number;
    /** What the stars' light is multiplied by, and the Milky Way's, 1 for as measured. */
    starLight: number;
    milkyWay: number;
    /** Stars fainter than this magnitude are left out; 99 by default, all of them. */
    magnitudeLimit: number;
    /** The observer's height in meters and the pupil's diameter in cm, 0.7 at night, for how strongly the stars
     *  twinkle. */
    heightM: number;
    pupilCm: number;
    /** Below this exposed luminance, in units of display white, a star's image is cut off: 1/2048 by default. */
    threshold: number;
    /** No star's image, veil included, grows past this radius in pixels, 256 by default. */
    maxRadius: number;
}

export interface EncodeOptions {
    /** The sky behind the stars, in cd/m², the target's size: a float texture with `TEXTURE_BINDING` usage. */
    background?: GPUTexture;
    /** Timestamps around the compose pass, for timing it. */
    timestampWrites?: GPUComputePassTimestampWrites;
}

/** A stars pass: two compute passes, one over the catalog binning every star's image into the tiles of the target it
 *  reaches, one over the pixels summing them and the Milky Way behind, over a background, into a target the caller
 *  owns. It creates no device, canvas or context of its own. */
export interface StarsPass {
    /** Takes the parameters over and writes the uniforms. */
    update(params: Partial<StarsParams>): void;
    /** Records the stars into `target`, which needs `STORAGE_BINDING` usage and the pass' format. */
    encode(encoder: GPUCommandEncoder, target: GPUTexture, options?: EncodeOptions): void;
    destroy(): void;
}

const EIGHT_BIT = ["rgba8unorm", "bgra8unorm"];
const TONE_CURVES: Record<string, number> = { neutral: 1, agx: 2, aces: 3, clip: 4 };
/** Byte size of ShParams in params.wgsl: a mat4x4, a mat3x3 of three padded columns, six vec4-sized rows, the air's
 *  bends in 32 vec4s and its transmittances in 128. */
export const PARAMS_SIZE = (16 + 12 + 24 + 128 + 512) * 4;
const SPLAT_SIZE = 48;

const DEFAULTS: StarsParams = {
    skyRotation: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    years: 0,
    inverseViewProjection: new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    projectionDistance: 0,
    ev100: -6,
    horizonZ: -1,
    air: null,
    psfPixels: 0.8,
    scintillation: 0,
    time: 0,
    glare: 0,
    viewerFov: 30,
    starLight: 1,
    milkyWay: 1,
    magnitudeLimit: 99,
    heightM: 0,
    pupilCm: 0.7,
    threshold: 1 / 2048,
    maxRadius: 256,
};

/** The flags and sizes the pass sets per frame besides the parameters. */
interface Frame {
    width: number;
    height: number;
    tileSize: number;
    capacity: number;
    stars: boolean;
    milkyWay: number | null;
}

/** Packs `params` as ShParams, for a consumer's own pipeline as much as for the pass. */
export function paramsData(params: StarsParams, frame: Frame): ArrayBuffer {
    const data = new ArrayBuffer(PARAMS_SIZE);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);
    f.set(params.inverseViewProjection, 0);
    for (let col = 0; col < 3; col++) f.set(params.skyRotation.subarray(col * 3, col * 3 + 3), 16 + col * 4);
    f[28] = 1 / (1.2 * 2 ** params.ev100);
    f[29] = params.horizonZ;
    f[30] = params.years;
    f[31] = params.psfPixels;
    const { air } = params;
    f[32] = air ? (air.horizon * Math.PI) / 180 : -Math.PI / 2;
    f[33] = params.time;
    f[34] = params.scintillation;
    f[35] = params.glare;
    f[36] = params.starLight;
    f[37] = params.milkyWay;
    f[38] = params.magnitudeLimit;
    f[39] = params.projectionDistance;
    u[40] = (air ? 1 : 0) | (frame.milkyWay !== null ? 2 : 0) | (frame.stars ? 4 : 0);
    u[41] = frame.tileSize;
    u[42] = Math.ceil(frame.width / frame.tileSize);
    u[43] = frame.capacity;
    f[44] = params.threshold;
    f[45] = params.maxRadius;
    f[46] = params.heightM;
    f[47] = params.pupilCm;
    u[48] = frame.width;
    u[49] = frame.height;
    f[50] = frame.milkyWay ?? 0;
    f[51] = params.viewerFov / frame.height;
    if (air) {
        for (let i = 0; i < AIR_SAMPLES; i++) {
            f[52 + i] = ((air.bends[i] ?? 0) * Math.PI) / 180;
            f.set(air.transmittances.subarray(i * 3, i * 3 + 3), 180 + i * 4);
        }
    }
    return data;
}

export async function createStarsPass(device: GPUDevice, options: StarsPassOptions): Promise<StarsPass> {
    const {
        format,
        catalog = null,
        milkyWay = null,
        toneMap = "neutral",
        headroom = 1,
        background = true,
        nightVision = false,
        tileSize = 16,
        capacity = 64,
    } = options;
    const dither = options.dither ?? (toneMap !== false && EIGHT_BIT.includes(format));
    const storable = ["rgba8unorm", "rgba16float", "rgba32float"].includes(format);
    if (!storable && !(format === "bgra8unorm" && device.features.has("bgra8unorm-storage"))) {
        throw new Error(`sternenheer: the pass writes ${format} as a storage texture, which this device cannot`);
    }
    const shared = [wgsl.params, wgsl.camera, wgsl.glare, wgsl.stars];
    const binModule = device.createShaderModule({
        label: "sternenheer:bin",
        code: [wgsl.params, wgsl.camera, wgsl.glare, wgsl.bin, wgsl.stars].join("\n"),
    });
    const composeModule = device.createShaderModule({
        label: "sternenheer:compose",
        code: [
            wgsl.starsOutput(format),
            ...shared.slice(0, 3),
            wgsl.tonemap,
            wgsl.vision,
            wgsl.compose,
            wgsl.stars,
        ].join("\n"),
    });
    const [binPipeline, composePipeline] = await Promise.all([
        device.createComputePipelineAsync({
            label: "sternenheer:bin",
            layout: "auto",
            compute: { module: binModule, entryPoint: "shBin" },
        }),
        device.createComputePipelineAsync({
            label: "sternenheer:compose",
            layout: "auto",
            compute: {
                module: composeModule,
                entryPoint: "shCompose",
                constants: {
                    SH_TONE_MAP: toneMap === false ? 0 : (TONE_CURVES[toneMap] ?? 1),
                    SH_HEADROOM: headroom,
                    SH_DITHER: dither ? 1 : 0,
                    SH_BACKGROUND: background ? 1 : 0,
                    SH_NIGHT_VISION: nightVision ? 1 : 0,
                },
            },
        }),
    ]);
    const uniform = device.createBuffer({
        label: "sternenheer:params",
        size: PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // One star at least, so the buffers exist whatever the catalog.
    const count = Math.max(catalog?.count ?? 0, 1);
    const catalogBuffer = device.createBuffer({
        label: "sternenheer:catalog",
        size: count * STAR_FIELDS * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (catalog) device.queue.writeBuffer(catalogBuffer, 0, catalog.data);
    const splats = device.createBuffer({
        label: "sternenheer:splats",
        size: count * SPLAT_SIZE,
        usage: GPUBufferUsage.STORAGE,
    });
    // Bound where there is no map, or no background: the bindings stay in the layout whatever the flags say.
    const blank = device.createTexture({
        label: "sternenheer:blank",
        size: [1, 1],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const noBackground = device.createTexture({
        label: "sternenheer:noBackground",
        size: [1, 1],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const sampler = milkyWay?.sampler ?? device.createSampler({ magFilter: "linear", minFilter: "linear" });
    let tiles: { counts: GPUBuffer; entries: GPUBuffer; width: number; height: number } | null = null;
    const params: StarsParams = { ...DEFAULTS };

    function tilesFor(width: number, height: number) {
        if (tiles && tiles.width === width && tiles.height === height) return tiles;
        tiles?.counts.destroy();
        tiles?.entries.destroy();
        const n = Math.ceil(width / tileSize) * Math.ceil(height / tileSize);
        tiles = {
            width,
            height,
            counts: device.createBuffer({
                label: "sternenheer:tileCounts",
                size: n * 4,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            }),
            entries: device.createBuffer({
                label: "sternenheer:tileEntries",
                size: n * capacity * 4,
                usage: GPUBufferUsage.STORAGE,
            }),
        };
        return tiles;
    }

    return {
        update(patch) {
            Object.assign(params, patch);
        },
        encode(encoder, target, encodeOptions = {}) {
            const { width, height } = target;
            const t = tilesFor(width, height);
            device.queue.writeBuffer(
                uniform,
                0,
                paramsData(params, {
                    width,
                    height,
                    tileSize,
                    capacity,
                    stars: catalog !== null,
                    milkyWay: milkyWay?.luminance ?? null,
                }),
            );
            encoder.clearBuffer(t.counts);
            if (catalog) {
                const bind = device.createBindGroup({
                    layout: binPipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: uniform } },
                        { binding: 1, resource: { buffer: catalogBuffer } },
                        { binding: 2, resource: { buffer: splats } },
                        { binding: 3, resource: { buffer: t.counts } },
                        { binding: 4, resource: { buffer: t.entries } },
                    ],
                });
                const pass = encoder.beginComputePass({ label: "sternenheer:bin" });
                pass.setPipeline(binPipeline);
                pass.setBindGroup(0, bind);
                pass.dispatchWorkgroups(Math.ceil(catalog.count / 64));
                pass.end();
            }
            // The compose pass reads no catalog, so its layout, derived from the shader, has no binding for it.
            const bind = device.createBindGroup({
                layout: composePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: uniform } },
                    { binding: 2, resource: { buffer: splats } },
                    { binding: 3, resource: { buffer: t.counts } },
                    { binding: 4, resource: { buffer: t.entries } },
                    { binding: 5, resource: (milkyWay?.texture ?? blank).createView() },
                    { binding: 6, resource: sampler },
                    { binding: 7, resource: (encodeOptions.background ?? noBackground).createView() },
                ],
            });
            const output = device.createBindGroup({
                layout: composePipeline.getBindGroupLayout(1),
                entries: [{ binding: 0, resource: target.createView() }],
            });
            const pass = encoder.beginComputePass({
                label: "sternenheer:compose",
                ...(encodeOptions.timestampWrites ? { timestampWrites: encodeOptions.timestampWrites } : {}),
            });
            pass.setPipeline(composePipeline);
            pass.setBindGroup(0, bind);
            pass.setBindGroup(1, output);
            pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
            pass.end();
        },
        destroy() {
            uniform.destroy();
            catalogBuffer.destroy();
            splats.destroy();
            tiles?.counts.destroy();
            tiles?.entries.destroy();
            blank.destroy();
            noBackground.destroy();
        },
    };
}
