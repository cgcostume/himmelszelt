import { dispatch } from "./luts.js";
import * as wgsl from "./wgsl/index.js";

export interface IrradiancePassOptions {
    /** Edge of each face of the irradiance cube map, in texels, 32 by default: irradiance is smooth. */
    size?: number;
    /** Whether the source cube maps are cubified, written by a sky cube pass with `cubify`. */
    cubified?: boolean;
    /**
     * The source cube maps' format, rgba16float by default. rgba32float is read through a nearest sampler unless the
     * device has the "float32-filterable" feature.
     */
    sourceFormat?: GPUTextureFormat;
}

/**
 * Diffuse image-based lighting from a cube map in cd/m², the sky's from `SkyPass.encodeCube` or any other: its nine
 * spherical harmonics coefficients and an irradiance cube map computed from them. Not tied to the atmosphere, so an HDR
 * environment map works as well.
 */
export interface IrradiancePass {
    /**
     * Nine coefficients of the radiance in real spherical harmonics up to order 2, rgb each, padded to four floats:
     * (l, m) = (0, 0), (1, -1), (1, 0), (1, 1), (2, -2), (2, -1), (2, 0), (2, 1), (2, 2), over ENU directions. Bind it
     * as `array<vec4f, 9>` to shade with them directly.
     */
    readonly sh: GPUBuffer;
    /**
     * The irradiance in lux for every normal, a cube map, rgba16float, with every mip level down to 1 texel, each computed
     * from the coefficients rather than averaged. A white Lambertian surface shows it over pi.
     */
    readonly irradiance: GPUTexture;
    /**
     * Records the projection of `source`, a cube map of the pass' source format with `TEXTURE_BINDING` usage, and the
     * irradiance from it. With mip levels, the projection reads the one about as fine as its 4096 samples, rather than
     * skipping texels in between. The irradiance cube map is a plain one, whether the source is cubified or not.
     */
    encode(encoder: GPUCommandEncoder, source: GPUTexture): void;
    /** The nine coefficients, read back from the GPU: 27 floats, rgb after rgb. */
    readSH(): Promise<Float32Array>;
    destroy(): void;
}

/**
 * Creates the pass and its outputs, its pipelines compiled without blocking. Source cube maps are sampled linearly,
 * so any size works.
 */
export async function createIrradiancePass(
    device: GPUDevice,
    options: IrradiancePassOptions = {},
): Promise<IrradiancePass> {
    const { size = 32, cubified = false, sourceFormat = "rgba16float" } = options;
    const filterable = sourceFormat !== "rgba32float" || device.features.has("float32-filterable");
    const reduce = wgsl.workgroupSum(64, device.features.has("subgroups"));
    const module = device.createShaderModule({ code: [reduce, wgsl.cube, wgsl.irradiance].join("\n") });
    // The source's layout spelled out, since "auto" would take any float texture as filterable.
    const sourceLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                texture: { sampleType: filterable ? "float" : "unfilterable-float", viewDimension: "cube" },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.COMPUTE,
                sampler: { type: filterable ? "filtering" : "non-filtering" },
            },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ],
    });
    const [project, convolve] = await Promise.all([
        device.createComputePipelineAsync({
            label: "dunstkreis:projectSH",
            layout: device.createPipelineLayout({ bindGroupLayouts: [sourceLayout] }),
            compute: { module, entryPoint: "dkProjectSH", constants: { DK_SOURCE_CUBIFIED: cubified ? 1 : 0 } },
        }),
        device.createComputePipelineAsync({
            label: "dunstkreis:irradianceCube",
            layout: "auto",
            compute: { module, entryPoint: "dkIrradianceCube" },
        }),
    ]);

    const sh = device.createBuffer({
        label: "dunstkreis:sh",
        size: 9 * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const irradiance = device.createTexture({
        label: "dunstkreis:irradiance",
        size: { width: size, height: size, depthOrArrayLayers: 6 },
        mipLevelCount: Math.floor(Math.log2(size)) + 1,
        format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        textureBindingViewDimension: "cube",
    });
    const linear = filterable ? "linear" : "nearest";
    const sampler = device.createSampler({ magFilter: linear, minFilter: linear, mipmapFilter: linear });
    const convolveBindGroups = Array.from({ length: irradiance.mipLevelCount }, (_, level) =>
        device.createBindGroup({
            layout: convolve.getBindGroupLayout(0),
            entries: [
                { binding: 2, resource: { buffer: sh } },
                {
                    binding: 3,
                    resource: irradiance.createView({ dimension: "2d-array", baseMipLevel: level, mipLevelCount: 1 }),
                },
            ],
        }),
    );

    return {
        sh,
        irradiance,

        encode(encoder, source) {
            if (source.format !== sourceFormat) {
                throw new Error(`dunstkreis: this irradiance pass reads ${sourceFormat}, not ${source.format}`);
            }
            const projectBindGroup = device.createBindGroup({
                layout: project.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: source.createView({ dimension: "cube" }) },
                    { binding: 1, resource: sampler },
                    { binding: 2, resource: { buffer: sh } },
                ],
            });
            const pass = encoder.beginComputePass({ label: "dunstkreis:irradiance" });
            pass.setPipeline(project);
            pass.setBindGroup(0, projectBindGroup);
            pass.dispatchWorkgroups(1);
            pass.setPipeline(convolve);
            convolveBindGroups.forEach((bindGroup, level) => {
                pass.setBindGroup(0, bindGroup);
                pass.dispatchWorkgroups(dispatch(size >> level), dispatch(size >> level), 6);
            });
            pass.end();
        },

        async readSH() {
            const staging = device.createBuffer({
                size: 9 * 16,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            });
            const encoder = device.createCommandEncoder({ label: "dunstkreis:shReadback" });
            encoder.copyBufferToBuffer(sh, 0, staging, 0, 9 * 16);
            device.queue.submit([encoder.finish()]);
            await staging.mapAsync(GPUMapMode.READ);
            const padded = new Float32Array(staging.getMappedRange().slice(0));
            staging.destroy();
            return Float32Array.from({ length: 27 }, (_, i) => padded[Math.floor(i / 3) * 4 + (i % 3)] as number);
        },

        destroy() {
            sh.destroy();
            irradiance.destroy();
        },
    };
}
