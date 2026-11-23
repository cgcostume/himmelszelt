import { blueNoiseTexture, exposureFromEV100, NO_WHITE_BALANCE, type ToneCurve } from "@himmelszelt/helldunkel";
import { solarEclipse } from "./eclipse.js";
import { autoExposureCompensation, autoExposureTint } from "./exposure.js";
import { createLut, dispatch } from "./luts.js";
import { spectrumToRgb } from "./model.js";
import {
    type AerialPerspectiveOptions,
    type AerialPerspectivePass,
    type AerialPerspectiveVolume,
    type AtmosphereLUTs,
    clampObserverHeight,
    MIN_OBSERVER_HEIGHT_M,
    type SkyCubeOptions,
    type SkyCubePass,
    type SkyParams,
    type SkyPass,
} from "./pass.js";
import {
    type Aureole,
    aureoleConstants,
    type Features,
    featureConstants,
    LENS_VEIL,
    pipelineConstants,
    refractionConstants,
    scatteringConstants,
} from "./quality.js";
import { apparentDirection } from "./refraction.js";
import * as wgsl from "./wgsl/index.js";

export interface SkyPassOptions {
    luts: AtmosphereLUTs;
    /**
     * Format of the target the pass writes into, which needs `STORAGE_BINDING` usage: rgba8unorm for a display (a
     * canvas configured with it), bgra8unorm with the "bgra8unorm-storage" feature, rgba16float or rgba32float for
     * linear output with `toneMap` off, or for an HDR canvas with `headroom`.
     */
    format: GPUTextureFormat;
    /**
     * Tone map for a display: exposed, compressed into [0, 1] and sRGB encoded, for an 8-bit target, by "neutral", the
     * default, "agx", "aces" or "clip", none, to compare (`ToneCurve`). `false` writes the exposed luminance itself, linear and unclamped, for a float
     * target and a renderer that tone maps the whole frame, with `wgsl.tonemap` if it likes.
     */
    toneMap?: ToneCurve | false;
    /**
     * The display's headroom, how many times SDR white it shows at most: above 1, "neutral" and "clip" compress or cut
     * off there instead, extended sRGB, for an rgba16float canvas configured with `toneMapping: { mode: "extended" }`
     * on an HDR display. "agx" and "aces" stay within 1. Default 1, SDR.
     */
    headroom?: number;
    /**
     * Dither the tone mapped output against banding by a step of helldunkel's blue noise, false by default: for an
     * 8-bit target over smooth gradients.
     */
    dither?: boolean;
    /** The blue noise to dither by, helldunkel's `blueNoiseTexture(device)` by default: one for a frame's passes. */
    blueNoise?: GPUTexture;
    /**
     * Expose by a light meter instead of `ev100`: the geometric mean luminance of the sky above the horizon, measured
     * on the GPU whenever the sky-view table is rebuilt, and read by the sky pass without a round trip to the CPU. For a
     * renderer without its own exposure, or to follow day into night.
     */
    autoExposure?: boolean;
    /** Draw the debug overlay: altitude lines every 10 degrees, the compass directions and a sun symbol where the Sun truly
     *  is, unbent by the air. */
    debugGrid?: boolean;
    /** Draw the sun disc. Default true. */
    sunDisc?: boolean;
    /**
     * The aureole, the white glow of a few degrees around the sun: a share of the aerosols' scattering in a narrow forward
     * lobe, which the sky-view table leaves out and the sky pass adds per pixel, exactly, to the image as to a cube map.
     * `DEFAULT_AUREOLE` by default, 5 % of it at g 0.98; `false` for Bruneton's one lobe alone.
     */
    aureole?: Aureole | false;
    /**
     * The veil around the sun, the glow an eye or a lens lays around anything that bright, by CIE's glare equation from
     * the sun's illuminance at the observer, which the light meter writes with every sky-view table, and with
     * `moonlight` around the Moon from its own. Its strength: 1 for the eye's own, which washes out some 10° around the
     * Sun by day; `LENS_VEIL`, a two-hundredth, for a camera's lens, the default, without which the disc stands as a
     * bare white circle above the haze; 0 for none. Only of what is looked at: it fades as the sun leaves the frame and
     * is gone 40 % of the image's half extent beyond its edge. It knows nothing of what hides the sun but the planet and
     * the Moon: a renderer with clouds or terrain in front turns it off and adds `hdVeil` with the light that gets through.
     */
    veil?: number;
    /**
     * Whether the Moon has the veil too, with `moonlight`; true by default. It is exposed as the sky is: a renderer that
     * draws the Moon's disc darker than that, as an eye adapted to it sees it, turns it off, or it glows inside the disc.
     */
    moonVeil?: boolean;
    /**
     * The Sun's corona and chromosphere around its disc, with `sunDisc`: Baumbach's corona, five millionths of the
     * disc's luminance at the limb, and the thin pink shell under it, behind the air, the ground and the Moon as the
     * disc is. Lost in the sky by day and, above the air, in a lens's veil, some forty times brighter at the limb, as
     * in any camera: it shows from above the air without the veil, close in or at a long exposure. In the image only,
     * not in a cube map. On by default.
     */
    solarCorona?: boolean;
    /**
     * The disc darker and redder towards its limb, by Hestroffer and Magnan's power law, its light the same. Seen once
     * the exposure is short enough for the disc not to burn out, some EV100 32. On by default.
     */
    limbDarkening?: boolean;
    /**
     * The sky as the eye sees it at night rather than a camera, by helldunkel's `hdDarkAdaptedEye`: below some 4 cd/m² the
     * rods take over from the cones, colors fade and shift towards blue, and by moonlight the sky turns from a camera's
     * violet gray to the blue painters give the night. Per pixel, before the exposure. A renderer that composes the sky
     * with more makes it on the composed light instead. Off by default, as a camera sees it.
     */
    darkAdapted?: boolean;
    /**
     * With `toneMap` off, write how much of each pixel the sun disc covers into alpha, 0 off the disc, rather than 1: a
     * caller that tone maps can curve the sky and the disc apart and mix them after, so the disc's edge stays smooth.
     * The disc's own light is the difference to a pass without it, divided by the share. Off by default.
     */
    discAlpha?: boolean;
    /**
     * Supersample the pixels the sun disc's edge or the horizon crosses, 16 rays each, every one bent by the air on its
     * own: the disc squeezed near the horizon and the planet's rim seen from space stay smooth. On by default, at the
     * cost of those few pixels; off, they are antialiased by the pixel's footprint alone.
     */
    supersample?: boolean;
    /**
     * Light the ground below the horizon by the sky as well as the sun, true by default: the sky's irradiance on it,
     * integrated over the table texel by texel, exactly. Off, it is lit by the sun alone, a sky-view dispatch cheaper.
     */
    groundLight?: boolean;
    /**
     * Which orders of scattering the sky adds up: `single`, the light scattered once, straight from the sun, which
     * carries the glow around it and the blue overhead; `multiple`, the light scattered more than once, which lights
     * the shadow side of the sky and twilight. Both by default; one alone, to see what it does.
     */
    scattering?: { single?: boolean; multiple?: boolean };
    /**
     * Build Hillaire's aerial perspective volume as well, for the air in front of the caller's geometry, terrain as
     * clouds: `true` for 32x32 froxels in 32 slices out to 32 km, or its shape. In linear sRGB, read by
     * `dkAerialPerspective` from `wgsl.aerial` or laid over a rendered scene by `createAerialPerspectivePass`. Off by
     * default.
     */
    aerialPerspective?: boolean | AerialPerspectiveOptions;
    /**
     * The Moon as a second light of the sky: a sky-view table of its own, built from `moonDirection` by the same march,
     * read beside the Sun's, and an aureole around it. The sky by moonlight, blue like the day at a few millionths of
     * its light, and the glow around the Moon in haze, and its light in the aerial perspective volume. The meter and
     * the ground's light from the sky stay the Sun's. Off by default.
     */
    moonlight?: boolean;
}

/**
 * Byte size of DkSkyParams in frame.wgsl: a vec3 and a scalar, a mat4x4, four scalars, a vec2 and two scalars, a vec3
 * and a scalar twice, a vec3 and a scalar, three scalars padded to 16, a mat3x3 of three columns padded to 16, and a
 * vec3 and two scalars padded to 16.
 */
const SKY_PARAMS_SIZE = 256;
/** `x` as a half float holds it, to the nearest: the aerial perspective volume keeps its reach in one. */
const halfFloat = (x: number) => {
    const step = 2 ** (Math.floor(Math.log2(x)) - 10);
    return Math.round(x / step) * step;
};

/**
 * How much of the veil of a source towards `direction` shows in the frame of an inverse
 * view-projection matrix `m` with the projection's `d`, as `dkProjectRay` draws it: all of it while the source is in
 * the image, fading to none 40 % of the image's half extent beyond its edge, and none behind the camera.
 */
function inFrame(m: ArrayLike<number>, d: number, direction: readonly number[]): number {
    const column = (i: number) => [0, 1, 2, 3].map((k) => m[4 * i + k] ?? 0) as [number, number, number, number];
    const [across, upward, eye, last] = [column(0), column(1), column(2), column(3)];
    const w = 0.5 * eye[3] + last[3];
    const axis = [0, 1, 2].map((k) => (0.5 * (eye[k] ?? 0) + (last[k] ?? 0)) / w - (eye[k] ?? 0) / eye[3]);
    const dot = (a: readonly number[], b: readonly number[]) =>
        (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
    const length = (a: readonly number[]) => Math.sqrt(dot(a, a));
    // The image plane at distance 1 from the eye: its half extents, and the source's place in it.
    const reach = length(axis) * Math.abs(w);
    const cosTheta = dot(direction, axis) / length(axis);
    if (!(d + cosTheta > 1e-3) || (d <= 0 && cosTheta <= 0)) return 0;
    const [x, y] = [dot(direction, across) / length(across), dot(direction, upward) / length(upward)];
    const radius = (d + 1) / (d + cosTheta);
    const beyond = Math.max(
        Math.abs(x * radius) / (length(across) / reach),
        Math.abs(y * radius) / (length(upward) / reach),
    );
    const t = Math.min(Math.max((beyond - 1) / 0.4, 0), 1);
    return 1 - t * t * (3 - 2 * t);
}

/** The light meter's directions per cap, `DK_METER_SAMPLES` in frame.wgsl, one per invocation of 128 per workgroup. */
const METER_SAMPLES = 4096;
const METER_WORKGROUPS = METER_SAMPLES / 128;
/** Byte size of DkMetering before its bend per sky-view row: a scalar, two vec3s and two vec4s, each aligned to 16,
 *  then the meter's samples, a vec2f each. */
const METERING_SIZE = 80 + METER_SAMPLES * 8;

const DEFAULTS: SkyParams = {
    sunDirection: [0, 0, 1],
    observerHeightM: MIN_OBSERVER_HEIGHT_M,
    // A camera looking north with a 90° field of view, until the caller sets its own: all zeros would make every ray NaN.
    inverseViewProjection: new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    ev100: 14,
    autoExposureRange: [4, 20],
    autoExposureKeys: [],
    exposureCompensation: 0,
    pixelRatio: 1,
    sunAngularDiameter: 0.533,
    projectionDistance: 0,
    moonDirection: [0, 0, -1],
    moonIlluminance: 0,
    moonAngularDiameter: 0,
    gridInk: 1,
    sunDiscCeiling: null,
    whiteBalance: NO_WHITE_BALANCE,
};

/**
 * log2 of the sky-view table's brightest value by the sun's altitude above the observer's horizon, in degrees, for a
 * sun of 128,000 lux: measured from the ground to the top of the atmosphere, within 1.5 stops at any height and for
 * osgHimmel's air as well. From noon to the sun 30° down it falls by 37 stops, more than half floats hold.
 */
const BRIGHTEST: readonly (readonly [number, number])[] = [
    [-30, -22],
    [-24, -15.5],
    [-21, -12.5],
    [-18, -7.5],
    [-15, -3],
    [-12, 1],
    [-9, 4.5],
    [-6, 7.5],
    [-4, 9.3],
    [-2, 11],
    [0, 13.5],
    [3, 15.5],
    [10, 15.5],
    [30, 15],
];

/**
 * What the sky-view table stores luminance multiplied by: the power of two that puts its brightest value near 2^10,
 * 16 stops below what half floats hold and 24 above their smallest normal value. It follows the sun, as the table does.
 */
function skyViewScale(solarIlluminance: number, sunAltitude: number): number {
    // The segment the altitude lies in, the first or the last beyond them.
    const after = BRIGHTEST.findIndex(([a]) => a > sunAltitude);
    const i = Math.min(Math.max((after < 0 ? BRIGHTEST.length : after) - 1, 0), BRIGHTEST.length - 2);
    const [[a0, l0], [a1, l1]] = [BRIGHTEST[i], BRIGHTEST[i + 1]] as [
        readonly [number, number],
        readonly [number, number],
    ];
    const t = Math.min(Math.max((sunAltitude - a0) / (a1 - a0), 0), 1);
    const brightest = l0 + (l1 - l0) * t + Math.log2(solarIlluminance / 128_000);
    return 2 ** Math.round(10 - brightest);
}

/**
 * A sky pass. Owns the per-frame sky-view table and the compute pipelines, and nothing else: no device, no canvas, no
 * context of its own. Resolves once its pipelines are compiled, which happens without blocking.
 *
 * `update()` rebuilds the sky-view table only when the sun or the observer moved; a camera move just rewrites the
 * uniforms. `encode()` then costs one texture fetch per pixel.
 */
export async function createSkyPass(device: GPUDevice, options: SkyPassOptions): Promise<SkyPass> {
    const { luts, format } = options;
    const { config, model } = luts;
    const {
        toneMap = "neutral",
        autoExposure = false,
        debugGrid = false,
        sunDisc = true,
        aureole,
        veil = LENS_VEIL,
        moonVeil = true,
        solarCorona = true,
        limbDarkening = true,
        discAlpha = false,
        supersample = true,
        groundLight = true,
        headroom = 1,
        moonlight = false,
        darkAdapted = false,
    } = options;
    if (!(veil >= 0)) throw new Error(`dunstkreis: a veil of ${veil}; its strength is 0 or more`);
    if (aureole && !(aureole.share >= 0 && aureole.share <= 1 && aureole.g > 0 && aureole.g < 1)) {
        throw new Error(
            "dunstkreis: an aureole takes a share from 0 to 1 of the aerosols' scattering and a g within (0, 1)",
        );
    }
    const dither = options.dither ?? false;
    // Bound whatever `dither` says: the binding stays in the layout.
    const blueNoise = options.blueNoise ?? blueNoiseTexture(device);
    const storable = ["rgba8unorm", "rgba16float", "rgba32float"].includes(format);
    if (!storable && !(format === "bgra8unorm" && device.features.has("bgra8unorm-storage"))) {
        throw new Error(`dunstkreis: the sky pass writes ${format} as a storage texture, which this device cannot`);
    }
    if (headroom !== 1 && (!(headroom > 1) || toneMap === false || !["rgba16float", "rgba32float"].includes(format))) {
        throw new Error(`dunstkreis: a headroom of ${headroom} needs a tone curve, a float target and more than 1`);
    }
    const constants = (features: Partial<Features>, samples: { cube?: number } = {}) => ({
        ...pipelineConstants(config, samples),
        ...featureConstants(features),
        ...refractionConstants(model),
        ...scatteringConstants(options.scattering),
        ...aureoleConstants(aureole),
    });
    const prelude = [
        wgsl.quality,
        wgsl.features,
        wgsl.atmosphere,
        wgsl.common,
        wgsl.lut,
        wgsl.sampling,
        wgsl.raymarch,
        wgsl.frame,
    ];
    // Everything but the output, which differs between an image and a cube map.
    const skySource = (output: string) =>
        [
            ...prelude,
            wgsl.camera,
            wgsl.cube,
            wgsl.sun,
            wgsl.glare,
            wgsl.whitebalance,
            wgsl.tonemap,
            wgsl.vision,
            wgsl.grid,
            output,
            wgsl.sky,
        ].join("\n");
    // A cube map's format and settings.
    const checkEnvironment = (format: GPUTextureFormat, sunDisc: boolean, samples: number) => {
        if (format !== "rgba16float" && format !== "rgba32float") {
            throw new Error(`dunstkreis: the sky's cube map is rgba16float or rgba32float, not ${format}`);
        }
        if (sunDisc && format !== "rgba32float") {
            throw new Error("dunstkreis: the sun disc needs rgba32float, being far brighter than rgba16float holds");
        }
        if (!Number.isInteger(samples) || samples < 1) throw new Error("dunstkreis: at least 1 sample per texel");
    };

    const skyView = createLut(device, "dunstkreis:skyView", config.skyView.width, config.skyView.height);
    const moonView = moonlight
        ? createLut(device, "dunstkreis:moonView", config.skyView.width, config.skyView.height)
        : null;
    const aerial = options.aerialPerspective && {
        width: 32,
        height: 32,
        depth: 32,
        maxDistanceKm: 32,
        ...(options.aerialPerspective === true ? {} : options.aerialPerspective),
    };
    if (
        aerial &&
        !(
            [aerial.width, aerial.height, aerial.depth].every((n) => Number.isInteger(n) && n > 0) &&
            aerial.maxDistanceKm >= 2 ** -14 &&
            aerial.maxDistanceKm <= 65504
        )
    ) {
        throw new Error("dunstkreis: the aerial perspective volume takes whole froxels and a distance up to 65504 km");
    }
    // The volume holds its reach in a half float, so the pass that fills it marches to that very number.
    const aerialReach = aerial ? halfFloat(aerial.maxDistanceKm) : 0;
    // Luminance and transmittance in linear sRGB, in two textures: turned from the four wavelengths once, where the
    // volume is filled, so whoever reads it needs nothing of the model. See aerial.wgsl for what the alphas hold.
    const froxels = (label: string) =>
        aerial &&
        device.createTexture({
            label,
            dimension: "3d",
            size: [aerial.width, aerial.height, aerial.depth],
            format: "rgba16float",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        });
    const aerialVolume: AerialPerspectiveVolume | null = aerial
        ? {
              luminance: froxels("dunstkreis:aerialLuminance") as GPUTexture,
              transmittance: froxels("dunstkreis:aerialTransmittance") as GPUTexture,
              maxDistanceKm: aerialReach,
          }
        : null;
    // Everything that changes per frame, read by every pass here: the sky-view table, the meter and the sky pass.
    const skyParams = device.createBuffer({
        label: "dunstkreis:skyParams",
        size: SKY_PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // The light meter's reading, the sun's illuminance and the sky's light on the ground, written on the GPU and read
    // there.
    const metering = device.createBuffer({
        label: "dunstkreis:metering",
        size: METERING_SIZE + 4 * config.skyView.height,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // The sky-view table in one step, or with the ground lit by the sky in three: the sky, the sky's light on the
    // ground gathered from it, the ground. See skyview.comp.wgsl.
    const skyViewModule = device.createShaderModule({
        code: [wgsl.workgroupSum(64, device.features.has("subgroups")), ...prelude, wgsl.skyview].join("\n"),
    });
    const skyViewStep = (entryPoint: string, skyViewRows: 0 | 1 | 2, moonView = false) =>
        device.createComputePipelineAsync({
            label: `dunstkreis:${moonView ? "moonView" : entryPoint}`,
            layout: "auto",
            compute: { module: skyViewModule, entryPoint, constants: constants({ skyViewRows, moonView }) },
        });
    const meterModule = device.createShaderModule({
        code: [
            wgsl.workgroupSum(128, device.features.has("subgroups")),
            wgsl.atmosphere,
            wgsl.common,
            wgsl.lut,
            wgsl.sampling,
            wgsl.raymarch,
            wgsl.spiral,
            wgsl.frame,
            wgsl.exposure,
        ].join("\n"),
    });
    const meterStep = (entryPoint: string) =>
        device.createComputePipelineAsync({
            label: `dunstkreis:${entryPoint}`,
            layout: "auto",
            compute: { module: meterModule, entryPoint, constants: refractionConstants(model) },
        });
    const [
        skyViewPipeline,
        groundIrradiancePipeline,
        groundPipeline,
        samplePipeline,
        meterPipeline,
        skyPipeline,
        aerialPipeline,
        moonViewPipeline,
    ] = await Promise.all([
        skyViewStep("dkPrecomputeSkyView", groundLight ? 1 : 0),
        groundLight ? skyViewStep("dkGroundIrradiance", 0) : null,
        groundLight ? skyViewStep("dkPrecomputeSkyView", 2) : null,
        meterStep("dkMeterSample"),
        meterStep("dkMeterSky"),
        device.createComputePipelineAsync({
            label: "dunstkreis:sky",
            layout: "auto",
            compute: {
                module: device.createShaderModule({ code: skySource(wgsl.skyOutput(format)) }),
                entryPoint: "dkSky",
                constants: constants({
                    toneMap,
                    headroom,
                    dither,
                    autoExposure,
                    debugGrid,
                    sunDisc,
                    veil,
                    solarCorona,
                    limbDarkening,
                    discAlpha,
                    supersample,
                    moonlight,
                    darkAdapted,
                }),
            },
        }),
        aerial &&
            device.createComputePipelineAsync({
                label: "dunstkreis:aerialPerspective",
                layout: "auto",
                compute: {
                    module: device.createShaderModule({
                        code: [
                            wgsl.atmosphere,
                            wgsl.common,
                            wgsl.lut,
                            wgsl.sampling,
                            wgsl.raymarch,
                            wgsl.frame,
                            wgsl.aerial,
                            wgsl.aerialvolume,
                        ].join("\n"),
                    }),
                    entryPoint: "dkPrecomputeAerialPerspective",
                    constants: {
                        ...refractionConstants(model),
                        ...scatteringConstants(options.scattering),
                        ...aureoleConstants(aureole),
                        DK_AERIAL_PERSPECTIVE_DISTANCE: aerialReach,
                        DK_AERIAL_MOONLIGHT: Number(moonlight),
                    },
                },
            }),
        // The Moon's table in one dispatch: the ground below lit by the Moon alone, not by the moonlit sky.
        moonView ? skyViewStep("dkPrecomputeSkyView", 0, true) : null,
    ]);

    const skyViewEntries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: luts.atmosphereBuffer } },
        { binding: 1, resource: { buffer: skyParams } },
        { binding: 2, resource: luts.transmittance.createView() },
        { binding: 3, resource: luts.multiScattering.createView() },
        { binding: 4, resource: luts.sampler },
        { binding: 5, resource: skyView.createView() },
        { binding: 6, resource: { buffer: metering } },
    ];
    const bindGroup = (pipeline: GPUComputePipeline, entries: GPUBindGroupEntry[]) =>
        device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    const skyViewBindGroup = bindGroup(skyViewPipeline, skyViewEntries);
    const moonViewBindGroup =
        moonViewPipeline &&
        moonView &&
        bindGroup(
            moonViewPipeline,
            skyViewEntries.map((entry) =>
                entry.binding === 5 ? { binding: 5, resource: moonView.createView() } : entry,
            ),
        );
    const groundBindGroup = groundPipeline && bindGroup(groundPipeline, skyViewEntries);
    const groundIrradianceBindGroup =
        groundIrradiancePipeline &&
        bindGroup(groundIrradiancePipeline, [
            { binding: 0, resource: { buffer: luts.atmosphereBuffer } },
            { binding: 1, resource: { buffer: skyParams } },
            { binding: 6, resource: { buffer: metering } },
            { binding: 7, resource: skyView.createView() },
        ]);
    // The meter's sampling reads the table, its summing only the samples; "auto" layouts hold what each one reads.
    const sampleBindGroup = bindGroup(samplePipeline, [
        { binding: 0, resource: { buffer: luts.atmosphereBuffer } },
        { binding: 1, resource: { buffer: skyParams } },
        { binding: 2, resource: skyView.createView() },
        { binding: 3, resource: luts.sampler },
        { binding: 4, resource: { buffer: metering } },
        { binding: 5, resource: luts.transmittance.createView() },
        { binding: 6, resource: luts.multiScattering.createView() },
    ]);
    const meterBindGroup = bindGroup(meterPipeline, [
        { binding: 0, resource: { buffer: luts.atmosphereBuffer } },
        { binding: 1, resource: { buffer: skyParams } },
        { binding: 3, resource: luts.sampler },
        { binding: 4, resource: { buffer: metering } },
        { binding: 5, resource: luts.transmittance.createView() },
        { binding: 6, resource: luts.multiScattering.createView() },
    ]);
    // One bind group per pipeline: layouts derived by "auto" never match another pipeline's.
    const skyBindGroupFor = (pipeline: GPUComputePipeline) =>
        bindGroup(pipeline, [
            { binding: 0, resource: { buffer: luts.atmosphereBuffer } },
            { binding: 1, resource: { buffer: skyParams } },
            { binding: 2, resource: luts.transmittance.createView() },
            { binding: 3, resource: skyView.createView() },
            { binding: 4, resource: luts.sampler },
            { binding: 5, resource: luts.multiScattering.createView() },
            { binding: 6, resource: { buffer: metering } },
            { binding: 7, resource: (moonView ?? skyView).createView() },
            { binding: 8, resource: blueNoise.createView() },
        ]);
    const skyBindGroup = skyBindGroupFor(skyPipeline);
    const aerialBindGroup =
        aerialPipeline &&
        aerialVolume &&
        bindGroup(aerialPipeline, [
            { binding: 0, resource: { buffer: luts.atmosphereBuffer } },
            { binding: 1, resource: { buffer: skyParams } },
            { binding: 2, resource: luts.transmittance.createView() },
            { binding: 3, resource: luts.multiScattering.createView() },
            { binding: 4, resource: luts.sampler },
            { binding: 5, resource: aerialVolume.luminance.createView() },
            { binding: 6, resource: aerialVolume.transmittance.createView() },
        ]);

    const sweep = (pass: GPUComputePassEncoder, pipeline: GPUComputePipeline, group: GPUBindGroup, rows: number) => {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(dispatch(config.skyView.width), dispatch(rows));
    };

    let params: SkyParams = { ...DEFAULTS };
    const outputs = new WeakMap<GPUTexture, GPUBindGroup>();
    let skyViewKey = "";
    let moonViewKey = "";
    let meteredMoonKey = "";
    let aerialKey = "";
    let compensation = 0;
    let scale = 1;
    // Where the sun shows, for the aureole and the veil, and the sun and height it was traced for.
    let apparent: { key: string; direction: readonly number[] } = { key: "", direction: [0, 0, 1] };
    let apparentMoon: { key: string; direction: readonly number[] } = { key: "", direction: [0, 0, -1] };

    async function readMetering(offset: number, floats: number): Promise<Float32Array> {
        const staging = device.createBuffer({
            size: floats * 4,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        const encoder = device.createCommandEncoder({ label: "dunstkreis:meterReadback" });
        encoder.copyBufferToBuffer(metering, offset, staging, 0, floats * 4);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(staging.getMappedRange().slice(0));
        staging.destroy();
        return values;
    }

    return {
        skyViewTexture: skyView,

        get skyViewScale() {
            return scale;
        },

        aerialPerspective: aerialVolume,

        lightBuffer: metering,

        update(next, frameEncoder) {
            params = { ...params, ...next };
            const [sx, sy, sz] = params.sunDirection;
            const height = clampObserverHeight(params.observerHeightM);

            const sky = new Float32Array(SKY_PARAMS_SIZE / 4);
            sky.set([sx, sy, sz, height / 1000], 0);
            sky.set(params.inverseViewProjection, 4);
            sky[20] = exposureFromEV100(params.ev100);
            sky[21] = (params.sunAngularDiameter / 2) * (Math.PI / 180);
            sky[22] = params.projectionDistance;
            const { groundRadiusKm } = model.planet;
            const dip = (Math.acos(groundRadiusKm / (groundRadiusKm + height / 1000)) * 180) / Math.PI;
            compensation =
                params.exposureCompensation + autoExposureCompensation(params.autoExposureKeys, [sx, sy, sz], dip);
            sky[23] = compensation;
            sky.set(params.autoExposureRange, 24);
            // Of the sun and the observer alone, like the table: it changes only when the table is rebuilt.
            const sunAltitude = (Math.atan2(sz, Math.hypot(sx, sy)) * 180) / Math.PI + dip;
            scale = skyViewScale(model.solarIlluminance, sunAltitude);
            sky[26] = scale;
            sky[27] = params.pixelRatio;
            // Traced by bisection on the CPU, so once per sun and height.
            const sunKey = `${sx},${sy},${sz},${height}`;
            if (apparent.key !== sunKey)
                apparent = { key: sunKey, direction: apparentDirection([sx, sy, sz], model, height) };
            sky.set(apparent.direction, 28);
            // The Moon's light as a share of the Sun's, and its table's scale, from its altitude as the Sun's is.
            const [mx, my, mz] = params.moonDirection;
            const moonShare = moonView ? Math.max(params.moonIlluminance, 0) / model.solarIlluminance : 0;
            const moonAltitude = (Math.atan2(mz, Math.hypot(mx, my)) * 180) / Math.PI + dip;
            sky[31] = moonShare;
            sky.set([mx, my, mz], 32);
            sky[35] = moonShare > 0 ? skyViewScale(model.solarIlluminance * moonShare, moonAltitude) : 1;
            const moonKey = `${mx},${my},${mz},${height}`;
            if (moonShare > 0 && apparentMoon.key !== moonKey)
                apparentMoon = { key: moonKey, direction: apparentDirection([mx, my, mz], model, height) };
            sky.set(apparentMoon.direction, 36);
            sky[39] = params.gridInk;
            sky[40] = params.sunDiscCeiling ?? 0;
            sky[41] = params.moonAngularDiameter > 0 ? Math.cos((params.moonAngularDiameter * Math.PI) / 360) : 2;
            // The veil by how far the Sun is out of the frame, and by the Moon likewise.
            sky[42] = inFrame(params.inverseViewProjection, params.projectionDistance, apparent.direction);
            sky[43] =
                moonShare > 0 && veil > 0 && moonVeil
                    ? inFrame(params.inverseViewProjection, params.projectionDistance, apparentMoon.direction)
                    : 0;
            // The keys' tint after the white balance, its rows scaled: without one, the matrix as it is.
            const [r, g, b] = autoExposureTint(params.autoExposureKeys, [sx, sy, sz], dip);
            const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = params.whiteBalance;
            sky.set([m0 * r, m1 * g, m2 * b, 0, m3 * r, m4 * g, m5 * b, 0, m6 * r, m7 * g, m8 * b], 44);
            const eclipse = solarEclipse(
                [sx, sy, sz],
                [mx, my, mz],
                params.moonAngularDiameter,
                params.sunAngularDiameter,
            );
            sky.set(eclipse, 56);
            device.queue.writeBuffer(skyParams, 0, sky);

            // Rebuilding the sky-view table is the expensive part, and it is why the sky pass itself is one fetch
            // per pixel rather than a raymarch. It depends on nothing but the Sun and the observer. Above the
            // atmosphere nothing reads the table: the sky pass raymarches per pixel, and so does the meter.
            // And on the Moon, while it stands before the Sun for some of the air.
            const key = `${sx},${sy},${sz},${height}${(eclipse[4] ?? 0) > 0 ? `,${eclipse.join(",")}` : ""}`;
            const rebuildSkyView = key !== skyViewKey;
            const inSpace = height / 1000 > model.planet.thicknessKm;
            const moonTableKey = moonShare > 0 && !inSpace ? `${moonKey},${moonShare}` : "";
            const rebuildMoon = moonTableKey !== "" && moonTableKey !== moonViewKey;
            // The meter also writes the Moon's light at the observer, from space as well.
            const moonLightKey = moonShare > 0 ? `${moonKey},${moonShare}` : "";
            // The air in front of geometry follows the camera too, and the Moon where it lights the air.
            const cameraKey = `${key},${moonLightKey},${params.inverseViewProjection.join(",")}`;
            const rebuildAerial = Boolean(aerialPipeline) && cameraKey !== aerialKey;
            const remeter = rebuildSkyView || moonLightKey !== meteredMoonKey;
            if (!remeter && !rebuildAerial && !rebuildMoon) return;
            skyViewKey = key;
            aerialKey = cameraKey;
            moonViewKey = moonTableKey;
            meteredMoonKey = moonLightKey;
            const encoder = frameEncoder ?? device.createCommandEncoder({ label: "dunstkreis:skyView" });
            const pass = encoder.beginComputePass({ label: "dunstkreis:skyView" });
            const { height: rows } = config.skyView;
            if (rebuildMoon && moonViewPipeline && moonViewBindGroup) {
                sweep(pass, moonViewPipeline, moonViewBindGroup, rows);
            }
            if (!rebuildSkyView) {
                // The camera alone moved: the table stands.
            } else if (inSpace) {
                // In space: the meter alone.
            } else if (groundPipeline && groundBindGroup && groundIrradiancePipeline && groundIrradianceBindGroup) {
                sweep(pass, skyViewPipeline, skyViewBindGroup, Math.floor(rows / 2));
                pass.setPipeline(groundIrradiancePipeline);
                pass.setBindGroup(0, groundIrradianceBindGroup);
                pass.dispatchWorkgroups(1);
                sweep(pass, groundPipeline, groundBindGroup, rows - Math.floor(rows / 2));
            } else {
                sweep(pass, skyViewPipeline, skyViewBindGroup, rows);
            }
            if (remeter) {
                // The light meter reads the table just built, so its reading always matches the sky, and writes the
                // observer's horizon for the sky pass.
                pass.setPipeline(samplePipeline);
                pass.setBindGroup(0, sampleBindGroup);
                pass.dispatchWorkgroups(METER_WORKGROUPS);
                pass.setPipeline(meterPipeline);
                pass.setBindGroup(0, meterBindGroup);
                pass.dispatchWorkgroups(1);
            }
            // One invocation per column of froxels, which marches through all of its slices.
            if (rebuildAerial && aerial && aerialPipeline && aerialBindGroup) {
                pass.setPipeline(aerialPipeline);
                pass.setBindGroup(0, aerialBindGroup);
                pass.dispatchWorkgroups(dispatch(aerial.width), dispatch(aerial.height));
            }
            pass.end();
            if (!frameEncoder) device.queue.submit([encoder.finish()]);
        },

        async meteredEV100() {
            const [log2Luminance] = await readMetering(0, 1);
            const [min, max] = params.autoExposureRange;
            return Math.min(Math.max((log2Luminance as number) + 3 - compensation, min), max);
        },

        async sunIlluminance() {
            const [r, g, b] = await readMetering(16, 3);
            return [r as number, g as number, b as number];
        },

        async moonIlluminance() {
            const [r, g, b] = await readMetering(32, 3);
            return [r as number, g as number, b as number];
        },

        async skyIrradiance() {
            const spectral = await readMetering(48, 4);
            return spectrumToRgb(model).map((row) =>
                row.reduce((sum, m, j) => sum + m * (spectral[j] as number), 0),
            ) as [number, number, number];
        },

        async createCubePass(cubeOptions: SkyCubeOptions) {
            const { format: cubeFormat, samples = 1, cubify = false, sunDisc = false, scaled = false } = cubeOptions;
            checkEnvironment(cubeFormat, sunDisc, samples);
            const output = (viewDimension: GPUTextureViewDimension) =>
                device.createBindGroupLayout({
                    entries: [
                        {
                            binding: 0,
                            visibility: GPUShaderStage.COMPUTE,
                            storageTexture: { format: cubeFormat, viewDimension },
                        },
                    ],
                });
            // Averaging down the mip levels, the layout spelled out: rgba32float is not filterable, and "auto" would
            // expect it to be. Read at the texels' centers, so a nearest sampler does.
            const mipSource = device.createBindGroupLayout({
                entries: [
                    {
                        binding: 0,
                        visibility: GPUShaderStage.COMPUTE,
                        texture: { sampleType: "unfilterable-float", viewDimension: "cube" },
                    },
                    { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: "non-filtering" } },
                ],
            });
            const [pipeline, mips] = await Promise.all([
                device.createComputePipelineAsync({
                    label: "dunstkreis:skyCube",
                    layout: "auto",
                    compute: {
                        module: device.createShaderModule({ code: skySource(wgsl.skyCubeOutput(cubeFormat)) }),
                        entryPoint: "dkSky",
                        constants: constants(
                            {
                                toneMap: false,
                                dither: false,
                                cube: true,
                                cubeScaled: scaled,
                                cubify,
                                sunDisc,
                                veil: 0,
                                limbDarkening,
                                moonlight,
                            },
                            { cube: samples },
                        ),
                    },
                }),
                device.createComputePipelineAsync({
                    label: "dunstkreis:cubeMipmap",
                    layout: device.createPipelineLayout({ bindGroupLayouts: [mipSource, output("2d-array")] }),
                    compute: {
                        module: device.createShaderModule({
                            code: [wgsl.cube, wgsl.skyCubeOutput(cubeFormat), wgsl.mipmap].join("\n"),
                        }),
                        entryPoint: "dkDownsample",
                    },
                }),
            ]);
            const cubeBindGroup = skyBindGroupFor(pipeline);
            const nearest = device.createSampler();
            const level = (target: GPUTexture, mip: number, dimension: GPUTextureViewDimension) =>
                target.createView({ dimension, baseMipLevel: mip, mipLevelCount: 1 });

            const cubePass: SkyCubePass = {
                encode(encoder, target) {
                    const { width, height, depthOrArrayLayers, mipLevelCount, usage } = target;
                    if (target.dimension !== "2d" || depthOrArrayLayers !== 6 || width !== height) {
                        throw new Error("dunstkreis: a cube map is a square 2D texture with six layers");
                    }
                    if (target.format !== cubeFormat) {
                        throw new Error(`dunstkreis: this cube pass writes ${cubeFormat}, not ${target.format}`);
                    }
                    if (!(usage & GPUTextureUsage.STORAGE_BINDING)) {
                        throw new Error("dunstkreis: the cube map needs STORAGE_BINDING usage");
                    }
                    if (mipLevelCount > 1 && !(usage & GPUTextureUsage.TEXTURE_BINDING)) {
                        throw new Error("dunstkreis: the cube map's mip levels read the level above: TEXTURE_BINDING");
                    }
                    const pass = encoder.beginComputePass({ label: "dunstkreis:skyCube" });
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, cubeBindGroup);
                    pass.setBindGroup(
                        1,
                        device.createBindGroup({
                            layout: pipeline.getBindGroupLayout(1),
                            entries: [{ binding: 0, resource: level(target, 0, "2d-array") }],
                        }),
                    );
                    pass.dispatchWorkgroups(dispatch(width), dispatch(width), 6);
                    pass.setPipeline(mips);
                    for (let mip = 1; mip < mipLevelCount; ++mip) {
                        const source = [
                            { binding: 0, resource: level(target, mip - 1, "cube") },
                            { binding: 1, resource: nearest },
                        ];
                        const next = [{ binding: 0, resource: level(target, mip, "2d-array") }];
                        pass.setBindGroup(
                            0,
                            device.createBindGroup({ layout: mips.getBindGroupLayout(0), entries: source }),
                        );
                        pass.setBindGroup(
                            1,
                            device.createBindGroup({ layout: mips.getBindGroupLayout(1), entries: next }),
                        );
                        const size = Math.max(1, width >> mip);
                        pass.dispatchWorkgroups(dispatch(size), dispatch(size), 6);
                    }
                    pass.end();
                },
            };
            return cubePass;
        },

        async createAerialPerspectivePass(passOptions) {
            const { format: targetFormat, clearDepth = 1, metersPerUnit = 1 } = passOptions;
            if (!aerialVolume) throw new Error("dunstkreis: this sky pass was made without `aerialPerspective`");
            if (targetFormat !== "rgba16float" && targetFormat !== "rgba32float") {
                throw new Error(`dunstkreis: the aerial perspective pass writes linear light, not ${targetFormat}`);
            }
            if (!(metersPerUnit > 0)) throw new Error("dunstkreis: a scene's unit is more than 0 meters");
            const pipeline = await device.createComputePipelineAsync({
                label: "dunstkreis:aerialPerspectivePass",
                layout: "auto",
                compute: {
                    module: device.createShaderModule({
                        code: [
                            wgsl.features,
                            wgsl.frame,
                            wgsl.whitebalance,
                            wgsl.aerial,
                            wgsl.skyOutput(targetFormat),
                            wgsl.aerialapply,
                        ].join("\n"),
                    }),
                    entryPoint: "dkApplyAerialPerspective",
                    constants: {
                        ...featureConstants({ autoExposure }),
                        DK_AERIAL_CLEAR_DEPTH: clearDepth,
                        DK_AERIAL_UNIT_KM: metersPerUnit / 1000,
                    },
                },
            });
            const [luminance, transmittance] = [
                aerialVolume.luminance.createView(),
                aerialVolume.transmittance.createView(),
            ];
            // The group that takes the scene, remade only when its textures change.
            let scene: { color: GPUTexture; depth: GPUTexture; group: GPUBindGroup } | null = null;
            const targets = new WeakMap<GPUTexture, GPUBindGroup>();
            const aerialPass: AerialPerspectivePass = {
                encode(encoder, target, { color, depth }) {
                    if ([color, depth].some((t) => t.width !== target.width || t.height !== target.height)) {
                        throw new Error("dunstkreis: the scene's color and depth are the target's size");
                    }
                    if (target.format !== targetFormat) {
                        throw new Error(`dunstkreis: this pass writes ${targetFormat}, not ${target.format}`);
                    }
                    if (scene?.color !== color || scene.depth !== depth) {
                        const group = bindGroup(pipeline, [
                            { binding: 0, resource: { buffer: skyParams } },
                            { binding: 1, resource: { buffer: metering } },
                            { binding: 2, resource: luminance },
                            { binding: 3, resource: transmittance },
                            { binding: 4, resource: luts.sampler },
                            { binding: 5, resource: color.createView() },
                            { binding: 6, resource: depth.createView({ aspect: "depth-only" }) },
                        ]);
                        scene = { color, depth, group };
                    }
                    let output = targets.get(target);
                    if (!output) {
                        output = device.createBindGroup({
                            layout: pipeline.getBindGroupLayout(1),
                            entries: [{ binding: 0, resource: target.createView() }],
                        });
                        targets.set(target, output);
                    }
                    const pass = encoder.beginComputePass({ label: "dunstkreis:aerialPerspectivePass" });
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, scene.group);
                    pass.setBindGroup(1, output);
                    pass.dispatchWorkgroups(dispatch(target.width), dispatch(target.height));
                    pass.end();
                },
            };
            return aerialPass;
        },

        encode(encoder, target) {
            // One bind group per target, kept as long as the target lives: a canvas hands out a new texture every
            // frame, an offscreen target is the same one each time.
            let output = outputs.get(target);
            if (!output) {
                output = device.createBindGroup({
                    layout: skyPipeline.getBindGroupLayout(1),
                    entries: [{ binding: 0, resource: target.createView() }],
                });
                outputs.set(target, output);
            }
            const pass = encoder.beginComputePass({ label: "dunstkreis:sky" });
            pass.setPipeline(skyPipeline);
            pass.setBindGroup(0, skyBindGroup);
            pass.setBindGroup(1, output);
            pass.dispatchWorkgroups(dispatch(target.width), dispatch(target.height));
            pass.end();
        },

        destroy() {
            skyView.destroy();
            moonView?.destroy();
            skyParams.destroy();
            aerialVolume?.luminance.destroy();
            aerialVolume?.transmittance.destroy();
            metering.destroy();
        },
    };
}
