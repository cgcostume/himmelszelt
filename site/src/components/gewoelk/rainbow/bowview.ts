import { airTransmittance, DEFAULT_ATMOSPHERE_MODEL } from "@himmelszelt/dunstkreis";
import { rainbowTable, rainDropRadius, rainExtinction, wgsl } from "@himmelszelt/gewoelk";
import { configureCanvas, SDR } from "../../dunstkreis/atmosphere";
import { gpu, gpuFailed, gpuMissing } from "../../webgpu";
import shader from "./bowview.comp.wgsl";

// The bow rendered for the figure of where it stands: one compute pass over gewoelk's table of the rain's phase
// function, a shower ahead of the observer under the figure's Sun, in the projection of the diagram beside it.

const DEG = Math.PI / 180;
// The shower's rain in mm/h, the Sun's illuminance above the air in lux, and the observer's eyes over the ground in m.
const RAIN_RATE = 5;
const SUNLIGHT = 128000;
const EYE_M = 2;
// What the brightest channel of the Sun's illuminance on the rain is exposed to: the bow's crest, an eighth of it per
// steradian, to a bright color, under a red Sun too.
const EXPOSED = 6;
const MOST_PIXELS = 2048;

/** The diagram's projection: the horizon's height as a share of the panel's, and the degrees to either side of its middle. */
export interface BowProjection {
    horizon: number;
    halfWidth: number;
}

/** The view on `canvas`: `draw` it for a Sun `elevation` degrees up behind the observer. Null without a GPU. */
export function createBowView(canvas: HTMLCanvasElement, projection: BowProjection, onReady: () => void) {
    const { device } = gpu;
    const context = device && canvas.getContext("webgpu");
    if (!device || !context) {
        gpuMissing(canvas, "sky-error");
        return null;
    }
    configureCanvas(context, SDR);
    const uniforms = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    let pipeline: GPUComputePipeline | null = null;
    let table: GPUTextureView | null = null;
    device
        .createComputePipelineAsync({
            label: "sternwarte:bowView",
            layout: "auto",
            compute: {
                module: device.createShaderModule({ code: [wgsl.rainbow, wgsl.tonemap, shader].join("\n") }),
                entryPoint: "bowView",
            },
        })
        .then((made) => {
            pipeline = made;
            onReady();
        }, gpuFailed);

    /** The rain's phase function for the shower's drops, as half floats, which every GPU filters. */
    function phase(device: GPUDevice) {
        const { data, width } = rainbowTable({ dropRadiusMm: rainDropRadius(RAIN_RATE) });
        const texture = device.createTexture({
            label: "sternwarte:bowTable",
            size: [width, 1],
            format: "rgba16float",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture }, new Float16Array(data), {}, [width, 1]);
        return texture.createView();
    }

    return {
        draw(elevation: number) {
            const scale = Math.min(devicePixelRatio, MOST_PIXELS / Math.max(canvas.clientWidth, 1));
            const [width, height] = [canvas.clientWidth, canvas.clientHeight].map((n) => Math.round(n * scale));
            if (!pipeline || !width || !height) return;
            if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
            table ??= phase(device);
            // The Sun's light as the air leaves it at that height: dim and red near the horizon, as the bow then is.
            const through = airTransmittance(DEFAULT_ATMOSPHERE_MODEL, EYE_M, elevation) ?? [0, 0, 0];
            const [r, g, b] = through.map((share) => SUNLIGHT * share) as [number, number, number];
            const exposure = EXPOSED / Math.max(r, g, b, 1e-6);
            const sun = [0, -Math.cos(elevation * DEG), Math.sin(elevation * DEG)];
            const quarter = width / (2 * Math.tan((projection.halfWidth / 2) * DEG));
            device.queue.writeBuffer(
                uniforms,
                0,
                new Float32Array([
                    ...sun,
                    rainExtinction(RAIN_RATE),
                    ...[r, g, b, exposure],
                    ...[width / 2, projection.horizon * height, quarter, 0],
                ]),
            );
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass({ label: "sternwarte:bowView" });
            pass.setPipeline(pipeline);
            pass.setBindGroup(
                0,
                device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: uniforms } },
                        { binding: 1, resource: table },
                        { binding: 2, resource: sampler },
                        { binding: 3, resource: context.getCurrentTexture().createView() },
                    ],
                }),
            );
            pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
            pass.end();
            device.queue.submit([encoder.finish()]);
        },
    };
}
