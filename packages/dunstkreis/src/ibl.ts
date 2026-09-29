import { dispatch } from "./luts.js";
import * as wgsl from "./wgsl/index.js";

export interface IrradiancePassOptions {
    /** Edge of each face of the irradiance cube map, in texels, 32 by default: irradiance is smooth. */
    size?: number;
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
     * Records the projection of `source`, a cube map with `TEXTURE_BINDING` usage, and the irradiance from it. With mip
     * levels, the projection reads the one about as fine as its 4096 samples, rather than skipping texels in between.
     * `cubified` for a source written with `SkyPass.encodeCube`'s `cubify`; the irradiance cube map is a plain one.
     */
    encode(encoder: GPUCommandEncoder, source: GPUTexture, options?: { cubified?: boolean }): void;
    /** The nine coefficients, read back from the GPU: 27 floats, rgb after rgb. */
    readSH(): Promise<Float32Array>;
    destroy(): void;
}

/** Creates the pass and its outputs. `source` cube maps are sampled linearly, so any size works. */
export function createIrradiancePass(device: GPUDevice, options: IrradiancePassOptions = {}): IrradiancePass {
    const { size = 32 } = options;
    const module = device.createShaderModule({ code: [wgsl.cube, wgsl.irradiance].join("\n") });
    const projectPipeline = (cubified: boolean) =>
        device.createComputePipeline({
            label: "dunstkreis:projectSH",
            layout: "auto",
            compute: { module, entryPoint: "dkProjectSH", constants: { DK_SOURCE_CUBIFIED: cubified ? 1 : 0 } },
        });
    const projects = [projectPipeline(false), projectPipeline(true)] as const;
    const convolve = device.createComputePipeline({
        label: "dunstkreis:irradianceCube",
        layout: "auto",
        compute: { module, entryPoint: "dkIrradianceCube" },
    });

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
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
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

        encode(encoder, source, { cubified = false } = {}) {
            const project = projects[cubified ? 1 : 0];
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
