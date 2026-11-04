import type { ToneCurve } from "@himmelszelt/helldunkel";
import type { MoonMaps } from "./maps.js";
import { EARTH_RADIUS_KM, MOON_RADIUS_KM, SUN_ILLUMINANCE, type Vec3 } from "./orientation.js";
import * as wgsl from "./wgsl/index.js";

export interface MoonPassOptions {
    /** Format of the target `encode` writes, with `STORAGE_BINDING` usage: rgba8unorm for a display, bgra8unorm with
     *  "bgra8unorm-storage", rgba16float or rgba32float for linear output or an HDR canvas. */
    format: GPUTextureFormat;
    /** Tone map for a display, as dunstkreis' sky pass: "neutral" by default, "agx", "aces", "clip"; `false` writes the
     *  exposed luminance, linear. */
    toneMap?: ToneCurve | false;
    /** How many times SDR white an HDR display shows, 1 by default. */
    headroom?: number;
    /** Dither the tone mapped output against banding, by default for an 8-bit target only. */
    dither?: boolean;
    /** Whether `encode` composes over a background in cd/m², true by default. Without, it writes the Moon alone,
     *  premultiplied, with its coverage of each pixel in alpha, for a renderer that composites itself. */
    background?: boolean;
    /** The Moon's maps, from `createMoonMaps`; without, a uniform disc of the geometric albedo. */
    maps?: MoonMaps | null;
}

/** Earth's shadow, for a lunar eclipse: as `eclipse.lunar` of `@himmelszelt/sternzeit` gives its radii. */
export interface EarthShadow {
    /** The shadow's axis, away from the Sun, unit, ENU: the Sun's direction negated. */
    axis: Vec3;
    /** The Moon's center from Earth's center, in km, in the ENU axes: the geocentric direction times the distance. The
     *  topocentric one is up to a degree off, more than the umbra is wide. */
    moonCenterKm: Vec3;
    /** The umbra's and the penumbra's radii at the Moon's distance, in km. */
    umbraKm: number;
    penumbraKm: number;
    /** How bright the umbra's refracted light is, 1 for a typical eclipse: more after a clear stratosphere, less after a
     *  volcano. Default 1. */
    umbraLight?: number;
}

/** Everything that can change per frame. Directions ENU (x east, y north, z up), unit length. */
export interface MoonParams {
    /** Towards the Moon's center as it shows, topocentric and, for a sky with refraction, refracted. */
    direction: Vec3;
    /** The Moon's apparent angular diameter, in degrees: `moon.topocentricAngularDiameter`. About 0.5. */
    angularDiameter: number;
    /** From the Moon's center towards the Sun: `moon.sunDirection`, the light direction for shading the disc. */
    sunDirection: Vec3;
    /** The Sun's illuminance at the Moon, in lux, 128,000 by default. */
    sunIlluminance: number;
    /** Earth's illuminance at the Moon, in lux, from `earthshineIlluminance`; 0 by default, no earthshine. */
    earthshine: number;
    /** The rotation from ENU into the Moon's own frame, from `moonOrientation`: which part of its face shows, and how
     *  it is turned. By default the Moon's 0° meridian faces the viewer with its north up. */
    orientation: Float32Array;
    /** What the air lets through along the line of sight, per channel, 1 by default: the Moon's light is dimmed and
     *  reddened by it, and the sky's light in the background is added in front of it. */
    transmittance: Vec3;
    /** Inverse view-projection, column major, and the projection's bend, as `@himmelszelt/dunstkreis`' sky pass. */
    inverseViewProjection: Float32Array;
    projectionDistance: number;
    /** Exposure in EV100: the Moon is a sunlit rock, a full Moon exposes around 15, like a sunny day. */
    ev100: number;
    /** The z below which a ray hits the ground and the Moon is hidden, `horizonZ`; -1 by default, drawn everywhere. */
    horizonZ: number;
    /** Draw the color map, true by default where there is one, and the relief from the normal map. */
    albedoMap: boolean;
    relief: boolean;
    /** The reflectance law: Hapke's lunar law after Jensen et al. 2001, or Lambert's, to see what it gets wrong. */
    law: "hapke" | "lambert";
    /** Earth's shadow on the Moon, null for none. */
    eclipse: EarthShadow | null;
    /** The Sun's angular diameter in degrees, for the penumbra's width. About 0.53. */
    sunAngularDiameter: number;
}

export interface EncodeOptions {
    /** The sky behind the Moon, in cd/m², the target's size: a float texture with `TEXTURE_BINDING` usage. */
    background?: GPUTexture;
    /** Timestamps around the pass, for timing it. */
    timestampWrites?: GPUComputePassTimestampWrites;
}

/** A Moon pass: a compute pass that writes the Moon's disc along every pixel's ray, over a background, into a target the
 *  caller owns. It creates no device, canvas or context of its own. */
export interface MoonPass {
    /** Takes the parameters over and writes the uniforms. */
    update(params: Partial<MoonParams>): void;
    /** Records the Moon into `target`, which needs `STORAGE_BINDING` usage and the pass' format. */
    encode(encoder: GPUCommandEncoder, target: GPUTexture, options?: EncodeOptions): void;
    destroy(): void;
}

const DEG = Math.PI / 180;
const EIGHT_BIT = ["rgba8unorm", "bgra8unorm"];
const TONE_CURVES: Record<string, number> = { neutral: 1, agx: 2, aces: 3, clip: 4 };
/** Byte size of NbParams in params.wgsl: a mat4x4, a mat3x3 of three padded columns, and eleven vec4-sized rows. */
export const PARAMS_SIZE = 240;

const DEFAULTS: MoonParams = {
    direction: [0, 0, 1],
    angularDiameter: 0.518,
    sunDirection: [1, 0, 0],
    sunIlluminance: SUN_ILLUMINANCE,
    earthshine: 0,
    orientation: new Float32Array([0, 0, -1, 1, 0, 0, 0, 1, 0]),
    transmittance: [1, 1, 1],
    // A camera looking north with a 90° field of view, until the caller sets its own.
    inverseViewProjection: new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    projectionDistance: 0,
    ev100: 15,
    horizonZ: -1,
    albedoMap: true,
    relief: true,
    law: "hapke",
    eclipse: null,
    sunAngularDiameter: 0.533,
};

/** Packs `params` as NbParams, for a consumer's own pipeline as much as for the pass. */
export function paramsData(params: MoonParams, maps: MoonMaps | null): ArrayBuffer {
    const data = new ArrayBuffer(PARAMS_SIZE);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);
    f.set(params.inverseViewProjection, 0);
    for (let col = 0; col < 3; col++) f.set(params.orientation.subarray(col * 3, col * 3 + 3), 16 + col * 4);
    f.set(params.direction, 28);
    f[31] = (params.angularDiameter / 2) * DEG;
    f.set(params.sunDirection, 32);
    f[35] = params.sunIlluminance;
    f.set(params.transmittance, 36);
    f[39] = params.earthshine;
    const { eclipse } = params;
    f.set(eclipse?.axis ?? [0, 0, -1], 40);
    f[43] = params.projectionDistance;
    f.set(eclipse?.moonCenterKm ?? [0, 0, 384_400], 44);
    f[47] = eclipse?.umbraKm ?? 0;
    f[48] = eclipse?.penumbraKm ?? 0;
    f[49] = (params.sunAngularDiameter / 2) * DEG;
    f[50] = EARTH_RADIUS_KM;
    f[51] = MOON_RADIUS_KM;
    f[52] = 1 / (1.2 * 2 ** params.ev100);
    f[53] = params.horizonZ;
    f[54] = maps?.albedoScale ?? 1;
    f[55] = 0.12;
    u[56] = (params.albedoMap && maps ? 1 : 0) | (params.relief && maps?.normals ? 2 : 0) | (eclipse ? 4 : 0);
    u[57] = params.law === "lambert" ? 1 : 0;
    f[58] = eclipse?.umbraLight ?? 1;
    return data;
}

export async function createMoonPass(device: GPUDevice, options: MoonPassOptions): Promise<MoonPass> {
    const { format, toneMap = "neutral", headroom = 1, background = true, maps = null } = options;
    const dither = options.dither ?? (toneMap !== false && EIGHT_BIT.includes(format));
    const storable = ["rgba8unorm", "rgba16float", "rgba32float"].includes(format);
    if (!storable && !(format === "bgra8unorm" && device.features.has("bgra8unorm-storage"))) {
        throw new Error(`nachtgestirn: the pass writes ${format} as a storage texture, which this device cannot`);
    }
    const code = [wgsl.moonOutput(format), wgsl.params, wgsl.camera, wgsl.surface, wgsl.tonemap, wgsl.moon].join("\n");
    const module = device.createShaderModule({ label: "nachtgestirn:moon", code });
    const pipeline = await device.createComputePipelineAsync({
        label: "nachtgestirn:moon",
        layout: "auto",
        compute: {
            module,
            entryPoint: "nbCompose",
            constants: {
                NB_TONE_MAP: toneMap === false ? 0 : (TONE_CURVES[toneMap] ?? 1),
                NB_HEADROOM: headroom,
                NB_DITHER: dither ? 1 : 0,
                NB_BACKGROUND: background ? 1 : 0,
            },
        },
    });
    const uniform = device.createBuffer({
        label: "nachtgestirn:params",
        size: PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Bound where there is no map, or no background: the bindings stay in the layout whatever the flags say.
    const blank = device.createTexture({
        label: "nachtgestirn:blank",
        size: [1, 1],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const noBackground = device.createTexture({
        label: "nachtgestirn:noBackground",
        size: [1, 1],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const sampler = maps?.sampler ?? device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const params: MoonParams = { ...DEFAULTS };
    device.queue.writeBuffer(uniform, 0, paramsData(params, maps));

    return {
        update(patch) {
            Object.assign(params, patch);
            device.queue.writeBuffer(uniform, 0, paramsData(params, maps));
        },
        encode(encoder, target, encodeOptions = {}) {
            const bindGroup = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: uniform } },
                    { binding: 1, resource: (maps?.color ?? blank).createView() },
                    { binding: 2, resource: (maps?.normals ?? blank).createView() },
                    { binding: 3, resource: sampler },
                    { binding: 4, resource: (encodeOptions.background ?? noBackground).createView() },
                ],
            });
            const output = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(1),
                entries: [{ binding: 0, resource: target.createView() }],
            });
            const pass = encoder.beginComputePass({
                label: "nachtgestirn:moon",
                ...(encodeOptions.timestampWrites ? { timestampWrites: encodeOptions.timestampWrites } : {}),
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.setBindGroup(1, output);
            pass.dispatchWorkgroups(Math.ceil(target.width / 8), Math.ceil(target.height / 8));
            pass.end();
        },
        destroy() {
            uniform.destroy();
            blank.destroy();
            noBackground.destroy();
        },
    };
}
