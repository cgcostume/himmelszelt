import type { ToneCurve } from "@himmelszelt/helldunkel";
import type { MoonMaps } from "./maps.js";
import {
    EARTH_RADIUS_KM,
    MOON_RADIUS_KM,
    REFRACTION_SAMPLES,
    type RefractionTable,
    SUN_ILLUMINANCE,
    type Vec3,
} from "./orientation.js";
import { typicalUmbra, UMBRA_SAMPLES } from "./umbra.js";
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
    /** Rays per pixel on and around the disc, 8 by default: the terminator and the relief's shading are sharper than
     *  a pixel. 1 for one through each pixel's center. */
    samples?: number;
    /** Rays per pixel along the terminator, where the Sun stands low over the relief and a crater rim turns from lit
     *  to dark within a texel: 32 by default, `samples` or less for none extra. */
    terminatorSamples?: number;
    /** The Moon and the sky behind it as the eye sees them at night rather than a camera, by helldunkel's
     *  `hdNightVision`, on the composed light before the exposure: the moonlit sky blue, the bright disc as it
     *  is. With a background only; off by default. */
    nightVision?: boolean;
    /** How the maps are filtered, to compare: "nearest" and "bilinear" read the full size alone, "trilinear" between
     *  its levels, "anisotropic" up to sixteen taps along the footprint; "bspline", the default, anisotropic and by a
     *  cubic B-spline where the maps are magnified. */
    filter?: MapFilter;
}

export type MapFilter = "nearest" | "bilinear" | "trilinear" | "anisotropic" | "bspline";

/** Earth's shadow, for a lunar eclipse: as `eclipse.lunar` of `@himmelszelt/sternzeit` gives its radii. */
export interface EarthShadow {
    /** The shadow's axis, away from the Sun, unit, ENU: the Sun's direction negated. */
    axis: Vec3;
    /** The Moon's center from Earth's center, in km, in the ENU axes: the geocentric direction times the distance. The
     *  topocentric one is up to a degree off, more than the umbra is wide. */
    moonCenterKm: Vec3;
    /** The umbra's and the penumbra's radii at the Moon's distance, in km. The pass does not read `penumbraKm`: it
     *  finds the penumbra from the geometry, the share of the Sun's disc Earth covers seen from each point. */
    umbraKm: number;
    penumbraKm: number;
    /** How bright the umbra's refracted light is, 1 for a typical eclipse: more after a clear stratosphere, less after a
     *  volcano. Default 1. */
    umbraLight?: number;
    /** The sunlight Earth's air bends into its shadow, per channel, from the axis to the penumbra's edge, from
     *  `refractedSunlight`; by default `typicalUmbra`, a hand-set copper with a turquoise rim. */
    refracted?: Float32Array;
}

/** Everything that can change per frame. Directions ENU (x east, y north, z up), unit length. */
export interface MoonParams {
    /** Towards the Moon's center, topocentric: the true direction with `refraction`, which bends the rays back to it,
     *  else where it shows. */
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
     *  reddened by it, and the sky's light in the background is added in front of it. A `refraction` table with
     *  `transmittances` takes its place, per ray. */
    transmittance: Vec3;
    /** Inverse view-projection, column major, and the projection's bend, as `@himmelszelt/dunstkreis`' sky pass. */
    inverseViewProjection: Float32Array;
    projectionDistance: number;
    /** Exposure in EV100: the Moon is a sunlit rock, a full Moon exposes around 14 like a sunny day, `moonEV100`. */
    ev100: number;
    /** The z below which a ray hits the ground and the Moon is hidden, `horizonZ`; -1 by default, drawn everywhere. */
    horizonZ: number;
    /** Draw the color map, true by default where there is one, the relief from the heights, and the shadows the relief
     *  casts, soft by the Sun's disc and harder towards what casts them. */
    albedoMap: boolean;
    relief: boolean;
    shadows: boolean;
    /** The reflectance law: Hapke's lunar law after Jensen et al. 2001, or Lambert's, Oren-Nayar's or a PBR renderer's
     *  metallic-roughness dielectric, to see what they get wrong: a limb darkened like a ball's, a half Moon that fades
     *  into its terminator, a sheen at the limb. */
    law: "hapke" | "lambert" | "orenNayar" | "metallicRoughness";
    /** How the color map is read: tinted to the Moon's own color, the default; as published, the map's own, nearly
     *  neutral color; or as gray, its luminance alone, the way most renderers use it. */
    mapColor: "tinted" | "untinted" | "gray";
    /** A law to hold the disc against, or null: where the two differ by more than a third of a stop the pixel is
     *  striped, red where `law` is brighter, blue where darker, as a camera stripes what clips, in four steps of
     *  opacity from a third of a stop, two thirds, one and two stops off. For figures. */
    compare: MoonParams["law"] | null;
    /** Earth's shadow on the Moon, null for none. */
    eclipse: EarthShadow | null;
    /** The Sun's angular diameter in degrees, for the penumbra's width. About 0.53. */
    sunAngularDiameter: number;
    /** How far the air bends the rays over the disc, `refractionTable`: each pixel's ray is turned down by it before it
     *  meets the Moon, which lifts and squeezes the disc near the horizon as the air does. Null by default, none. */
    refraction: RefractionTable | null;
    /** The Moon's distance from the observer, in km, `moon.topocentricDistance` or about it: where Earth's center lies
     *  from the Moon, which earthshine comes from. 384,400 by default. */
    distanceKm: number;
    /** From the Moon's center towards Earth's, unit, ENU, for a viewer who is not on Earth: earthshine lights the half
     *  of the Moon turned to it. Null by default, Earth taken from `direction` and `distanceKm`, the observer on it. */
    earthDirection: Vec3 | null;
    /** The air's shimmer, or null, none, by default. The image wanders by `seeing`, the rms of its tilt in arcseconds
     *  through one zenith's column of air from sea level, some 0.5 for a camera lens on a fair night, growing with the
     *  air crossed, `airColumn` such columns, as its square root; the turbulence has drifted by `time` in seconds; and
     *  the colors spread apart towards the zenith by `dispersion` of a hundredth of `bend`, the refraction in radians, 1
     *  as the air does. Without `airColumn` and `bend`, the airmass and refraction at sea level for `direction`. */
    shimmer: { seeing: number; time: number; dispersion: number; airColumn?: number; bend?: number } | null;
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
/** Byte size of NbParams in params.wgsl: a mat4x4, a mat3x3 of three padded columns, twelve vec4-sized rows, the
 *  refraction table's eight, the albedo's tint and the table's transmittances, a vec4 each, and the umbra's table. */
export const PARAMS_SIZE = 912 + UMBRA_SAMPLES * 16 + 32;
const UMBRA_OFFSET = 912 / 4;
const DEFAULT_UMBRA = typicalUmbra();
const LAW_INDEX: Record<MoonParams["law"], number> = { hapke: 0, lambert: 1, orenNayar: 2, metallicRoughness: 3 };

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
    ev100: 14,
    horizonZ: -1,
    albedoMap: true,
    relief: true,
    shadows: true,
    law: "hapke",
    mapColor: "tinted",
    compare: null,
    eclipse: null,
    sunAngularDiameter: 0.533,
    refraction: null,
    distanceKm: 384_400,
    earthDirection: null,
    shimmer: null,
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
    // The table's horizon, where the air's rays end on the ground, if it is higher than the one given.
    f[53] = Math.max(params.horizonZ, params.refraction ? Math.sin(params.refraction.horizon) : -1);
    f[54] = maps?.albedoScale ?? 1;
    f[55] = 0.12;
    const relief = params.relief && maps?.relief;
    const air = params.refraction?.transmittances;
    u[56] =
        (params.albedoMap && maps ? 1 : 0) |
        (relief ? 2 : 0) |
        (eclipse ? 4 : 0) |
        (relief && params.shadows ? 8 : 0) |
        (air ? 16 : 0) |
        (params.mapColor === "gray" ? 32 : 0) |
        (params.mapColor === "untinted" ? 64 : 0) |
        (params.compare ? 128 : 0) |
        (params.shimmer ? 256 : 0);
    u[57] = LAW_INDEX[params.law];
    u[99] = params.compare ? LAW_INDEX[params.compare] : 0;
    f[58] = eclipse?.umbraLight ?? 1;
    const { refraction } = params;
    f[59] = refraction?.step ?? 0;
    f[63] = refraction?.from ?? 0;
    if (refraction) f.set(refraction.bends.subarray(0, REFRACTION_SAMPLES), 64);
    f.set(maps?.albedoTint ?? [1, 1, 1], 96);
    if (air) for (let i = 0; i < REFRACTION_SAMPLES; i++) f.set(air.subarray(i * 3, i * 3 + 3), 100 + i * 4);
    f.set((eclipse?.refracted ?? DEFAULT_UMBRA).subarray(0, UMBRA_SAMPLES * 4), UMBRA_OFFSET);
    f.set(maps?.detail?.region ?? [0, 0, 0, 0], UMBRA_OFFSET + UMBRA_SAMPLES * 4);
    const { shimmer } = params;
    if (shimmer) {
        // Kasten and Young's airmass, Bennett's refraction, at the Moon's apparent altitude, where not given.
        const h = (Math.asin(Math.max(-1, Math.min(1, params.direction[2]))) * 180) / Math.PI;
        const airmass =
            1 / (Math.max(Math.sin((h * Math.PI) / 180), 0) + 0.50572 * Math.max(h + 6.07995, 0.1) ** -1.6364);
        const bennett =
            ((1 / Math.tan(((Math.max(h, -1) + 7.31 / (Math.max(h, -1) + 4.4)) * Math.PI) / 180)) * Math.PI) / 10_800;
        const column = shimmer.airColumn ?? airmass;
        f.set(
            [
                (shimmer.seeing / 206_265) * Math.sqrt(Math.max(column, 0)),
                shimmer.time,
                (shimmer.bend ?? bennett) * shimmer.dispersion,
                0,
            ],
            UMBRA_OFFSET + UMBRA_SAMPLES * 4 + 4,
        );
    }
    // Earth's center from the Moon's, the observer on Earth's surface straight above it, unless given.
    const [dx, dy, dz] = params.direction;
    const d = params.distanceKm;
    const earth = params.earthDirection ?? [-dx * d, -dy * d, -dz * d - EARTH_RADIUS_KM];
    const length = Math.hypot(earth[0] ?? 0, earth[1] ?? 0, earth[2] ?? 0);
    f.set(
        earth.map((c) => c / length),
        60,
    );
    return data;
}

export async function createMoonPass(device: GPUDevice, options: MoonPassOptions): Promise<MoonPass> {
    const {
        format,
        toneMap = "neutral",
        headroom = 1,
        background = true,
        maps = null,
        samples = 8,
        terminatorSamples = 32,
        nightVision = false,
        filter = "bspline",
    } = options;
    if (!(Number.isInteger(samples) && samples >= 1)) throw new Error(`nachtgestirn: ${samples} rays per pixel`);
    if (!Number.isInteger(terminatorSamples)) throw new Error(`nachtgestirn: ${terminatorSamples} rays per pixel`);
    const dither = options.dither ?? (toneMap !== false && EIGHT_BIT.includes(format));
    const storable = ["rgba8unorm", "rgba16float", "rgba32float"].includes(format);
    if (!storable && !(format === "bgra8unorm" && device.features.has("bgra8unorm-storage"))) {
        throw new Error(`nachtgestirn: the pass writes ${format} as a storage texture, which this device cannot`);
    }
    const code = [
        wgsl.moonOutput(format),
        wgsl.params,
        wgsl.camera,
        wgsl.surface,
        wgsl.tonemap,
        wgsl.vision,
        wgsl.moon,
    ].join("\n");
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
                NB_SAMPLES: samples,
                NB_TERMINATOR_SAMPLES: Math.max(terminatorSamples, samples),
                NB_NIGHT_VISION: nightVision ? 1 : 0,
                NB_MAP_BSPLINE: filter === "bspline" ? 1 : 0,
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
    const linear = filter !== "nearest";
    const sampler =
        maps && (filter === "bspline" || filter === "anisotropic")
            ? maps.sampler
            : device.createSampler({
                  label: `nachtgestirn:maps ${filter}`,
                  addressModeU: "repeat",
                  addressModeV: "clamp-to-edge",
                  magFilter: linear ? "linear" : "nearest",
                  minFilter: linear ? "linear" : "nearest",
                  mipmapFilter: filter === "trilinear" ? "linear" : "nearest",
                  // The full size alone, for the filters without levels.
                  ...(filter === "trilinear" ? {} : { lodMaxClamp: 0 }),
              });
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
                    { binding: 2, resource: (maps?.relief ?? blank).createView() },
                    { binding: 3, resource: sampler },
                    { binding: 4, resource: (encodeOptions.background ?? noBackground).createView() },
                    { binding: 5, resource: (maps?.detail?.color ?? blank).createView() },
                    { binding: 6, resource: (maps?.detail?.relief ?? blank).createView() },
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
