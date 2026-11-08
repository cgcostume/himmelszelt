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
import { planShadows, type ShadowWindow, shadowsHold } from "./shadows.js";
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
    /** Called when what the pass makes only once it is asked for is ready, the shimmer's pipelines: a frame to draw
     *  again. Until then it draws without the shimmer. */
    onReady?: () => void;
    /** Rays per pixel on and around the disc, 1 by default, through each pixel's center: the maps are filtered over the
     *  pixel and the limb covered by its distance. More resolve the relief's shading within a pixel. */
    samples?: number;
    /** Rays per pixel along the terminator, where the Sun stands low over the relief and a crater rim turns from lit
     *  to dark within a texel, and along a displaced limb: 4 by default, `samples` or less for none extra. */
    terminatorSamples?: number;
    /** From how many pixels across the disc the relief casts shadows, 128 by default: they are marched through the
     *  heights into a shadow map, once for the Sun where it stands and the part of the Moon the view shows, kept while
     *  neither moves on. Smaller discs, the Moon as a sky shows it, take none and need no map. Infinity for none. */
    shadowsFrom?: number;
    /** From how many pixels across the disc the relief is displaced where it shows, 1024 by default: each ray marched
     *  through the heights near the limb, so the limb shows its mountains and the terrain hides what lies behind it,
     *  rather than only shading a smooth sphere. Infinity for never. */
    displacementFrom?: number;
    /** From how many pixels across the disc the shadows are soft, 4096 by default: the share of the Sun's half degree
     *  above the terrain, so an edge is sharp near the rim that casts it and widens farther off. Below, the Sun is a
     *  point. A penumbra is the shadow's length times the Sun's 0.0093 radians: 0.85 km, a pixel of a 4096 pixel disc,
     *  for a shadow 90 km long, a 3 km rim with the Sun 2° up. Smaller discs see no difference. 0 for always. */
    softShadowsFrom?: number;
    /** The most texels the shadow map may hold, 4,194,304 by default, four bytes each: the texel coarsens past it. */
    shadowMapTexels?: number;
    /** The Moon and the sky behind it as the eye sees them at night rather than a camera, by helldunkel's
     *  `hdNightVision`, on the composed light before the exposure: the moonlit sky blue, the bright disc as it
     *  is. With a background only; off by default. */
    nightVision?: boolean;
    /** How the maps are filtered, to compare: "nearest" and "bilinear" read the full size alone, "trilinear" between
     *  its levels; "anisotropic", the default, up to sixteen taps along the footprint, and by a cubic B-spline where the
     *  maps are magnified. */
    filter?: MapFilter;
}

export type MapFilter = "nearest" | "bilinear" | "trilinear" | "anisotropic";

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

/** The air's shimmer, as `MoonParams.shimmer` takes it. */
export interface Shimmer {
    r0?: number;
    aperture?: number;
    wind?: number;
    time: number;
    dispersion: number;
    airColumn?: number;
    bend?: number;
    motion?: number;
    boiling?: number;
}

// The turbulence's wavelength, and its height above the ground, the most of it within a few kilometers.
const SHIMMER_WAVELENGTH_M = 550e-9;
const TURBULENCE_HEIGHT_M = 5000;

/**
 * What the shimmer makes of the air through `airColumn` zenith columns from sea level, in radians and radians a
 * second: `tilt`, the rms of the image's motion along each axis, as a differential image motion monitor measures it for
 * the aperture, Sarazin and Roddier's 0.18 λ² D^(-1/3) r0^(-5/3), r0 shrinking with the air as its -3/5th power, so the
 * motion grows as its square root; `cell`, the finest of the turbulence's cells on the sky, the aperture over the
 * distance to the turbulence, which grows with the column; `drift`, how fast the wind carries them across the sky.
 */
export function shimmerScales(
    { r0 = 0.1, aperture = 0.1, wind = 3 }: Pick<Shimmer, "r0" | "aperture" | "wind">,
    airColumn: number,
) {
    const column = Math.max(airColumn, 1e-6);
    const r = r0 * column ** -0.6;
    const tilt = Math.sqrt(0.18 * SHIMMER_WAVELENGTH_M ** 2 * aperture ** (-1 / 3) * r ** (-5 / 3));
    const distance = TURBULENCE_HEIGHT_M * Math.max(column, 1);
    return { tilt, cell: aperture / distance, drift: wind / distance };
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
    /** The air's shimmer, or null, none, by default: the image moved about by the turbulence, as a camera sees it in
     *  one short exposure, and its colors spread by the air's dispersion. `r0`, Fried's parameter at 550 nm through one
     *  zenith column of air from sea level, in meters, 0.1 by default, a fair night; `aperture` the lens' in meters, 0.1
     *  by default; `wind` the turbulence's in m/s, 3 by default. The air crossed is `airColumn` such columns, the
     *  airmass at sea level for `direction` without it: `shimmerScales` has what they make. The turbulence has drifted by
     *  `time` in seconds. The colors spread apart towards the zenith by `dispersion` of a hundredth of `bend`, the
     *  refraction in radians, Bennett's without it, 1 as the air does. `motion` and `boiling` weigh its two parts, 1 by
     *  default: the larger cells, which move patches of the image about as a whole, and the smaller, which make it boil
     *  within them. */
    shimmer: Shimmer | null;
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
// The Moon alone for the shimmer to move about: its light, linear, and its coverage.
const LAYER_FORMAT: GPUTextureFormat = "rgba16float";

// The shadow map up to this many texels across a texel of the relief where the view magnifies it: a shadow's edge falls
// between the relief's texels, where the march from each of the map's texels starts, and would show their stairs.
const SHADOW_SUBTEXELS = 4;

/** The shadow map's format: a share of the Sun's disc a texel, filtered when read. */
const SHADOW_FORMAT: GPUTextureFormat = "rgba8unorm";
const EIGHT_BIT = ["rgba8unorm", "bgra8unorm"];
const TONE_CURVES: Record<string, number> = { neutral: 1, agx: 2, aces: 3, clip: 4 };
/** Byte size of NbParams in params.wgsl: a mat4x4, a mat3x3 of three padded columns, twelve vec4-sized rows, the
 *  refraction table's eight, the albedo's tint and the table's transmittances, a vec4 each, the umbra's table, the
 *  detail strip, the shimmer and the shadow map's window. */
export const PARAMS_SIZE = 912 + UMBRA_SAMPLES * 16 + 32 + 48 + 16;
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

/** What the pass decides per frame from the view: the shadow map's window, if one is bound, and whether to displace. */
export interface MoonDetail {
    shadows: ShadowWindow | null;
    displace: boolean;
}

/** Packs `params` as NbParams, for a consumer's own pipeline as much as for the pass: without `detail`, no shadows and
 *  no displacement, which need the pass' shadow map and its view of the disc. */
export function paramsData(params: MoonParams, maps: MoonMaps | null, detail?: MoonDetail): ArrayBuffer {
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
        (relief && params.shadows && detail?.shadows ? 8 : 0) |
        (air ? 16 : 0) |
        (params.mapColor === "gray" ? 32 : 0) |
        (params.mapColor === "untinted" ? 64 : 0) |
        (params.compare ? 128 : 0) |
        (params.shimmer ? 256 : 0) |
        (relief && detail?.displace ? 512 : 0);
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
        const { tilt, cell, drift } = shimmerScales(shimmer, shimmer.airColumn ?? airmass);
        f.set(
            [tilt, shimmer.time, (shimmer.bend ?? bennett) * shimmer.dispersion, cell],
            UMBRA_OFFSET + UMBRA_SAMPLES * 4 + 4,
        );
        f.set([shimmer.motion ?? 1, shimmer.boiling ?? 1, drift], UMBRA_OFFSET + UMBRA_SAMPLES * 4 + 20);
    }
    const window = detail?.shadows;
    if (window) {
        const at = UMBRA_OFFSET + UMBRA_SAMPLES * 4 + 8;
        f.set(
            [
                ...window.sun,
                window.texel,
                ...window.east,
                window.longitude,
                window.theta,
                window.width,
                window.height,
                (window.sunDiameter / 2) * DEG,
            ],
            at,
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
        samples = 1,
        terminatorSamples = 4,
        nightVision = false,
        filter = "anisotropic",
        shadowsFrom = 128,
        displacementFrom = 1024,
        softShadowsFrom = 4096,
        shadowMapTexels = 4_194_304,
    } = options;
    if (!(Number.isInteger(samples) && samples >= 1)) throw new Error(`nachtgestirn: ${samples} rays per pixel`);
    if (!Number.isInteger(terminatorSamples)) throw new Error(`nachtgestirn: ${terminatorSamples} rays per pixel`);
    const dither = options.dither ?? (toneMap !== false && EIGHT_BIT.includes(format));
    const storable = ["rgba8unorm", "rgba16float", "rgba32float"].includes(format);
    if (!storable && !(format === "bgra8unorm" && device.features.has("bgra8unorm-storage"))) {
        throw new Error(`nachtgestirn: the pass writes ${format} as a storage texture, which this device cannot`);
    }
    const shared = [wgsl.params, wgsl.camera, wgsl.surface, wgsl.tonemap, wgsl.vision, wgsl.moon];
    const constants = {
        NB_TONE_MAP: toneMap === false ? 0 : (TONE_CURVES[toneMap] ?? 1),
        NB_HEADROOM: headroom,
        NB_DITHER: dither ? 1 : 0,
        NB_BACKGROUND: background ? 1 : 0,
        NB_SAMPLES: samples,
        NB_TERMINATOR_SAMPLES: Math.max(terminatorSamples, samples),
        NB_NIGHT_VISION: nightVision ? 1 : 0,
        NB_MAP_BSPLINE: filter === "anisotropic" ? 1 : 0,
    };
    // One layout for the inputs, which the Moon pass and the shadow map's share, and one for each one's output.
    const texture = (binding: number, sampleType: GPUTextureSampleType = "float"): GPUBindGroupLayoutEntry => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType },
    });
    const inputs = device.createBindGroupLayout({
        label: "nachtgestirn:inputs",
        entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            texture(1),
            texture(2),
            { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
            texture(4, "unfilterable-float"),
            texture(5),
            texture(6),
            texture(7),
            texture(8),
        ],
    });
    const outputOf = (target: GPUTextureFormat) =>
        device.createBindGroupLayout({
            label: `nachtgestirn:output ${target}`,
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: { access: "write-only", format: target, viewDimension: "2d" },
                },
            ],
        });
    const pipelineOf = (
        target: GPUTextureFormat,
        code: string,
        entryPoint: string,
        label: string,
        overrides: Record<string, number> = {},
    ) => {
        const output = outputOf(target);
        return device
            .createComputePipelineAsync({
                label,
                layout: device.createPipelineLayout({ label, bindGroupLayouts: [inputs, output] }),
                compute: {
                    module: device.createShaderModule({ label, code: [wgsl.moonOutput(target), code].join("\n") }),
                    entryPoint,
                    constants: { ...constants, ...overrides },
                },
            })
            .then((pipeline) => ({ pipeline, output }));
    };
    const relief = maps?.relief ?? null;
    const [compose, shadowPass] = await Promise.all([
        pipelineOf(format, shared.join("\n"), "nbCompose", "nachtgestirn:moon"),
        relief && Number.isFinite(shadowsFrom)
            ? pipelineOf(SHADOW_FORMAT, [...shared, wgsl.shadow].join("\n"), "nbShadows", "nachtgestirn:shadows")
            : null,
    ]);
    const uniform = device.createBuffer({
        label: "nachtgestirn:params",
        size: PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Bound where there is no map, no background or no shadow map: the bindings stay in the layout whatever the flags.
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
        maps && filter === "anisotropic"
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
    // The relief's finest texel, as an angle: the whole map's, or the strip's where there is one.
    const finest = Math.min(
        relief ? (2 * Math.PI) / relief.width : Number.POSITIVE_INFINITY,
        maps?.detail
            ? ((maps.detail.region[2] - maps.detail.region[0]) * 2 * Math.PI) / maps.detail.relief.width
            : Infinity,
    );
    // The shimmer's two pipelines, made the first time it is asked for: the Moon alone into a layer, linear, and the pass
    // that moves the layer about and finishes the pixels. Until they are made, the Moon is drawn without it.
    let shimmerPasses: {
        layer: Awaited<ReturnType<typeof pipelineOf>>;
        post: Awaited<ReturnType<typeof pipelineOf>>;
    } | null = null;
    let shimmerAsked = false;
    const askShimmer = () => {
        if (shimmerAsked) return;
        shimmerAsked = true;
        Promise.all([
            pipelineOf(LAYER_FORMAT, shared.join("\n"), "nbCompose", "nachtgestirn:moonLayer", { NB_LAYER: 1 }),
            pipelineOf(format, [...shared, wgsl.shimmer].join("\n"), "nbShimmer", "nachtgestirn:shimmer"),
        ]).then(([layer, post]) => {
            shimmerPasses = { layer, post };
            options.onReady?.();
        });
    };
    let layer: GPUTexture | null = null;
    const params: MoonParams = { ...DEFAULTS };
    let detail: MoonDetail = { shadows: null, displace: false };
    // The shadow map and the window it was made for.
    let shadowMap: GPUTexture | null = null;
    let made: ShadowWindow | null = null;
    device.queue.writeBuffer(uniform, 0, paramsData(params, maps, detail));

    return {
        update(patch) {
            Object.assign(params, patch);
            device.queue.writeBuffer(uniform, 0, paramsData(params, maps, detail));
        },
        encode(encoder, target, encodeOptions = {}) {
            // What the view asks of the relief: shadows from a size on, from a map kept while it serves, and displacement.
            const wanted = relief && params.relief;
            const plan = wanted
                ? planShadows(
                      params,
                      target.width,
                      target.height,
                      shadowsFrom,
                      finest / SHADOW_SUBTEXELS,
                      shadowMapTexels,
                      softShadowsFrom,
                  )
                : null;
            const window = shadowPass && params.shadows ? (plan?.window ?? null) : null;
            const remake = window !== null && !shadowsHold(made, window);
            if (remake) {
                made = window;
                if (!shadowMap || shadowMap.width < window.width || shadowMap.height < window.height) {
                    shadowMap?.destroy();
                    shadowMap = device.createTexture({
                        label: "nachtgestirn:shadowMap",
                        // Rounded up, so a window that grows a little does not make it anew.
                        size: [Math.ceil(window.width / 256) * 256, Math.ceil(window.height / 64) * 64],
                        format: SHADOW_FORMAT,
                        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
                    });
                }
            }
            detail = {
                shadows: window ? made : null,
                displace: Boolean(wanted && plan && plan.discPixels >= displacementFrom),
            };
            device.queue.writeBuffer(uniform, 0, paramsData(params, maps, detail));
            // The shadow map's own pass writes it, so binds the blank in its place; the layer only the shimmer's reads.
            const groupWith = (shadows: GPUTexture, moonLayer: GPUTexture = blank) =>
                device.createBindGroup({
                    layout: inputs,
                    entries: [
                        { binding: 0, resource: { buffer: uniform } },
                        { binding: 1, resource: (maps?.color ?? blank).createView() },
                        { binding: 2, resource: (relief ?? blank).createView() },
                        { binding: 3, resource: sampler },
                        { binding: 4, resource: (encodeOptions.background ?? noBackground).createView() },
                        { binding: 5, resource: (maps?.detail?.color ?? blank).createView() },
                        { binding: 6, resource: (maps?.detail?.relief ?? blank).createView() },
                        { binding: 7, resource: shadows.createView() },
                        { binding: 8, resource: moonLayer.createView() },
                    ],
                });
            if (remake && shadowPass && shadowMap && made) {
                const pass = encoder.beginComputePass({ label: "nachtgestirn:shadows" });
                pass.setPipeline(shadowPass.pipeline);
                pass.setBindGroup(0, groupWith(blank));
                pass.setBindGroup(
                    1,
                    device.createBindGroup({
                        layout: shadowPass.output,
                        entries: [{ binding: 0, resource: shadowMap.createView() }],
                    }),
                );
                pass.dispatchWorkgroups(Math.ceil(made.width / 8), Math.ceil(made.height / 8));
                pass.end();
            }
            const shadows = detail.shadows && shadowMap ? shadowMap : blank;
            if (params.shimmer) askShimmer();
            const shimmering = params.shimmer ? shimmerPasses : null;
            if (shimmering && (!layer || layer.width !== target.width || layer.height !== target.height)) {
                layer?.destroy();
                layer = device.createTexture({
                    label: "nachtgestirn:moonLayer",
                    size: [target.width, target.height],
                    format: LAYER_FORMAT,
                    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
                });
            }
            // The Moon into the target, or alone into the layer for the shimmer to move about and finish.
            const first = shimmering ? shimmering.layer : compose;
            const pass = encoder.beginComputePass({
                label: "nachtgestirn:moon",
                ...(encodeOptions.timestampWrites ? { timestampWrites: encodeOptions.timestampWrites } : {}),
            });
            pass.setPipeline(first.pipeline);
            pass.setBindGroup(0, groupWith(shadows));
            pass.setBindGroup(
                1,
                device.createBindGroup({
                    layout: first.output,
                    entries: [{ binding: 0, resource: (shimmering && layer ? layer : target).createView() }],
                }),
            );
            pass.dispatchWorkgroups(Math.ceil(target.width / 8), Math.ceil(target.height / 8));
            pass.end();
            if (shimmering && layer) {
                const post = encoder.beginComputePass({ label: "nachtgestirn:shimmer" });
                post.setPipeline(shimmering.post.pipeline);
                post.setBindGroup(0, groupWith(blank, layer));
                post.setBindGroup(
                    1,
                    device.createBindGroup({
                        layout: shimmering.post.output,
                        entries: [{ binding: 0, resource: target.createView() }],
                    }),
                );
                post.dispatchWorkgroups(Math.ceil(target.width / 8), Math.ceil(target.height / 8));
                post.end();
            }
        },
        destroy() {
            uniform.destroy();
            blank.destroy();
            noBackground.destroy();
            shadowMap?.destroy();
            layer?.destroy();
        },
    };
}
