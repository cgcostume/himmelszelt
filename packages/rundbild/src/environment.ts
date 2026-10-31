import type { PanoramaProjection } from "./panorama.js";
import * as wgsl from "./wgsl/index.js";

const PROJECTIONS = { equirectangular: 1, octahedral: 2, fisheye: 3, sphere: 4 } as const;
const FORMAT = "rgba16float";
const dispatch = (n: number) => Math.ceil(n / 8);

const face = (texture: GPUTexture, mip: number) =>
    texture.createView({ dimension: "2d-array", baseMipLevel: mip, mipLevelCount: 1 });

/** The pipeline for one entry point: only what it reads is bound, so "auto" fits each. */
function pipelineFor(device: GPUDevice, entryPoint: string, constants: Record<string, number>) {
    return device.createComputePipelineAsync({
        label: `rundbild:${entryPoint}`,
        layout: "auto",
        compute: {
            module: device.createShaderModule({
                code: [wgsl.cube, wgsl.panorama, wgsl.cubeOutput(FORMAT), wgsl.environment].join("\n"),
            }),
            entryPoint,
            constants,
        },
    });
}

/** Records the levels below the first of a cube map with more than one, each texel the mean of four in the level above. */
function encodeMips(
    device: GPUDevice,
    pass: GPUComputePassEncoder,
    pipeline: GPUComputePipeline,
    sampler: GPUSampler,
    target: GPUTexture,
) {
    pass.setPipeline(pipeline);
    for (let mip = 1; mip < target.mipLevelCount; ++mip) {
        pass.setBindGroup(
            0,
            device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    {
                        binding: 2,
                        resource: target.createView({ dimension: "cube", baseMipLevel: mip - 1, mipLevelCount: 1 }),
                    },
                    { binding: 1, resource: sampler },
                    { binding: 4, resource: face(target, mip) },
                ],
            }),
        );
        const size = Math.max(1, target.width >> mip);
        pass.dispatchWorkgroups(dispatch(size), dispatch(size), 6);
    }
}

export interface CubeFromPanoramaOptions {
    /** How the panorama lays out the sphere, equirectangular by default, as HDRIs are shared. */
    projection?: PanoramaProjection;
    /** Turns it about the zenith, in degrees: the azimuth at the equirectangular's left edge, 0 by default, north. */
    azimuthOffset?: number;
    /** Lookups per texel of the cube map, 1 by default: more when the panorama is the finer of the two. */
    samples?: number;
    /** Spread the cube map's texels evenly over the sphere, see `wgsl.cube`. */
    cubify?: boolean;
}

/** A pass that writes a panorama, rgba16float, into a cube map, as `createPanoramaPass` does the other way. */
export interface CubeFromPanoramaPass {
    /**
     * Records `source` into `target`, rgba16float, a square 2D texture with six layers and `STORAGE_BINDING` usage. One
     * with more than one mip level gets them all, which reads the level above: `TEXTURE_BINDING` too.
     */
    encode(encoder: GPUCommandEncoder, source: GPUTexture, target: GPUTexture): void;
}

export async function createCubeFromPanoramaPass(
    device: GPUDevice,
    options: CubeFromPanoramaOptions = {},
): Promise<CubeFromPanoramaPass> {
    const { projection = "equirectangular", azimuthOffset = 0, samples = 1, cubify = false } = options;
    const [pipeline, mips] = await Promise.all([
        pipelineFor(device, "rbCubeFromPanorama", {
            RB_PROJECTION: PROJECTIONS[projection],
            RB_AZIMUTH_OFFSET: (azimuthOffset * Math.PI) / 180,
            RB_SAMPLES: samples,
            RB_CUBIFY: cubify ? 1 : 0,
        }),
        pipelineFor(device, "rbCubeMip", {}),
    ]);
    // Around the panorama's seam, and at its top and bottom held.
    const sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "repeat",
        addressModeV: "clamp-to-edge",
    });
    return {
        encode(encoder, source, target) {
            const pass = encoder.beginComputePass({ label: "rundbild:cubeFromPanorama" });
            pass.setPipeline(pipeline);
            pass.setBindGroup(
                0,
                device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: source.createView() },
                        { binding: 1, resource: sampler },
                        { binding: 4, resource: face(target, 0) },
                    ],
                }),
            );
            pass.dispatchWorkgroups(dispatch(target.width), dispatch(target.width), 6);
            encodeMips(device, pass, mips, sampler, target);
            pass.end();
        },
    };
}

export interface EnvironmentBlendOptions {
    /** Whether the first and the second cube map read are cubified, and the one written. */
    aCubified?: boolean;
    bCubified?: boolean;
    cubify?: boolean;
}

/**
 * Fades one environment into another, by their light: for a sky in cd/m² and an HDRI of relative values, scale them to a
 * common unit first. The nine coefficients of the result are those of the two mixed by the same t: see `mixCoefficients`.
 */
export interface EnvironmentBlendPass {
    /**
     * Records `a` and `b`, rgba16float cube maps of any size with `TEXTURE_BINDING` usage, into `target`, as
     * `CubeFromPanoramaPass` takes it, at `t` from 0, all a, to 1, all b. `scaleA` and `scaleB` multiply their light first.
     */
    encode(
        encoder: GPUCommandEncoder,
        a: GPUTexture,
        b: GPUTexture,
        target: GPUTexture,
        t: number,
        scales?: { a?: number; b?: number },
    ): void;
    destroy(): void;
}

export async function createEnvironmentBlendPass(
    device: GPUDevice,
    options: EnvironmentBlendOptions = {},
): Promise<EnvironmentBlendPass> {
    const [pipeline, mips] = await Promise.all([
        pipelineFor(device, "rbBlend", {
            RB_CUBIFY: options.cubify ? 1 : 0,
            RB_A_CUBIFIED: options.aCubified ? 1 : 0,
            RB_B_CUBIFIED: options.bCubified ? 1 : 0,
        }),
        pipelineFor(device, "rbCubeMip", {}),
    ]);
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const cube = (texture: GPUTexture) => texture.createView({ dimension: "cube" });
    return {
        encode(encoder, a, b, target, t, scales = {}) {
            device.queue.writeBuffer(uniform, 0, new Float32Array([t, scales.a ?? 1, scales.b ?? 1, 0]));
            const pass = encoder.beginComputePass({ label: "rundbild:blend" });
            pass.setPipeline(pipeline);
            pass.setBindGroup(
                0,
                device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 1, resource: sampler },
                        { binding: 2, resource: cube(a) },
                        { binding: 3, resource: cube(b) },
                        { binding: 4, resource: face(target, 0) },
                        { binding: 5, resource: { buffer: uniform } },
                    ],
                }),
            );
            pass.dispatchWorkgroups(dispatch(target.width), dispatch(target.width), 6);
            encodeMips(device, pass, mips, sampler, target);
            pass.end();
        },
        destroy() {
            uniform.destroy();
        },
    };
}

/** Spherical harmonics coefficients of two environments mixed: light adds, so the coefficients do as well. */
export function mixCoefficients(a: ArrayLike<number>, b: ArrayLike<number>, t: number): Float32Array {
    return Float32Array.from({ length: a.length }, (_, i) => (a[i] as number) * (1 - t) + (b[i] as number) * t);
}
