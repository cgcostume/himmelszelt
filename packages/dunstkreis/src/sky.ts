import { autoExposureCompensation, DEFAULT_AUTO_EXPOSURE_KEYS, exposureFromEV100 } from "./exposure.js";
import { createLut, dispatch } from "./luts.js";
import {
    type AerialPerspectiveOptions,
    type AerialPerspectiveVolume,
    type AtmosphereLUTs,
    clampObserverHeight,
    MIN_OBSERVER_HEIGHT_M,
    type SkyCubeOptions,
    type SkyCubePass,
    type SkyPanoramaOptions,
    type SkyPanoramaPass,
    type SkyParams,
    type SkyPass,
} from "./pass.js";
import {
    type Features,
    featureConstants,
    pipelineConstants,
    refractionConstants,
    scatteringConstants,
    type ToneCurve,
} from "./quality.js";
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
    /** Dither the tone mapped output against banding, by default for an 8-bit target only. */
    dither?: boolean;
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
     * Build Hillaire's aerial perspective volume as well, for the air in front of the caller's geometry: `true` for
     * 32x32 froxels in 32 slices out to 32 km, or its shape. Off by default.
     */
    aerialPerspective?: boolean | AerialPerspectiveOptions;
}

/** Byte size of DkSkyParams in frame.wgsl: a vec3 and a scalar, a mat4x4, four scalars, a vec2 and two scalars. */
const SKY_PARAMS_SIZE = 112;
/** The light meter's directions per cap, `DK_METER_SAMPLES` in frame.wgsl, one per invocation of 128 per workgroup. */
const METER_SAMPLES = 4096;
const METER_WORKGROUPS = METER_SAMPLES / 128;
/** Byte size of DkMetering before its bend per sky-view row: a scalar, a vec3 and two vec4s, each aligned to 16, then
 *  the meter's samples, a vec2f each. */
const METERING_SIZE = 64 + METER_SAMPLES * 8;

const DEFAULTS: SkyParams = {
    sunDirection: [0, 0, 1],
    observerHeightM: MIN_OBSERVER_HEIGHT_M,
    // A camera looking north with a 90° field of view, until the caller sets its own: all zeros would make every ray NaN.
    inverseViewProjection: new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    ev100: 14,
    autoExposureRange: [4, 20],
    autoExposureKeys: DEFAULT_AUTO_EXPOSURE_KEYS,
    exposureCompensation: 0,
    pixelRatio: 1,
    sunAngularDiameter: 0.533,
    projectionDistance: 0,
};

const EIGHT_BIT = ["rgba8unorm", "bgra8unorm"];

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
        discAlpha = false,
        supersample = true,
        groundLight = true,
        headroom = 1,
    } = options;
    const dither = options.dither ?? (toneMap !== false && EIGHT_BIT.includes(format));
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
        [...prelude, wgsl.cube, wgsl.panorama, wgsl.sun, wgsl.tonemap, output, wgsl.sky].join("\n");
    // A cube map's or a panorama's format and settings, checked alike.
    const checkEnvironment = (format: GPUTextureFormat, sunDisc: boolean, samples: number) => {
        if (format !== "rgba16float" && format !== "rgba32float") {
            throw new Error(`dunstkreis: the sky's cube map or panorama is rgba16float or rgba32float, not ${format}`);
        }
        if (sunDisc && format !== "rgba32float") {
            throw new Error("dunstkreis: the sun disc needs rgba32float, being far brighter than rgba16float holds");
        }
        if (!Number.isInteger(samples) || samples < 1) throw new Error("dunstkreis: at least 1 sample per texel");
    };

    const skyView = createLut(device, "dunstkreis:skyView", config.skyView.width, config.skyView.height);
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
            aerial.maxDistanceKm > 0
        )
    ) {
        throw new Error("dunstkreis: the aerial perspective volume takes whole froxels and a distance above 0");
    }
    // Luminance and transmittance at four wavelengths each, in two textures of four channels, like the sky-view table:
    // the light filters in the space it was integrated in and turns into RGB once, where it is applied.
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
              maxDistanceKm: aerial.maxDistanceKm,
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
    const skyViewStep = (entryPoint: string, skyViewRows: 0 | 1 | 2) =>
        device.createComputePipelineAsync({
            label: `dunstkreis:${entryPoint}`,
            layout: "auto",
            compute: { module: skyViewModule, entryPoint, constants: constants({ skyViewRows }) },
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
                    discAlpha,
                    supersample,
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
                        DK_AERIAL_PERSPECTIVE_DISTANCE: aerial.maxDistanceKm,
                    },
                },
            }),
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
    let aerialKey = "";
    let compensation = 0;
    let scale = 1;

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
            device.queue.writeBuffer(skyParams, 0, sky);

            // Rebuilding the sky-view table is the expensive part, and it is why the sky pass itself is one fetch
            // per pixel rather than a raymarch. It depends on nothing but the Sun and the observer. Above the
            // atmosphere nothing reads the table: the sky pass raymarches per pixel, and so does the meter.
            const key = `${sx},${sy},${sz},${height}`;
            const cameraKey = `${key},${params.inverseViewProjection.join(",")}`;
            const rebuildSkyView = key !== skyViewKey;
            const rebuildAerial = Boolean(aerialPipeline) && cameraKey !== aerialKey;
            if (!rebuildSkyView && !rebuildAerial) return;
            skyViewKey = key;
            aerialKey = cameraKey;
            const encoder = frameEncoder ?? device.createCommandEncoder({ label: "dunstkreis:skyView" });
            const pass = encoder.beginComputePass({ label: "dunstkreis:skyView" });
            const { height: rows } = config.skyView;
            if (!rebuildSkyView) {
                // The camera alone moved: the table stands.
            } else if (height / 1000 > model.planet.thicknessKm) {
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
            if (rebuildSkyView) {
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
                            { toneMap: false, dither: false, cube: true, cubeScaled: scaled, cubify, sunDisc },
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

        async createPanoramaPass(panoramaOptions: SkyPanoramaOptions) {
            const {
                projection,
                format: panoramaFormat,
                samples = 1,
                sunDisc = false,
                scaled = false,
            } = panoramaOptions;
            const { upperHalf = false, azimuthOffset = 0 } = panoramaOptions;
            checkEnvironment(panoramaFormat, sunDisc, samples);
            const panorama = ({ equirectangular: 1, octahedral: 2, fisheye: 3 } as const)[projection];
            if (!panorama) throw new Error(`dunstkreis: no panorama projection ${projection}`);
            if (upperHalf && projection !== "equirectangular") {
                throw new Error("dunstkreis: only the equirectangular panorama comes as its upper half");
            }
            const pipeline = await device.createComputePipelineAsync({
                label: "dunstkreis:skyPanorama",
                layout: "auto",
                compute: {
                    module: device.createShaderModule({ code: skySource(wgsl.skyOutput(panoramaFormat)) }),
                    entryPoint: "dkSky",
                    constants: constants(
                        {
                            toneMap: false,
                            dither: false,
                            cubeScaled: scaled,
                            sunDisc,
                            panorama,
                            panoramaUpperHalf: upperHalf,
                            panoramaAzimuthOffset: (azimuthOffset * Math.PI) / 180,
                        },
                        { cube: samples },
                    ),
                },
            });
            const panoramaBindGroup = skyBindGroupFor(pipeline);
            const panoramaPass: SkyPanoramaPass = {
                encode(encoder, target) {
                    if (target.dimension !== "2d" || target.depthOrArrayLayers !== 1) {
                        throw new Error("dunstkreis: a panorama is a 2D texture of one layer");
                    }
                    if (target.format !== panoramaFormat) {
                        throw new Error(
                            `dunstkreis: this panorama pass writes ${panoramaFormat}, not ${target.format}`,
                        );
                    }
                    if (!(target.usage & GPUTextureUsage.STORAGE_BINDING)) {
                        throw new Error("dunstkreis: the panorama needs STORAGE_BINDING usage");
                    }
                    const pass = encoder.beginComputePass({ label: "dunstkreis:skyPanorama" });
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, panoramaBindGroup);
                    pass.setBindGroup(
                        1,
                        device.createBindGroup({
                            layout: pipeline.getBindGroupLayout(1),
                            entries: [{ binding: 0, resource: target.createView({ mipLevelCount: 1 }) }],
                        }),
                    );
                    pass.dispatchWorkgroups(dispatch(target.width), dispatch(target.height));
                    pass.end();
                },
            };
            return panoramaPass;
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
            skyParams.destroy();
            aerialVolume?.luminance.destroy();
            aerialVolume?.transmittance.destroy();
            metering.destroy();
        },
    };
}
