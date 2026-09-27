import { autoExposureCompensation, DEFAULT_AUTO_EXPOSURE_KEYS, exposureFromEV100 } from "./exposure.js";
import { createLut, dispatch } from "./luts.js";
import {
    type AtmosphereLUTs,
    clampObserverHeight,
    MIN_OBSERVER_HEIGHT_M,
    type SkyParams,
    type SkyPass,
} from "./pass.js";
import { pipelineConstants } from "./quality.js";
import { apparentDirection } from "./refraction.js";
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
     * Tone map for a display: exposed, compressed into [0, 1] and sRGB encoded, for an 8-bit target. Default true. Off,
     * the pass writes the exposed luminance itself, linear and unclamped, for a float target and a renderer that tone
     * maps the whole frame.
     */
    toneMap?: boolean;
    /** Dither the tone mapped output against banding, for an 8-bit target. Default true. */
    dither?: boolean;
    /** Draw the debug overlay: altitude lines every 10 degrees, the compass directions and a ring around the Sun. */
    debugGrid?: boolean;
    /** Draw the sun disc. Default true. */
    sunDisc?: boolean;
    /**
     * Samples of the sky gathering its light on the ground, 8 or 64 by default, spread by the golden sets: the ground
     * below the horizon is then lit by the sky as well as the sun. 0 leaves it lit by the sun alone.
     */
    groundSamples?: 0 | 8 | 64;
}

/** Byte size of DkSkyParams: a mat4x4, three vec3-plus-scalar pairs, four loose scalars and a flag, padded. */
const SKY_PARAMS_SIZE = 144;
/** Byte size of DkSkyViewParams: one vec3 plus a scalar. */
const SKY_VIEW_PARAMS_SIZE = 16;

const DEFAULTS: SkyParams = {
    sunDirection: [0, 0, 1],
    observerHeightM: MIN_OBSERVER_HEIGHT_M,
    inverseViewProjection: new Float32Array(16),
    ev100: 14,
    autoExposure: false,
    autoExposureRange: [8, 20],
    autoExposureKeys: DEFAULT_AUTO_EXPOSURE_KEYS,
    exposureCompensation: 0,
    sunAngularDiameter: 0.533,
    projectionDistance: 0,
    // Off: added after tone mapping, it paints over the blue the ozone already gives twilight. osgHimmel used 0.5.
    lHeureBleue: { color: [0.08, 0.3, 0.7], intensity: 0 },
};

/**
 * A sky pass. Owns the per-frame sky-view table and the compute pipelines, and nothing
 * else: no device, no canvas, no context of its own.
 *
 * `update()` rebuilds the sky-view table only when the sun or the observer moved; a camera move just rewrites the
 * uniforms. `encode()` then costs one texture fetch per pixel.
 */
export function createSkyPass(device: GPUDevice, options: SkyPassOptions): SkyPass {
    const { luts, format } = options;
    const { config } = luts;
    const { toneMap = true, dither = true, debugGrid = false, sunDisc = true, groundSamples = 64 } = options;
    if (![0, 8, 64].includes(groundSamples))
        throw new Error("dunstkreis: 0, 8 or 64 samples of the sky's light on the ground");
    const constants = pipelineConstants(config, {
        toneMap,
        dither,
        debugGrid,
        sunDisc,
        groundSamples: groundSamples === 8 ? 8 : 64,
    });
    // Everything but the output, which differs between an image and a cube map.
    const skySource = (output: string) =>
        [
            wgsl.quality,
            wgsl.atmosphere,
            wgsl.common,
            wgsl.lut,
            wgsl.sampling,
            wgsl.raymarch,
            wgsl.cube,
            wgsl.goldenset,
            output,
            wgsl.sky,
        ].join("\n");

    const skyView = createLut(device, "dunstkreis:skyView", config.skyView.width, config.skyView.height);

    const skyViewParams = device.createBuffer({
        label: "dunstkreis:skyViewParams",
        size: SKY_VIEW_PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // The light meter's own, with the observer's altitude unclamped: above the atmosphere it raymarches.
    const meterParams = device.createBuffer({
        label: "dunstkreis:meterParams",
        size: SKY_VIEW_PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // The light meter's reading and the sun's illuminance, written on the GPU and read there by the sky pass.
    const metering = device.createBuffer({
        label: "dunstkreis:metering",
        size: 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const skyParams = device.createBuffer({
        label: "dunstkreis:skyParams",
        size: SKY_PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // The sky-view table in up to three steps: the table with the ground lit by the sun, the sky's light on the ground
    // gathered from it, and the ground again with both. See skyview.comp.wgsl.
    const skyViewModule = device.createShaderModule({
        code: [
            wgsl.quality,
            wgsl.atmosphere,
            wgsl.common,
            wgsl.lut,
            wgsl.sampling,
            wgsl.raymarch,
            wgsl.goldenset,
            wgsl.skyview,
        ].join("\n"),
    });
    const skyViewStep = (entryPoint: string, groundLight: boolean) =>
        device.createComputePipeline({
            label: `dunstkreis:${entryPoint}`,
            layout: "auto",
            compute: {
                module: skyViewModule,
                entryPoint,
                constants: { ...constants, ...(groundLight ? { DK_GROUND_LIGHT: 1 } : {}) },
            },
        });
    const skyViewPipeline = skyViewStep("dkPrecomputeSkyView", false);
    const groundLit = groundSamples !== 0;
    const groundIrradiancePipeline = groundLit ? skyViewStep("dkGroundIrradiance", false) : null;
    const groundPipeline = groundLit ? skyViewStep("dkPrecomputeSkyView", true) : null;
    const groundLight = device.createBuffer({
        label: "dunstkreis:groundLight",
        size: 16,
        usage: GPUBufferUsage.STORAGE,
    });

    const storable = ["rgba8unorm", "rgba16float", "rgba32float"].includes(format);
    if (!storable && !(format === "bgra8unorm" && device.features.has("bgra8unorm-storage"))) {
        throw new Error(`dunstkreis: the sky pass writes ${format} as a storage texture, which this device cannot`);
    }
    const skyPipeline = device.createComputePipeline({
        label: "dunstkreis:sky",
        layout: "auto",
        compute: {
            module: device.createShaderModule({ code: skySource(wgsl.skyOutput(format)) }),
            entryPoint: "dkSky",
            constants,
        },
    });

    const skyViewEntries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: luts.atmosphereBuffer } },
        { binding: 1, resource: { buffer: skyViewParams } },
        { binding: 2, resource: luts.transmittance.createView() },
        { binding: 3, resource: luts.multiScattering.createView() },
        { binding: 4, resource: luts.sampler },
        { binding: 5, resource: skyView.createView() },
        { binding: 6, resource: { buffer: groundLight } },
    ];
    const skyViewBindGroup = device.createBindGroup({
        layout: skyViewPipeline.getBindGroupLayout(0),
        entries: skyViewEntries,
    });
    const groundBindGroup =
        groundPipeline &&
        device.createBindGroup({ layout: groundPipeline.getBindGroupLayout(0), entries: skyViewEntries });
    const groundIrradianceBindGroup =
        groundIrradiancePipeline &&
        device.createBindGroup({
            layout: groundIrradiancePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: luts.atmosphereBuffer } },
                { binding: 1, resource: { buffer: skyViewParams } },
                { binding: 4, resource: luts.sampler },
                { binding: 6, resource: { buffer: groundLight } },
                { binding: 7, resource: skyView.createView() },
            ],
        });

    // One bind group per pipeline: layouts derived by "auto" never match another pipeline's.
    const skyBindGroupFor = (pipeline: GPUComputePipeline) =>
        device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: luts.atmosphereBuffer } },
                { binding: 1, resource: { buffer: skyParams } },
                { binding: 2, resource: luts.transmittance.createView() },
                { binding: 3, resource: skyView.createView() },
                { binding: 4, resource: luts.sampler },
                { binding: 5, resource: luts.multiScattering.createView() },
                { binding: 6, resource: { buffer: metering } },
            ],
        });
    const skyBindGroup = skyBindGroupFor(skyPipeline);

    // The cube map pipelines, made on first use, one per format and with or without the sun disc.
    const cubePipelines = new Map<string, { pipeline: GPUComputePipeline; bindGroup: GPUBindGroup }>();
    function cubePipeline(cubeFormat: GPUTextureFormat, sunDisc: boolean, cubeSamples: 1 | 8 | 64) {
        const key = `${cubeFormat},${sunDisc},${cubeSamples}`;
        let entry = cubePipelines.get(key);
        if (!entry) {
            const pipeline = device.createComputePipeline({
                label: "dunstkreis:skyCube",
                layout: "auto",
                compute: {
                    module: device.createShaderModule({ code: skySource(wgsl.skyCubeOutput(cubeFormat)) }),
                    entryPoint: "dkSky",
                    constants: pipelineConstants(config, {
                        toneMap: false,
                        dither: false,
                        cube: true,
                        cubeSamples,
                        sunDisc,
                    }),
                },
            });
            entry = { pipeline, bindGroup: skyBindGroupFor(pipeline) };
            cubePipelines.set(key, entry);
        }
        return entry;
    }

    // Averaging a cube map down its mip levels, one pipeline per format; the layout spelled out, as rgba32float is
    // not filterable and "auto" would expect it to be.
    const mipPipelines = new Map<string, GPUComputePipeline>();
    function mipPipeline(cubeFormat: GPUTextureFormat) {
        let pipeline = mipPipelines.get(cubeFormat);
        if (!pipeline) {
            const source = device.createBindGroupLayout({
                entries: [
                    {
                        binding: 0,
                        visibility: GPUShaderStage.COMPUTE,
                        texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" },
                    },
                ],
            });
            const output = device.createBindGroupLayout({
                entries: [
                    {
                        binding: 0,
                        visibility: GPUShaderStage.COMPUTE,
                        storageTexture: { format: cubeFormat, viewDimension: "2d-array" },
                    },
                ],
            });
            pipeline = device.createComputePipeline({
                label: "dunstkreis:cubeMipmap",
                layout: device.createPipelineLayout({ bindGroupLayouts: [source, output] }),
                compute: {
                    module: device.createShaderModule({
                        code: [wgsl.skyCubeOutput(cubeFormat), wgsl.mipmap].join("\n"),
                    }),
                    entryPoint: "dkDownsample",
                },
            });
            mipPipelines.set(cubeFormat, pipeline);
        }
        return pipeline;
    }
    const cubeLevel = (target: GPUTexture, level: number) =>
        target.createView({ dimension: "2d-array", baseMipLevel: level, mipLevelCount: 1 });

    const meterPipeline = device.createComputePipeline({
        label: "dunstkreis:meter",
        layout: "auto",
        compute: {
            module: device.createShaderModule({
                code: [wgsl.atmosphere, wgsl.common, wgsl.lut, wgsl.sampling, wgsl.raymarch, wgsl.exposure].join("\n"),
            }),
            entryPoint: "dkMeterSky",
        },
    });
    const meterBindGroup = device.createBindGroup({
        layout: meterPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: luts.atmosphereBuffer } },
            { binding: 1, resource: { buffer: meterParams } },
            { binding: 2, resource: skyView.createView() },
            { binding: 3, resource: luts.sampler },
            { binding: 4, resource: { buffer: metering } },
            { binding: 5, resource: luts.transmittance.createView() },
            { binding: 6, resource: luts.multiScattering.createView() },
        ],
    });

    let params: SkyParams = { ...DEFAULTS };
    let skyViewKey = "";
    let apparentSun: readonly [number, number, number] = params.sunDirection;
    let compensation = 0;

    return {
        skyViewTexture: skyView,

        update(next) {
            params = { ...params, ...next };

            const [sx, sy, sz] = params.sunDirection;
            // Held off the ground, which is degenerate. Above the atmosphere the sky pass raymarches per pixel; the
            // table, which only it reads, is then left at the top.
            const height = clampObserverHeight(params.observerHeightM);
            const altitudeKm = Math.min(height / 1000, luts.model.planet.thicknessKm);

            // Rebuilding the sky-view table is the expensive part, and it is why the sky pass itself is one fetch
            // per pixel rather than a raymarch. It depends on nothing but the Sun and the observer.
            const key = `${sx},${sy},${sz},${height}`;
            if (key !== skyViewKey) {
                skyViewKey = key;
                // Where the sun shows, for the debug overlay's ring, traced like the view rays.
                if (debugGrid) apparentSun = apparentDirection(params.sunDirection, luts.model, height);
                device.queue.writeBuffer(skyViewParams, 0, new Float32Array([sx, sy, sz, altitudeKm]));
                device.queue.writeBuffer(meterParams, 0, new Float32Array([sx, sy, sz, height / 1000]));
                const encoder = device.createCommandEncoder({ label: "dunstkreis:skyView" });
                const pass = encoder.beginComputePass();
                pass.setPipeline(skyViewPipeline);
                pass.setBindGroup(0, skyViewBindGroup);
                pass.dispatchWorkgroups(dispatch(config.skyView.width), dispatch(config.skyView.height));
                pass.end();
                if (groundPipeline && groundBindGroup && groundIrradiancePipeline && groundIrradianceBindGroup) {
                    const gather = encoder.beginComputePass();
                    gather.setPipeline(groundIrradiancePipeline);
                    gather.setBindGroup(0, groundIrradianceBindGroup);
                    gather.dispatchWorkgroups(1);
                    gather.end();
                    const ground = encoder.beginComputePass();
                    ground.setPipeline(groundPipeline);
                    ground.setBindGroup(0, groundBindGroup);
                    ground.dispatchWorkgroups(dispatch(config.skyView.width), dispatch(config.skyView.height));
                    ground.end();
                }
                // The light meter reads the table just built, so its reading always matches the sky.
                const meter = encoder.beginComputePass();
                meter.setPipeline(meterPipeline);
                meter.setBindGroup(0, meterBindGroup);
                meter.dispatchWorkgroups(1);
                meter.end();
                device.queue.submit([encoder.finish()]);
            }

            const sky = new Float32Array(SKY_PARAMS_SIZE / 4);
            sky.set(params.inverseViewProjection, 0);
            sky.set([sx, sy, sz], 16);
            sky[19] = height / 1000;
            sky.set(params.lHeureBleue.color, 20);
            sky[23] = params.lHeureBleue.intensity;
            sky[24] = exposureFromEV100(params.ev100);
            sky[25] = (params.sunAngularDiameter / 2) * (Math.PI / 180);
            sky[26] = params.autoExposureRange[0];
            const { groundRadiusKm } = luts.model.planet;
            const dip = (Math.acos(groundRadiusKm / (groundRadiusKm + height / 1000)) * 180) / Math.PI;
            compensation =
                params.exposureCompensation + autoExposureCompensation(params.autoExposureKeys, [sx, sy, sz], dip);
            sky[27] = compensation;
            sky.set(apparentSun, 28);
            sky[31] = params.projectionDistance;
            new Uint32Array(sky.buffer)[32] = params.autoExposure ? 1 : 0;
            sky[33] = params.autoExposureRange[1];
            device.queue.writeBuffer(skyParams, 0, sky);
        },

        async meteredEV100() {
            const staging = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
            const encoder = device.createCommandEncoder({ label: "dunstkreis:meterReadback" });
            encoder.copyBufferToBuffer(metering, 0, staging, 0, 4);
            device.queue.submit([encoder.finish()]);
            await staging.mapAsync(GPUMapMode.READ);
            const log2Luminance = new Float32Array(staging.getMappedRange())[0] as number;
            staging.destroy();
            const [min, max] = params.autoExposureRange;
            return Math.min(Math.max(log2Luminance + 3 - compensation, min), max);
        },

        async sunIlluminance() {
            const staging = device.createBuffer({ size: 12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
            const encoder = device.createCommandEncoder({ label: "dunstkreis:sunReadback" });
            encoder.copyBufferToBuffer(metering, 16, staging, 0, 12);
            device.queue.submit([encoder.finish()]);
            await staging.mapAsync(GPUMapMode.READ);
            const [r, g, b] = new Float32Array(staging.getMappedRange());
            staging.destroy();
            return [r as number, g as number, b as number];
        },

        encodeCube(encoder, target, { sunDisc = false, samples = 1 } = {}) {
            const { width, height, depthOrArrayLayers } = target;
            if (target.dimension !== "2d" || depthOrArrayLayers !== 6 || width !== height) {
                throw new Error("dunstkreis: a cube map is a square 2D texture with six layers");
            }
            if (target.format !== "rgba16float" && target.format !== "rgba32float") {
                throw new Error(`dunstkreis: the sky's cube map is rgba16float or rgba32float, not ${target.format}`);
            }
            if (sunDisc && target.format !== "rgba32float") {
                throw new Error(
                    "dunstkreis: the sun disc needs rgba32float, being far brighter than rgba16float holds",
                );
            }
            if (![1, 8, 64].includes(samples)) throw new Error("dunstkreis: 1, 8 or 64 samples per cube map texel");
            const { pipeline, bindGroup } = cubePipeline(target.format, sunDisc, samples);
            const output = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(1),
                entries: [{ binding: 0, resource: cubeLevel(target, 0) }],
            });
            const pass = encoder.beginComputePass({ label: "dunstkreis:skyCube" });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.setBindGroup(1, output);
            pass.dispatchWorkgroups(dispatch(width), dispatch(width), 6);
            const mips = mipPipeline(target.format);
            for (let level = 1; level < target.mipLevelCount; ++level) {
                const size = Math.max(1, width >> level);
                pass.setPipeline(mips);
                for (const [group, view] of [cubeLevel(target, level - 1), cubeLevel(target, level)].entries()) {
                    const entries = [{ binding: 0, resource: view }];
                    pass.setBindGroup(
                        group,
                        device.createBindGroup({ layout: mips.getBindGroupLayout(group), entries }),
                    );
                }
                pass.dispatchWorkgroups(dispatch(size), dispatch(size), 6);
            }
            pass.end();
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
            skyViewParams.destroy();
            groundLight.destroy();
            meterParams.destroy();
            skyParams.destroy();
            metering.destroy();
        },
    };
}
