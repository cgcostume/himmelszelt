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
    /** Format of the render target the caller will draw into. */
    format: GPUTextureFormat;
    /** Compile the refraction ray warp into the pipeline. Default true. */
    refraction?: boolean;
    /** Dither the output against banding, for an 8-bit target. Default true; turn it off for a float target. */
    dither?: boolean;
    /** Draw the debug overlay: altitude lines every 10 degrees, the compass directions and a ring around the Sun. */
    debugGrid?: boolean;
}

/** Byte size of DkSkyParams: a mat4x4, three vec3-plus-scalar pairs and four loose scalars. */
const SKY_PARAMS_SIZE = 128;
/** Byte size of DkSkyViewParams: one vec3 plus a scalar. */
const SKY_VIEW_PARAMS_SIZE = 16;

const DEFAULTS: SkyParams = {
    sunDirection: [0, 0, 1],
    observerHeightM: MIN_OBSERVER_HEIGHT_M,
    inverseViewProjection: new Float32Array(16),
    exposure: 10,
    sunAngularDiameter: 0.533,
    projectionDistance: 0,
    refraction: {},
    // Off: added after tone mapping, it paints over the blue the ozone already gives twilight. osgHimmel used 0.5.
    lHeureBleue: { color: [0.08, 0.3, 0.7], intensity: 0 },
};

/**
 * A sky pass for the fast variant. Owns the per-frame sky-view table and the render pipeline, and nothing
 * else: no device, no canvas, no context, no render pass of its own.
 *
 * `update()` rebuilds the sky-view table only when the sun or the observer moved; a camera move just rewrites the
 * uniforms. `encode()` then costs one texture fetch per pixel.
 */
export function createSkyPassApprox(device: GPUDevice, options: SkyPassOptions): SkyPass {
    const { luts, format } = options;
    const { config } = luts;
    const { refraction = true, dither = true, debugGrid = false } = options;
    const constants = pipelineConstants(config, { refraction, dither, debugGrid });

    const skyView = createLut(device, "dunstkreis:skyView", config.skyView.width, config.skyView.height);

    const skyViewParams = device.createBuffer({
        label: "dunstkreis:skyViewParams",
        size: SKY_VIEW_PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
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

    const renderModule = device.createShaderModule({
        code: [
            wgsl.quality,
            wgsl.atmosphere,
            wgsl.common,
            wgsl.lut,
            wgsl.sampling,
            wgsl.raymarch,
            wgsl.refraction,
            wgsl.sky,
        ].join("\n"),
    });
    const renderPipeline = device.createRenderPipeline({
        label: "dunstkreis:sky",
        layout: "auto",
        vertex: { module: renderModule, entryPoint: "dkSkyVertex", constants },
        fragment: { module: renderModule, entryPoint: "dkSkyFragment", targets: [{ format }], constants },
        primitive: { topology: "triangle-list" },
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

    const renderBindGroup = device.createBindGroup({
        layout: renderPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: luts.atmosphereBuffer } },
            { binding: 1, resource: { buffer: skyParams } },
            { binding: 2, resource: luts.transmittance.createView() },
            { binding: 3, resource: skyView.createView() },
            { binding: 4, resource: luts.sampler },
            { binding: 5, resource: luts.multiScattering.createView() },
        ],
    });

    let params: SkyParams = { ...DEFAULTS };
    let skyViewKey = "";

    return {
        skyViewTexture: skyView,

        update(next) {
            params = { ...params, ...next };

            const [sx, sy, sz] = params.sunDirection;
            // Held off the ground, which is degenerate. Above the atmosphere the render pass raymarches per pixel; the
            // table, which only it reads, is then left at the top.
            const height = Math.max(params.observerHeightM, MIN_OBSERVER_HEIGHT_M);
            const altitudeKm = Math.min(height / 1000, luts.model.planet.thicknessKm);

            const conditions = params.refraction === false ? {} : params.refraction;
            const sky = new Float32Array(SKY_PARAMS_SIZE / 4);
            sky.set(params.inverseViewProjection, 0);
            sky.set([sx, sy, sz], 16);
            sky[19] = height / 1000;
            sky.set(params.lHeureBleue.color, 20);
            sky[23] = params.lHeureBleue.intensity;
            sky[24] = params.exposure;
            sky[25] = (params.sunAngularDiameter / 2) * (Math.PI / 180);
            sky[26] = conditions.observerHeightM ?? height;
            sky[27] = conditions.temperatureC ?? 10;
            // Where the sun shows, for the debug overlay's ring: lifted by refraction where the pass applies it.
            const refracts = refraction && params.refraction !== false;
            const lifted = { observerHeightM: height, ...conditions };
            sky.set(refracts ? apparentDirection(params.sunDirection, lifted) : [sx, sy, sz], 28);
            sky[31] = params.projectionDistance;
            device.queue.writeBuffer(skyParams, 0, sky);

            // Rebuilding the sky-view table is the expensive part, and it is why the render pass itself is one fetch
            // per pixel rather than a raymarch. It depends on nothing but the Sun and the observer.
            const key = `${sx},${sy},${sz},${altitudeKm}`;
            if (key === skyViewKey) return;
            skyViewKey = key;
            device.queue.writeBuffer(skyViewParams, 0, new Float32Array([sx, sy, sz, altitudeKm]));
            const encoder = device.createCommandEncoder({ label: "dunstkreis:skyView" });
            const pass = encoder.beginComputePass();
            pass.setPipeline(skyViewPipeline);
            pass.setBindGroup(0, skyViewBindGroup);
            pass.dispatchWorkgroups(dispatch(config.skyView.width), dispatch(config.skyView.height));
            pass.end();
            device.queue.submit([encoder.finish()]);
        },

        encode(pass) {
            pass.setPipeline(renderPipeline);
            pass.setBindGroup(0, renderBindGroup);
            pass.draw(3);
        },

        destroy() {
            skyView.destroy();
            skyViewParams.destroy();
            skyParams.destroy();
        },
    };
}
