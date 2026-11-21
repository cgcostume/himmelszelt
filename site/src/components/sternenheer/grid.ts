import { wgsl } from "@himmelszelt/dunstkreis";

// dunstkreis' grid alone, over black, for the stars figure without the air, where no sky pass draws it.
const SHADER = /* wgsl */ `
struct GridParams {
    inverseViewProjection: mat4x4f,
    sun: vec3f,
    sunAngularRadius: f32,
    ink: f32,
    projectionDistance: f32,
    pixelRatio: f32,
}
@group(0) @binding(0) var<uniform> params: GridParams;
@group(0) @binding(1) var output: texture_storage_2d<rgba32float, write>;

fn gridRay(pixel: vec2u, size: vec2u) -> vec3f {
    let uv = (vec2f(pixel) + 0.5) / vec2f(size);
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    return dkProjectRay(params.inverseViewProjection, ndc, params.projectionDistance);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(output);
    if (any(id.xy >= size)) {
        return;
    }
    let view = gridRay(id.xy, size);
    let right = gridRay(id.xy + vec2u(1u, 0u), size);
    let below = gridRay(id.xy + vec2u(0u, 1u), size);
    let coverage = dkGridCoverage(view, right, below, params.sun, params.sunAngularRadius, params.pixelRatio);
    textureStore(output, id.xy, vec4f(vec3f(params.ink * coverage / DK_GRID_FAINT), 0.0));
}
`;

export interface GridFrame {
    inverseViewProjection: Float32Array;
    projectionDistance: number;
    pixelRatio: number;
    sunDirection: ArrayLike<number>;
    /** In degrees, as the sky pass takes it. */
    sunAngularDiameter: number;
    /** The luminance the grid is drawn in, as the sky pass' `gridInk`. */
    ink: number;
}

/** A compute pass that writes dunstkreis' grid over black into an rgba32float texture. */
export function createGridPass(device: GPUDevice) {
    const module = device.createShaderModule({ label: "sternwarte:grid", code: wgsl.camera + wgsl.grid + SHADER });
    const pipeline = device.createComputePipeline({ label: "sternwarte:grid", layout: "auto", compute: { module } });
    const uniforms = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const data = new Float32Array(24);
    return {
        encode(encoder: GPUCommandEncoder, target: GPUTexture, frame: GridFrame) {
            data.set(frame.inverseViewProjection, 0);
            data.set(Array.from(frame.sunDirection).slice(0, 3), 16);
            data[19] = ((frame.sunAngularDiameter / 2) * Math.PI) / 180;
            data[20] = frame.ink;
            data[21] = frame.projectionDistance;
            data[22] = frame.pixelRatio;
            device.queue.writeBuffer(uniforms, 0, data);
            const group = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: uniforms } },
                    { binding: 1, resource: target.createView() },
                ],
            });
            const pass = encoder.beginComputePass({ label: "sternwarte:grid" });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(Math.ceil(target.width / 8), Math.ceil(target.height / 8));
            pass.end();
        },
    };
}
