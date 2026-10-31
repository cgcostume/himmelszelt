import type { ToneCurve } from "@himmelszelt/helldunkel";
import { wgsl } from "@himmelszelt/helldunkel";

/** What is left once a linear, exposed image is done with: the tone curve, and a step of noise for an 8-bit target. */
const SOURCE = (format: GPUTextureFormat) => /* wgsl */ `
${wgsl.tonemap}
struct Params { curve: u32, headroom: f32, dither: u32, free: u32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var output: texture_storage_2d<${format}, write>;

fn curve(exposed: vec3f) -> vec3f {
    switch params.curve {
        case 2u: { return hdToneMapAgx(exposed); }
        case 3u: { return hdToneMapAces(exposed); }
        case 4u: { return hdToneMapClipHdr(exposed, params.headroom); }
        default: { return hdToneMapNeutralHdr(exposed, params.headroom); }
    }
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(output))) {
        return;
    }
    var color = curve(textureLoad(source, id.xy, 0).rgb);
    if (params.dither != 0u) {
        color = hdDither(color, id.xy, 255.0);
    }
    textureStore(output, vec2i(id.xy), vec4f(color, 1.0));
}`;

export function createDisplay(device: GPUDevice) {
    const pipelines = new Map<GPUTextureFormat, GPUComputePipeline>();
    const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return {
        /** Records `source`, exposed and linear, through a tone curve into `target`, of the same size. */
        encode(
            encoder: GPUCommandEncoder,
            source: GPUTexture,
            target: GPUTexture,
            options: { toneCurve: ToneCurve; headroom: number; dither: boolean },
        ) {
            let pipeline = pipelines.get(target.format);
            if (!pipeline) {
                pipeline = device.createComputePipeline({
                    label: "sternwarte:display",
                    layout: "auto",
                    compute: {
                        module: device.createShaderModule({ code: SOURCE(target.format) }),
                        entryPoint: "main",
                    },
                });
                pipelines.set(target.format, pipeline);
            }
            const data = new ArrayBuffer(16);
            new Uint32Array(data).set([
                { neutral: 1, agx: 2, aces: 3, clip: 4 }[options.toneCurve],
                0,
                options.dither ? 1 : 0,
            ]);
            new Float32Array(data)[1] = options.headroom;
            device.queue.writeBuffer(params, 0, data);
            const pass = encoder.beginComputePass({ label: "sternwarte:display" });
            pass.setPipeline(pipeline);
            pass.setBindGroup(
                0,
                device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: params } },
                        { binding: 1, resource: source.createView() },
                        { binding: 2, resource: target.createView() },
                    ],
                }),
            );
            pass.dispatchWorkgroups(Math.ceil(target.width / 8), Math.ceil(target.height / 8));
            pass.end();
        },
    };
}
