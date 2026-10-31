import { wgsl } from "@himmelszelt/helldunkel";
import { find } from "../dom";
import { gpu, gpuDevice } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import blueNoiseUrl from "../scene/bluenoise.bin?url";

const root = find("#banding");
const SOURCE = /* wgsl */ `
${wgsl.tonemap}
struct Params { levels: f32, gradient: u32, gain: f32, intensity: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var blueNoise: texture_2d<f32>;

// White noise from Jarzynski and Olano's PCG hash of the pixel, on integers, unlike the sine of a dot product that shaders
// long passed around, which falls apart with the GPU's float precision.
fn white(p: vec2u) -> f32 {
    var v = p.x + p.y * 4096u;
    v = v * 747796405u + 2891336453u;
    let word = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
    return f32((word >> 22u) ^ word) / 4294967296.0;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(output);
    if (any(id.xy >= size)) {
        return;
    }
    let t = (f32(id.x) + 0.5) / f32(size.x);
    var color = mix(vec3f(0.01, 0.015, 0.03), vec3f(0.06, 0.09, 0.16), t);
    if (params.gradient == 1u) {
        color = mix(vec3f(0.5, 0.36, 0.34), vec3f(0.3, 0.36, 0.52), t);
    }
    // Fewer levels for the noise than for the rounding make its steps as many times larger.
    let levels = params.levels / max(params.intensity, 1e-3);
    if (params.intensity > 0.0) {
        switch id.y * 5u / size.y {
            case 1u: { color = color + (hdBayer(id.xy) - 0.5) / levels; }
            case 2u: { color = hdDither(color, id.xy, levels); }
            case 3u: { color = hdDitherBy(color, white(id.xy), levels); }
            case 4u: { color = hdDitherBy(color, textureLoad(blueNoise, vec2i(id.xy % 64u), 0).r, levels); }
            default: {}
        }
    }
    color = round(clamp(color, vec3f(0.0), vec3f(1.0)) * params.levels) / params.levels;
    textureStore(output, vec2i(id.xy), vec4f(color * params.gain, 1.0));
}`;

if (!gpu.error) {
    const device = gpuDevice();
    const blueNoise = device.createTexture({
        label: "sternwarte:bandingBlueNoise",
        size: [64, 64],
        format: "rg8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    fetch(blueNoiseUrl)
        .then((response) => response.arrayBuffer())
        .then((bytes) => {
            device.queue.writeTexture({ texture: blueNoise }, bytes, { bytesPerRow: 128 }, [64, 64]);
            request();
        });
    const pipeline = device.createComputePipeline({
        label: "sternwarte:banding",
        layout: "auto",
        compute: { module: device.createShaderModule({ code: SOURCE }), entryPoint: "main" },
    });
    const canvas = find<HTMLCanvasElement>("[data-field=canvas]", root);
    const context = canvas.getContext("webgpu");
    context?.configure({ device, format: "rgba8unorm", alphaMode: "opaque", usage: GPUTextureUsage.STORAGE_BINDING });
    const intensity = find<HTMLInputElement>("[data-field=intensity]", root);
    paintRange(intensity);
    const magnify = find("[data-field=magnify]", root);
    const zoom = find("[data-field=zoom]", root);
    const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const request = onDemand(() => {
        if (!context) return;
        const bits = Number(root.querySelector<HTMLInputElement>('input[name="banding-bits"]:checked')?.value ?? 8);
        const dusk = root.querySelector<HTMLInputElement>('input[name="banding-gradient"]:checked')?.value === "dusk";
        // Eight times a gradient this bright is white.
        (magnify as HTMLButtonElement).disabled = dusk;
        const gain = !dusk && magnify.getAttribute("aria-pressed") === "true" ? 8 : 1;
        const scale = (window.devicePixelRatio || 1) / (zoom.getAttribute("aria-pressed") === "true" ? 4 : 1);
        // Whole device pixels: the noise and the steps are of one pixel.
        Object.assign(canvas, {
            width: Math.max(1, Math.round(canvas.clientWidth * scale)),
            height: Math.max(1, Math.round(canvas.clientHeight * scale)),
        });
        const data = new ArrayBuffer(16);
        new Float32Array(data).set([2 ** bits - 1, 0, gain, Number(intensity.value)]);
        new Uint32Array(data)[1] = dusk ? 1 : 0;
        device.queue.writeBuffer(params, 0, data);
        const encoder = device.createCommandEncoder({ label: "sternwarte:banding" });
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(
            0,
            device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: params } },
                    { binding: 1, resource: context.getCurrentTexture().createView() },
                    { binding: 2, resource: blueNoise.createView() },
                ],
            }),
        );
        pass.dispatchWorkgroups(Math.ceil(canvas.width / 8), Math.ceil(canvas.height / 8));
        pass.end();
        device.queue.submit([encoder.finish()]);
        find("[data-field=reading]", root).textContent = Number(intensity.value).toFixed(2);
    }, root);
    for (const radio of root.querySelectorAll('input[name="banding-bits"], input[name="banding-gradient"]'))
        radio.addEventListener("change", request);
    intensity.addEventListener("input", request);
    for (const button of [magnify, zoom]) {
        button.addEventListener("click", () => {
            button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
            request();
        });
    }
    new ResizeObserver(request).observe(root);
}
