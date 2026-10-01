import { autoExposureCompensation, DEFAULT_AUTO_EXPOSURE_KEYS, exposureFromEV100 } from "./exposure.js";
import { createLut, dispatch } from "./luts.js";
import {
    type AtmosphereLUTs,
    clampObserverHeight,
    MIN_OBSERVER_HEIGHT_M,
    type SkyCubeOptions,
    type SkyCubePass,
    type SkyParams,
    type SkyPass,
} from "./pass.js";
import { type Features, featureConstants, pipelineConstants, refractionConstants, type ToneCurve } from "./quality.js";
import * as wgsl from "./wgsl/index.js";

export interface SkyPassOptions {
    luts: AtmosphereLUTs;
    /**
     * Format of the target the pass writes into, which needs `STORAGE_BINDING` usage: rgba8unorm for a display (a
     * canvas configured with it), bgra8unorm with the "bgra8unorm-storage" feature, rgba16float or rgba32float for
     * linear output with `toneMap` off.
     */
    format: GPUTextureFormat;
    /**
     * Tone map for a display: exposed, compressed into [0, 1] and sRGB encoded, for an 8-bit target, by "neutral", the
     * default, or "agx" (`ToneCurve`). `false` writes the exposed luminance itself, linear and unclamped, for a float
     * target and a renderer that tone maps the whole frame, with `wgsl.tonemap` if it likes.
     */
    toneMap?: ToneCurve | false;
    /** Dither the tone mapped output against banding, by default for an 8-bit target only. */
    dither?: boolean;
    /**
     * Expose by a light meter instead of `ev100`: the geometric mean luminance of the sky above the horizon, measured
     * on the GPU whenever the sky-view table is rebuilt, and read by the sky pass without a round trip to the CPU. For a
     * renderer without its own exposure, or to follow day into night.
     */
    autoExposure?: boolean;
    /** Draw the debug overlay: altitude lines every 10 degrees, the compass directions and a ring around the Sun. */
    debugGrid?: boolean;
    /** Draw the sun disc. Default true. */
    sunDisc?: boolean;
    /**
     * Samples of the sky gathering its light on the ground, 1024 by default, spread by Vogel's spiral: the ground below
     * the horizon is then lit by the sky as well as the sun. 0.2% off; 256 is 1.2% off, 64 up to 12% with a low sun,
     * whose glow few samples hit or miss; no better beyond 2048. Gathered by a workgroup, it costs next to nothing. 0
     * leaves the ground lit by the sun alone, a sky-view dispatch cheaper.
     */
    groundSamples?: number;
}

/** Byte size of DkSkyParams in frame.wgsl: a vec3 and a scalar, a mat4x4, four scalars and a vec2, padded. */
const SKY_PARAMS_SIZE = 112;
/** Byte size of DkMetering: a scalar, then two vec3s, each aligned to 16. */
const METERING_SIZE = 48;

const DEFAULTS: SkyParams = {
    sunDirection: [0, 0, 1],
    observerHeightM: MIN_OBSERVER_HEIGHT_M,
    inverseViewProjection: new Float32Array(16),
    ev100: 14,
    autoExposureRange: [8, 20],
    autoExposureKeys: DEFAULT_AUTO_EXPOSURE_KEYS,
    exposureCompensation: 0,
    sunAngularDiameter: 0.533,
    projectionDistance: 0,
};

const EIGHT_BIT = ["rgba8unorm", "bgra8unorm"];

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
        groundSamples = 1024,
    } = options;
    const dither = options.dither ?? (toneMap !== false && EIGHT_BIT.includes(format));
    if (!Number.isInteger(groundSamples) || groundSamples < 0) {
        throw new Error("dunstkreis: groundSamples is a count, 0 for none");
    }
    const storable = ["rgba8unorm", "rgba16float", "rgba32float"].includes(format);
    if (!storable && !(format === "bgra8unorm" && device.features.has("bgra8unorm-storage"))) {
        throw new Error(`dunstkreis: the sky pass writes ${format} as a storage texture, which this device cannot`);
    }
    const constants = (features: Partial<Features>, samples: { cube?: number } = {}) => ({
        ...pipelineConstants(config, { ground: groundSamples, ...samples }),
        ...featureConstants(features),
        ...refractionConstants(model),
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
    const skySource = (output: string) => [...prelude, wgsl.cube, wgsl.sun, wgsl.tonemap, output, wgsl.sky].join("\n");

    const skyView = createLut(device, "dunstkreis:skyView", config.skyView.width, config.skyView.height);
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
        size: METERING_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // The sky-view table in one step, or with the ground lit by the sky in three: the sky, the sky's light on the
    // ground gathered from it, the ground. See skyview.comp.wgsl.
    const skyViewModule = device.createShaderModule({
        code: [wgsl.workgroupSum(64, device.features.has("subgroups")), ...prelude, wgsl.skyview].join("\n"),
    });
    const groundLit = groundSamples > 0;
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
            wgsl.frame,
            wgsl.exposure,
        ].join("\n"),
    });
    const [skyViewPipeline, groundIrradiancePipeline, groundPipeline, meterPipeline, skyPipeline] = await Promise.all([
        skyViewStep("dkPrecomputeSkyView", groundLit ? 1 : 0),
        groundLit ? skyViewStep("dkGroundIrradiance", 0) : null,
        groundLit ? skyViewStep("dkPrecomputeSkyView", 2) : null,
        device.createComputePipelineAsync({
            label: "dunstkreis:meter",
            layout: "auto",
            compute: { module: meterModule, entryPoint: "dkMeterSky", constants: refractionConstants(model) },
        }),
        device.createComputePipelineAsync({
            label: "dunstkreis:sky",
            layout: "auto",
            compute: {
                module: device.createShaderModule({ code: skySource(wgsl.skyOutput(format)) }),
                entryPoint: "dkSky",
                constants: constants({ toneMap, dither, autoExposure, debugGrid, sunDisc }),
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
            { binding: 4, resource: luts.sampler },
            { binding: 6, resource: { buffer: metering } },
            { binding: 7, resource: skyView.createView() },
        ]);
    const meterBindGroup = bindGroup(meterPipeline, [
        { binding: 0, resource: { buffer: luts.atmosphereBuffer } },
        { binding: 1, resource: { buffer: skyParams } },
        { binding: 2, resource: skyView.createView() },
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

    const sweep = (pass: GPUComputePassEncoder, pipeline: GPUComputePipeline, group: GPUBindGroup, rows: number) => {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(dispatch(config.skyView.width), dispatch(rows));
    };

    let params: SkyParams = { ...DEFAULTS };
    let skyViewKey = "";
    let compensation = 0;

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

        update(next) {
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
            device.queue.writeBuffer(skyParams, 0, sky);

            // Rebuilding the sky-view table is the expensive part, and it is why the sky pass itself is one fetch
            // per pixel rather than a raymarch. It depends on nothing but the Sun and the observer. Above the
            // atmosphere the sky pass raymarches per pixel; the table, which only the meter reads then, stays at the top.
            const key = `${sx},${sy},${sz},${height}`;
            if (key === skyViewKey) return;
            skyViewKey = key;
            const encoder = device.createCommandEncoder({ label: "dunstkreis:skyView" });
            const pass = encoder.beginComputePass({ label: "dunstkreis:skyView" });
            const { height: rows } = config.skyView;
            if (groundPipeline && groundBindGroup && groundIrradiancePipeline && groundIrradianceBindGroup) {
                sweep(pass, skyViewPipeline, skyViewBindGroup, Math.floor(rows / 2));
                pass.setPipeline(groundIrradiancePipeline);
                pass.setBindGroup(0, groundIrradianceBindGroup);
                pass.dispatchWorkgroups(1);
                sweep(pass, groundPipeline, groundBindGroup, rows - Math.floor(rows / 2));
            } else {
                sweep(pass, skyViewPipeline, skyViewBindGroup, rows);
            }
            // The light meter reads the table just built, so its reading always matches the sky.
            pass.setPipeline(meterPipeline);
            pass.setBindGroup(0, meterBindGroup);
            pass.dispatchWorkgroups(1);
            pass.end();
            device.queue.submit([encoder.finish()]);
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

        async createCubePass({ format: cubeFormat, samples = 1, cubify = false, sunDisc = false }: SkyCubeOptions) {
            if (cubeFormat !== "rgba16float" && cubeFormat !== "rgba32float") {
                throw new Error(`dunstkreis: the sky's cube map is rgba16float or rgba32float, not ${cubeFormat}`);
            }
            if (sunDisc && cubeFormat !== "rgba32float") {
                throw new Error(
                    "dunstkreis: the sun disc needs rgba32float, being far brighter than rgba16float holds",
                );
            }
            if (!Number.isInteger(samples) || samples < 1) throw new Error("dunstkreis: at least 1 sample per texel");
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
                            { toneMap: false, dither: false, cube: true, cubify, sunDisc },
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

        encode(encoder, target) {
            const output = device.createBindGroup({
                layout: skyPipeline.getBindGroupLayout(1),
                entries: [{ binding: 0, resource: target.createView() }],
            });
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
            metering.destroy();
        },
    };
}
