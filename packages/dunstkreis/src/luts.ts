import {
    type AtmosphereModel,
    DEFAULT_ATMOSPHERE_MODEL,
    DEFAULT_TEXTURE_CONFIG,
    type PrecomputedTextureConfig,
} from "./model.js";
import type { AtmosphereLUTs } from "./pass.js";
import { pipelineConstants, refractionConstants } from "./quality.js";
import { ATMOSPHERE_UNIFORM_SIZE, atmosphereUniformData } from "./uniforms.js";
import * as wgsl from "./wgsl/index.js";

/** rgba16float everywhere: enough range for physical radiance, half the bandwidth of rgba32float. */
const LUT_FORMAT: GPUTextureFormat = "rgba16float";

const WORKGROUP = 8;
export const dispatch = (n: number) => Math.ceil(n / WORKGROUP);

export interface PrecomputeOptions {
    model?: AtmosphereModel;
    config?: PrecomputedTextureConfig;
}

export function createLut(device: GPUDevice, label: string, width: number, height: number): GPUTexture {
    // GPUTextureUsage and friends are read inside functions, never at module scope: importing this package
    // must not require the WebGPU globals to exist yet, so it stays safe to import in Node or during SSR.
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;

    return device.createTexture({ label, size: { width, height }, format: LUT_FORMAT, usage });
}

/**
 * Precomputes the transmittance and multiple-scattering tables, after Hillaire 2020. Cheap enough to re-run
 * whenever a model parameter changes.
 *
 * Neither table depends on the sun or the observer, so this runs once per model, not per frame. Resolves once the
 * pipelines are compiled, without blocking on them, and the work is submitted; whatever reads the tables after it is
 * queued behind it, so there is nothing to wait for. `device.queue.onSubmittedWorkDone()` tells when it ran.
 */
export async function precomputeAtmosphere(
    device: GPUDevice,
    options: PrecomputeOptions = {},
): Promise<AtmosphereLUTs> {
    const model = options.model ?? DEFAULT_ATMOSPHERE_MODEL;
    const config = options.config ?? DEFAULT_TEXTURE_CONFIG;
    const constants = { ...pipelineConstants(config), ...refractionConstants(model) };

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

    const transmittancePipeline = device.createComputePipelineAsync({
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

    const multiScatteringPipeline = device.createComputePipelineAsync({
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

    const [transmittanceStep, multiScatteringStep] = await Promise.all([
        transmittancePipeline,
        multiScatteringPipeline,
    ]);
    const encoder = device.createCommandEncoder({ label: "dunstkreis:precompute" });

    // Transmittance first: the multiple-scattering pass reads it, and both run in one submission because
    // WebGPU orders passes within a queue, so no explicit barrier is needed between them.
    const transmittancePass = encoder.beginComputePass();
    transmittancePass.setPipeline(transmittanceStep);
    transmittancePass.setBindGroup(
        0,
        device.createBindGroup({
            layout: transmittanceStep.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: atmosphereBuffer } },
                { binding: 1, resource: transmittance.createView() },
            ],
        }),
    );
    transmittancePass.dispatchWorkgroups(dispatch(config.transmittance.width), dispatch(config.transmittance.height));
    transmittancePass.end();

    const multiScatteringPass = encoder.beginComputePass();
    multiScatteringPass.setPipeline(multiScatteringStep);
    multiScatteringPass.setBindGroup(
        0,
        device.createBindGroup({
            layout: multiScatteringStep.getBindGroupLayout(0),
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
