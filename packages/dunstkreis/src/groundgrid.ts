import { dispatch } from "./luts.js";
import * as wgsl from "./wgsl/index.js";

/** How much brighter a line of the ground's grid makes the ground, by default. */
export const GROUND_GRID_STRENGTH = 0.3;

/**
 * How far the observer has flown, in km east and north, per level of the ground's grid as a share of the level's cell,
 * from 10 km down to 1 mm, as `wgsl.groundgrid` takes them: worked out in doubles, since f32 could not tell a
 * millimeter 100 km out. Sixteen numbers, two levels to a `vec4f`.
 */
export function groundGridOffsets(flown: { east: number; north: number }): number[] {
    const share = (km: number, cell: number) => (((km / cell) % 1) + 1) % 1;
    return Array.from({ length: 8 }, (_, k) => [
        share(flown.east, 10 ** (1 - k)),
        share(flown.north, 10 ** (1 - k)),
    ]).flat();
}

export interface GroundGridView {
    /** The camera's, as the sky pass takes them. */
    inverseViewProjection: ArrayLike<number>;
    projectionDistance: number;
    heightM: number;
    radiusKm: number;
    /** How far the observer has flown from where the grid started, in km. */
    flown: { east: number; north: number };
    /** How much brighter a line makes the ground, `GROUND_GRID_STRENGTH` by default. */
    strength?: number;
}

/**
 * The ground's grid, for orientation, speed and height in a view one flies through: a compute pass that brightens the
 * ground a sky pass drew along thin lines every 10 km, 1 km, 100 m and on down to 1 mm. A pipeline per target format,
 * made when first drawn into one.
 */
export interface GroundGridPass {
    /** A texture like `target`, a canvas' say, for the sky to be drawn into, the pass' own: the grid then goes onto `target`. */
    skyFor(target: GPUTexture): GPUTexture;
    /**
     * Records the pass into `encoder`: `sky` with the grid on its ground into `into`, or into a texture of the pass' own
     * like `sky`, and returns that. `sky` needs `TEXTURE_BINDING` usage, `into` `STORAGE_BINDING` and the same size;
     * they must differ.
     */
    encode(encoder: GPUCommandEncoder, sky: GPUTexture, view: GroundGridView, into?: GPUTexture): GPUTexture;
    destroy(): void;
}

/** The pass' output binding, which has to spell out the target's format. */
const output = (format: GPUTextureFormat) =>
    `@group(1) @binding(0) var dkGroundGridOutput: texture_storage_2d<${format}, write>;`;

/** Makes a pass that draws the ground's grid over a sky. */
export function createGroundGridPass(device: GPUDevice): GroundGridPass {
    const buffer = device.createBuffer({
        label: "dunstkreis:groundGridView",
        size: 144,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const data = new Float32Array(36);
    const pipelines = new Map<GPUTextureFormat, GPUComputePipeline>();
    const pipelineFor = (format: GPUTextureFormat) => {
        let pipeline = pipelines.get(format);
        if (!pipeline) {
            const code = [wgsl.camera, wgsl.groundgrid, output(format), wgsl.groundgridlayer].join("\n");
            pipeline = device.createComputePipeline({
                label: `dunstkreis:groundGrid:${format}`,
                layout: "auto",
                compute: {
                    module: device.createShaderModule({ label: "dunstkreis:groundGrid", code }),
                    entryPoint: "dkGroundGridPass",
                },
            });
            pipelines.set(format, pipeline);
        }
        return pipeline;
    };
    let own: GPUTexture | null = null;
    const ownLike = ({ width, height, format }: GPUTexture) => {
        if (own?.width !== width || own.height !== height || own.format !== format) {
            own?.destroy();
            const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
            own = device.createTexture({ label: "dunstkreis:groundGrid", size: [width, height], format, usage });
        }
        return own;
    };
    const sources = new WeakMap<GPUTexture, Map<GPUComputePipeline, GPUBindGroup>>();
    const targets = new WeakMap<GPUTexture, GPUBindGroup>();

    return {
        skyFor: ownLike,
        encode(encoder, sky, view, into) {
            const target = into ?? ownLike(sky);
            data.set(view.inverseViewProjection, 0);
            const heightKm = Math.max(view.heightM, 1) / 1000;
            const strength = view.strength ?? GROUND_GRID_STRENGTH;
            data.set(
                [view.projectionDistance, heightKm, view.radiusKm, strength, ...groundGridOffsets(view.flown)],
                16,
            );
            device.queue.writeBuffer(buffer, 0, data);
            const pipeline = pipelineFor(target.format);
            // A layout "auto" is a pipeline's own, so the sky's group is kept per pipeline, which is per format.
            const byPipeline = sources.get(sky) ?? new Map<GPUComputePipeline, GPUBindGroup>();
            sources.set(sky, byPipeline);
            let source = byPipeline.get(pipeline);
            if (!source) {
                source = device.createBindGroup({
                    label: "dunstkreis:groundGridSky",
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer } },
                        { binding: 1, resource: sky.createView() },
                    ],
                });
                byPipeline.set(pipeline, source);
            }
            let out = targets.get(target);
            if (!out) {
                out = device.createBindGroup({
                    label: "dunstkreis:groundGridTarget",
                    layout: pipeline.getBindGroupLayout(1),
                    entries: [{ binding: 0, resource: target.createView() }],
                });
                targets.set(target, out);
            }
            const pass = encoder.beginComputePass({ label: "dunstkreis:groundGrid" });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, source);
            pass.setBindGroup(1, out);
            pass.dispatchWorkgroups(dispatch(target.width), dispatch(target.height));
            pass.end();
            return target;
        },
        destroy() {
            buffer.destroy();
            own?.destroy();
            own = null;
        },
    };
}
