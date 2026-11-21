import type { Air } from "./air.js";
import { dispatch } from "./luts.js";
import { type Seeing, seeingUniformData, shimmerScales } from "./seeing.js";
import * as wgsl from "./wgsl/index.js";

type Vec3 = readonly [number, number, number];
const DEG = Math.PI / 180;

/** How much more the air bends blue than red, as a share of the bend: `DK_AIR_DISPERSION` in `wgsl.air`. */
export const AIR_DISPERSION = 0.0114;

/** The two parts of the shimmer's motion and its colors, each 1 as the air does, 0 for none. */
export interface ShimmerParts {
    /** The large waves, which move patches of the image as a whole. */
    motion?: number;
    /** The small waves, which make it boil. */
    boiling?: number;
    /** How far the air's dispersion spreads the colors apart, blue over red. */
    dispersion?: number;
}

/** Everything that can change per frame. */
export interface ShimmerParams extends Required<ShimmerParts> {
    /** Towards the body where it shows, lifted by the air (`liftedDirection`), ENU, unit length: the turbulence's
     *  scales are taken there, the same for the whole layer. */
    direction: Vec3;
    /** How far from `direction` the layer holds anything, in degrees, `shimmerReach`: the pass leaves the rest as it
     *  is. 180 by default, the whole target. */
    reach: number;
    /** The air's steadiness and the lens looking through it. The exposure is not used: the shimmer is one short one. */
    seeing: Seeing;
    /** The turbulence's clock, in seconds. */
    time: number;
    /** The camera, as the sky pass takes it. */
    inverseViewProjection: Float32Array;
    projectionDistance: number;
}

/**
 * How far the shimmer moves anything at most, in degrees, for the air at the body's lowest point, `airAt`: its waves
 * together at most ten times the tilt, and the colors' spread.
 */
export function shimmerExtent(seeing: Seeing, air: Air, parts: ShimmerParts = {}): number {
    const { motion = 1, boiling = 1, dispersion = 1 } = parts;
    return (
        (10 * shimmerScales(seeing, air.seeing).tilt * Math.max(motion, boiling)) / DEG +
        AIR_DISPERSION * air.bend * air.dilution * dispersion
    );
}

/**
 * How far around a body the shimmer pass has to work, for its `reach`, in degrees: the body's radius with room for the
 * air's squeeze, a few pixels, and what the shimmer moves.
 */
export function shimmerReach(
    seeing: Seeing,
    air: Air,
    radius: number,
    pixel: number,
    parts: ShimmerParts = {},
): number {
    return 1.3 * radius + 4 * pixel + shimmerExtent(seeing, air, parts);
}

/**
 * Whether the shimmer moves an image by a tenth of a pixel or more, its tilt thrice or its colors apart, for a pixel of
 * `pixel` degrees: less shows on no screen, and the pass can be left out.
 */
export function shimmerShows(seeing: Seeing, air: Air, pixel: number, parts: ShimmerParts = {}): boolean {
    const { motion = 1, boiling = 1, dispersion = 1 } = parts;
    const tilt = shimmerScales(seeing, air.seeing).tilt / DEG;
    return Math.max(3 * tilt * Math.max(motion, boiling), 0.0078 * air.bend * air.dilution * dispersion) >= 0.1 * pixel;
}

/** The size of the pass' `DkShimmerParams` uniform block, in bytes. */
const PARAMS_SIZE = 144;

/** The pass' output binding, which has to spell out the target's format. */
const output = (format: GPUTextureFormat) =>
    `@group(1) @binding(0) var dkShimmerOutput: texture_storage_2d<${format}, write>;`;

export interface ShimmerPassOptions {
    /** The target's format, rgba16float by default; rgba32float for light brighter than half floats hold. */
    format?: GPUTextureFormat;
}

/**
 * The air's shimmer over a layer: a compute pass that reads an image drawn without it, the Moon, the Sun's disc, a
 * planet, a satellite, and writes it as a camera takes it through the air in one short exposure, moved about by the
 * turbulence and its colors spread by the dispersion. Linear in, linear out: draw the layer over the sky and expose
 * it afterwards.
 */
export interface ShimmerPass {
    update(params: Partial<ShimmerParams>): void;
    /**
     * Records the pass into `encoder`. `layer` holds the image, its light linear and premultiplied in rgb and its
     * coverage in alpha, a filterable float format such as rgba16float, with `TEXTURE_BINDING` usage, on the camera of
     * `update` and the size of `target`. `air` is the air table's texture, `createAirTexture`. `target` needs
     * `STORAGE_BINDING` usage and the format the pass was made for; it must not be the layer.
     */
    encode(encoder: GPUCommandEncoder, layer: GPUTexture, air: GPUTexture, target: GPUTexture): void;
    destroy(): void;
}

/** Makes a shimmer pass, its pipeline compiled without blocking. */
export async function createShimmerPass(device: GPUDevice, options: ShimmerPassOptions = {}): Promise<ShimmerPass> {
    const format = options.format ?? "rgba16float";
    const code = [wgsl.camera, wgsl.air, wgsl.seeing, wgsl.shimmer, output(format), wgsl.shimmerlayer].join("\n");
    const pipeline = await device.createComputePipelineAsync({
        label: "dunstkreis:shimmer",
        layout: "auto",
        compute: {
            module: device.createShaderModule({ label: "dunstkreis:shimmer", code }),
            entryPoint: "dkShimmerLayerPass",
        },
    });
    const buffer = device.createBuffer({
        label: "dunstkreis:shimmerParams",
        size: PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const sampler = device.createSampler({
        label: "dunstkreis:shimmerLayer",
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
    });
    const params: ShimmerParams = {
        direction: [0, 0, 1],
        reach: 180,
        seeing: {},
        time: 0,
        motion: 1,
        boiling: 1,
        dispersion: 1,
        inverseViewProjection: new Float32Array(16),
        projectionDistance: 0,
    };
    const data = new Float32Array(PARAMS_SIZE / 4);
    const sources = new WeakMap<GPUTexture, WeakMap<GPUTexture, GPUBindGroup>>();
    const targets = new WeakMap<GPUTexture, GPUBindGroup>();

    return {
        update(changed) {
            Object.assign(params, changed);
            data.set(params.inverseViewProjection, 0);
            data.set(params.direction, 16);
            data[19] = params.reach >= 180 ? 3 : 2 * Math.sin((Math.max(params.reach, 0) * DEG) / 2);
            data.set([params.time, params.motion, params.boiling, params.dispersion], 20);
            seeingUniformData(params.seeing, data.subarray(24, 32));
            data[32] = params.projectionDistance;
            device.queue.writeBuffer(buffer, 0, data);
        },
        encode(encoder, layer, air, target) {
            const byAir = sources.get(layer) ?? new WeakMap<GPUTexture, GPUBindGroup>();
            sources.set(layer, byAir);
            let source = byAir.get(air);
            if (!source) {
                source = device.createBindGroup({
                    label: "dunstkreis:shimmerSource",
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer } },
                        { binding: 1, resource: layer.createView() },
                        { binding: 2, resource: sampler },
                        { binding: 3, resource: air.createView() },
                    ],
                });
                byAir.set(air, source);
            }
            let into = targets.get(target);
            if (!into) {
                into = device.createBindGroup({
                    label: "dunstkreis:shimmerTarget",
                    layout: pipeline.getBindGroupLayout(1),
                    entries: [{ binding: 0, resource: target.createView() }],
                });
                targets.set(target, into);
            }
            const pass = encoder.beginComputePass({ label: "dunstkreis:shimmer" });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, source);
            pass.setBindGroup(1, into);
            pass.dispatchWorkgroups(dispatch(target.width), dispatch(target.height));
            pass.end();
        },
        destroy() {
            buffer.destroy();
        },
    };
}
