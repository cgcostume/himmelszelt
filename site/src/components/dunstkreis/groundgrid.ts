import { wgsl as dunstkreis } from "@himmelszelt/dunstkreis";
import shader from "./groundgrid.comp.wgsl";
import lines from "./groundgrid.wgsl";

/**
 * The ground's grid for the figures one flies through, for orientation, speed and height: a compute pass that brightens
 * the ground a sky pass drew along thin lines every 10 km, 1 km, 100 m and on down to 1 mm. Site only: no library draws it.
 */

/** The grid's shader functions, for a pass that draws its own ground. Requires dunstkreis' `camera.wgsl`. */
export const GRID_WGSL = lines;
// How much brighter a line makes the ground.
export const GRID_STRENGTH = 0.3;

/** How far the observer has flown, in km east and north, per level of the grid as a share of the level's cell, from
 *  10 km down to 1 mm: worked out here in doubles, since f32 could not tell a millimeter 100 km out. */
export function gridOffsets(flown: { east: number; north: number }) {
    const share = (km: number, cell: number) => (((km / cell) % 1) + 1) % 1;
    return Array.from({ length: 8 }, (_, k) => [
        share(flown.east, 10 ** (1 - k)),
        share(flown.north, 10 ** (1 - k)),
    ]).flat();
}

export interface GridView {
    /** The camera's, as dunstkreis' sky pass takes them. */
    inverseViewProjection: ArrayLike<number>;
    projectionDistance: number;
    heightM: number;
    radiusKm: number;
    flown: { east: number; north: number };
}

/** The pass on `device`: `encode` draws a sky with the grid on its ground. */
export function groundGrid(device: GPUDevice) {
    const uniform = device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const pipelines = new Map<GPUTextureFormat, GPUComputePipeline>();
    const pipelineFor = (format: GPUTextureFormat) => {
        let pipeline = pipelines.get(format);
        if (!pipeline) {
            const code = [dunstkreis.camera, lines, shader.replaceAll("TARGET_FORMAT", format)].join("\n");
            pipeline = device.createComputePipeline({
                label: `sternwarte:groundGrid:${format}`,
                layout: "auto",
                compute: { module: device.createShaderModule({ code }), entryPoint: "groundGrid" },
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
            own = device.createTexture({ label: "sternwarte:groundGrid", size: [width, height], format, usage });
        }
        return own;
    };
    let bound: { sky: GPUTexture; into: GPUTexture; group: GPUBindGroup } | null = null;

    return {
        /** A texture like `target`, a canvas', for the sky to be drawn into: the grid then goes onto `target` itself. */
        skyFor: ownLike,
        /** Draws `sky` with the grid on its ground into `into`, or into a texture of the pass' own, and returns that. */
        encode(encoder: GPUCommandEncoder, sky: GPUTexture, view: GridView, into?: GPUTexture) {
            const target = into ?? ownLike(sky);
            const data = new Float32Array(36);
            data.set(view.inverseViewProjection, 0);
            const heightKm = Math.max(view.heightM, 1) / 1000;
            data.set([view.projectionDistance, heightKm, view.radiusKm, GRID_STRENGTH, ...gridOffsets(view.flown)], 16);
            device.queue.writeBuffer(uniform, 0, data);
            const pipeline = pipelineFor(target.format);
            if (bound?.sky !== sky || bound.into !== target) {
                const group = device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: uniform } },
                        { binding: 1, resource: sky.createView() },
                        { binding: 2, resource: target.createView() },
                    ],
                });
                bound = { sky, into: target, group };
            }
            const pass = encoder.beginComputePass({ label: "sternwarte:groundGrid" });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bound.group);
            pass.dispatchWorkgroups(Math.ceil(target.width / 8), Math.ceil(target.height / 8));
            pass.end();
            return target;
        },
    };
}
