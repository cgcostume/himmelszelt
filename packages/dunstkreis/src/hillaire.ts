import { autoExposureCompensation, DEFAULT_AUTO_EXPOSURE_KEYS, exposureFromEV100 } from "./exposure.js";
import {
    type AtmosphereModel,
    DEFAULT_ATMOSPHERE_MODEL,
    DEFAULT_TEXTURE_CONFIG,
    type PrecomputedTextureConfig,
} from "./model.js";
import { type AtmosphereLUTs, MIN_OBSERVER_HEIGHT_M, type SkyParams, type SkyPass } from "./pass.js";
import { pipelineConstants } from "./quality.js";
import { apparentDirection } from "./refraction.js";
import { ATMOSPHERE_UNIFORM_SIZE, atmosphereUniformData } from "./uniforms.js";
import * as wgsl from "./wgsl/index.js";

/** rgba16float everywhere: enough range for physical radiance, half the bandwidth of rgba32float. */
const LUT_FORMAT: GPUTextureFormat = "rgba16float";

const WORKGROUP = 8;
const dispatch = (n: number) => Math.ceil(n / WORKGROUP);

export interface PrecomputeOptions {
    model?: AtmosphereModel;
    config?: PrecomputedTextureConfig;
}

/** The tables the fast variant needs, plus the pieces a sky pass built on them has to reuse. */
export interface HillaireLUTs extends AtmosphereLUTs {
    readonly multiScattering: GPUTexture;
    readonly sampler: GPUSampler;
    readonly atmosphereBuffer: GPUBuffer;
}

function createLut(device: GPUDevice, label: string, width: number, height: number): GPUTexture {
    // GPUTextureUsage and friends are read inside functions, never at module scope: importing this package
    // must not require the WebGPU globals to exist yet, so it stays safe to import in Node or during SSR.
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;

    return device.createTexture({ label, size: { width, height }, format: LUT_FORMAT, usage });
}

/**
 * Precomputes the transmittance and multiple-scattering tables, Hillaire 2020. Cheap enough to re-run
 * whenever a model parameter changes, which is the practical reason to prefer this variant over Bruneton's.
 *
 * Neither table depends on the sun or the observer, so this runs once per model, not per frame.
 */
export async function precomputeAtmosphereApprox(
    device: GPUDevice,
    options: PrecomputeOptions = {},
): Promise<HillaireLUTs> {
    const model = options.model ?? DEFAULT_ATMOSPHERE_MODEL;
    const config = options.config ?? DEFAULT_TEXTURE_CONFIG;
    const constants = pipelineConstants(config);

    const transmittance = createLut(
        device,
        "dunstkreis:transmittance",
        config.transmittance.width,
        config.transmittance.height,
    );
    const multiScattering = createLut(
        device,
        "dunstkreis:multiScattering",
        config.multiScattering.width,
        config.multiScattering.height,
    );

    const sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
    });

    const atmosphereBuffer = device.createBuffer({
        label: "dunstkreis:atmosphere",
        size: ATMOSPHERE_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(atmosphereBuffer, 0, atmosphereUniformData(model));

    const transmittancePipeline = device.createComputePipeline({
        label: "dunstkreis:transmittance",
        layout: "auto",
        compute: {
            module: device.createShaderModule({
                code: [wgsl.quality, wgsl.atmosphere, wgsl.common, wgsl.lut, wgsl.transmittance].join("\n"),
            }),
            entryPoint: "dkPrecomputeTransmittance",
            constants,
        },
    });

    const multiScatteringPipeline = device.createComputePipeline({
        label: "dunstkreis:multiScattering",
        layout: "auto",
        compute: {
            module: device.createShaderModule({
                code: [wgsl.quality, wgsl.atmosphere, wgsl.common, wgsl.lut, wgsl.sampling, wgsl.multiscattering].join(
                    "\n",
                ),
            }),
            entryPoint: "dkPrecomputeMultiScattering",
            constants,
        },
    });

    const encoder = device.createCommandEncoder({ label: "dunstkreis:precompute" });

    // Transmittance first: the multiple-scattering pass reads it, and both run in one submission because
    // WebGPU orders passes within a queue, so no explicit barrier is needed between them.
    const transmittancePass = encoder.beginComputePass();
    transmittancePass.setPipeline(transmittancePipeline);
    transmittancePass.setBindGroup(
        0,
        device.createBindGroup({
            layout: transmittancePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: atmosphereBuffer } },
                { binding: 1, resource: transmittance.createView() },
            ],
        }),
    );
    transmittancePass.dispatchWorkgroups(dispatch(config.transmittance.width), dispatch(config.transmittance.height));
    transmittancePass.end();

    const multiScatteringPass = encoder.beginComputePass();
    multiScatteringPass.setPipeline(multiScatteringPipeline);
    multiScatteringPass.setBindGroup(
        0,
        device.createBindGroup({
            layout: multiScatteringPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: atmosphereBuffer } },
                { binding: 1, resource: transmittance.createView() },
                { binding: 2, resource: sampler },
                { binding: 3, resource: multiScattering.createView() },
            ],
        }),
    );
    multiScatteringPass.dispatchWorkgroups(
        dispatch(config.multiScattering.width),
        dispatch(config.multiScattering.height),
    );
    multiScatteringPass.end();

    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();

    return {
        model,
        config,
        transmittance,
        multiScattering,
        sampler,
        atmosphereBuffer,
        destroy() {
            transmittance.destroy();
            multiScattering.destroy();
            atmosphereBuffer.destroy();
        },
    };
}

export interface SkyPassOptions {
    luts: HillaireLUTs;
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
 * A sky pass for the fast variant. Owns the per-frame sky-view table and the compute pipelines, and nothing
 * else: no device, no canvas, no context of its own.
 *
 * `update()` rebuilds the sky-view table only when the sun or the observer moved; a camera move just rewrites the
 * uniforms. `encode()` then costs one texture fetch per pixel.
 */
export function createSkyPassApprox(device: GPUDevice, options: SkyPassOptions): SkyPass {
    const { luts, format } = options;
    const { config } = luts;
    const { toneMap = true, dither = true, debugGrid = false } = options;
    const constants = pipelineConstants(config, { toneMap, dither, debugGrid });

    const skyView = createLut(device, "dunstkreis:skyView", config.skyView.width, config.skyView.height);

    const skyViewParams = device.createBuffer({
        label: "dunstkreis:skyViewParams",
        size: SKY_VIEW_PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // The light meter's reading, written on the GPU and read there by the sky pass.
    const metering = device.createBuffer({
        label: "dunstkreis:metering",
        size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const skyParams = device.createBuffer({
        label: "dunstkreis:skyParams",
        size: SKY_PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const skyViewPipeline = device.createComputePipeline({
        label: "dunstkreis:skyView",
        layout: "auto",
        compute: {
            module: device.createShaderModule({
                code: [
                    wgsl.quality,
                    wgsl.atmosphere,
                    wgsl.common,
                    wgsl.lut,
                    wgsl.sampling,
                    wgsl.raymarch,
                    wgsl.skyview,
                ].join("\n"),
            }),
            entryPoint: "dkPrecomputeSkyView",
            constants,
        },
    });

    const storable = ["rgba8unorm", "rgba16float", "rgba32float"].includes(format);
    if (!storable && !(format === "bgra8unorm" && device.features.has("bgra8unorm-storage"))) {
        throw new Error(`dunstkreis: the sky pass writes ${format} as a storage texture, which this device cannot`);
    }
    const skyPipeline = device.createComputePipeline({
        label: "dunstkreis:sky",
        layout: "auto",
        compute: {
            module: device.createShaderModule({
                code: [
                    wgsl.quality,
                    wgsl.atmosphere,
                    wgsl.common,
                    wgsl.lut,
                    wgsl.sampling,
                    wgsl.raymarch,
                    wgsl.skyOutput(format),
                    wgsl.sky,
                ].join("\n"),
            }),
            entryPoint: "dkSky",
            constants,
        },
    });

    const skyViewBindGroup = device.createBindGroup({
        layout: skyViewPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: luts.atmosphereBuffer } },
            { binding: 1, resource: { buffer: skyViewParams } },
            { binding: 2, resource: luts.transmittance.createView() },
            { binding: 3, resource: luts.multiScattering.createView() },
            { binding: 4, resource: luts.sampler },
            { binding: 5, resource: skyView.createView() },
        ],
    });

    const skyBindGroup = device.createBindGroup({
        layout: skyPipeline.getBindGroupLayout(0),
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

    const meterPipeline = device.createComputePipeline({
        label: "dunstkreis:meter",
        layout: "auto",
        compute: {
            module: device.createShaderModule({
                code: [wgsl.atmosphere, wgsl.common, wgsl.lut, wgsl.exposure].join("\n"),
            }),
            entryPoint: "dkMeterSky",
        },
    });
    const meterBindGroup = device.createBindGroup({
        layout: meterPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: luts.atmosphereBuffer } },
            { binding: 1, resource: { buffer: skyViewParams } },
            { binding: 2, resource: skyView.createView() },
            { binding: 3, resource: luts.sampler },
            { binding: 4, resource: { buffer: metering } },
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
            const height = Math.max(params.observerHeightM, MIN_OBSERVER_HEIGHT_M);
            const altitudeKm = Math.min(height / 1000, luts.model.planet.thicknessKm);

            // Rebuilding the sky-view table is the expensive part, and it is why the sky pass itself is one fetch
            // per pixel rather than a raymarch. It depends on nothing but the Sun and the observer.
            const key = `${sx},${sy},${sz},${height}`;
            if (key !== skyViewKey) {
                skyViewKey = key;
                // Where the sun shows, for the debug overlay's ring, traced like the view rays.
                if (debugGrid) apparentSun = apparentDirection(params.sunDirection, luts.model, height);
                device.queue.writeBuffer(skyViewParams, 0, new Float32Array([sx, sy, sz, altitudeKm]));
                const encoder = device.createCommandEncoder({ label: "dunstkreis:skyView" });
                const pass = encoder.beginComputePass();
                pass.setPipeline(skyViewPipeline);
                pass.setBindGroup(0, skyViewBindGroup);
                pass.dispatchWorkgroups(dispatch(config.skyView.width), dispatch(config.skyView.height));
                pass.end();
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
            compensation =
                params.exposureCompensation + autoExposureCompensation(params.autoExposureKeys, [sx, sy, sz]);
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
            skyParams.destroy();
            metering.destroy();
        },
    };
}
