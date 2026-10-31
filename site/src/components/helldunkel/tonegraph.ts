import { wgsl } from "@himmelszelt/helldunkel";
import { find } from "../dom";
import { gpu, gpuDevice } from "../dunstkreis/atmosphere";
import { drawSvg, LABEL_GAP, svgText } from "../sternzeit/figure";

const root = find("#curves");
const POINTS = 512;
const [FROM, TO] = [-8, 4];
const CURVES = ["clip", "neutral", "agx", "aces"];
/** Linear sRGB, each scaled to a luminance of 1 where it is used. */
const COLORS: Record<string, [number, number, number]> = {
    sunset: [1, 0.3, 0.05],
    sky: [0.12, 0.3, 1],
    leaf: [0.15, 0.6, 0.05],
    gray: [1, 1, 1],
};
/** Where a metered average lands, exposed by EV100: a tenth of white, 1/9.6. */
const METERED = Math.log2(1 / 9.6);
/** Under the strips' names, so a stop lies at the same place in the plot and in the strips. */
const INSET = 64;
const MARGIN = { top: 12, bottom: 38 };

const plotEl = root.querySelector('[data-field="plot"]') as SVGSVGElement;
const chosen = (name: string) => root.querySelector<HTMLInputElement>(`input[name="curves-${name}"]:checked`)?.value;

let pipeline: GPUComputePipeline | null = null;
const params = () => gpuDevice().createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });

/** Every curve for the light from FROM to TO stops around white, as the shaders compute it: a vec4f per curve per point. */
async function evaluate(color: [number, number, number]) {
    const device = gpuDevice();
    pipeline ??= await device.createComputePipelineAsync({
        layout: "auto",
        compute: {
            module: device.createShaderModule({
                code: `${wgsl.tonemap}
@group(0) @binding(0) var<uniform> color: vec3f;
@group(0) @binding(1) var<storage, read_write> out: array<vec4f, ${POINTS * 4}>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= ${POINTS}u) {
        return;
    }
    let light = color * exp2(${FROM.toFixed(1)} + f32(id.x) / ${POINTS - 1}.0 * ${(TO - FROM).toFixed(1)});
    out[id.x * 4u] = vec4f(hdToneMapClip(light), 1.0);
    out[id.x * 4u + 1u] = vec4f(hdToneMapNeutral(light), 1.0);
    out[id.x * 4u + 2u] = vec4f(hdToneMapAgx(light), 1.0);
    out[id.x * 4u + 3u] = vec4f(hdToneMapAces(light), 1.0);
}`,
            }),
            entryPoint: "main",
        },
    });
    const uniform = params();
    new Float32Array(uniform.getMappedRange()).set(color);
    uniform.unmap();
    const size = POINTS * 4 * 16;
    const buffer = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
        0,
        device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: uniform } },
                { binding: 1, resource: { buffer } },
            ],
        }),
    );
    pass.dispatchWorkgroups(Math.ceil(POINTS / 64));
    pass.end();
    encoder.copyBufferToBuffer(buffer, 0, read, 0, size);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(read.getMappedRange().slice(0));
    for (const made of [uniform, buffer, read]) made.destroy();
    return values;
}

let values: Float32Array | null = null;

function strips(data: Float32Array) {
    CURVES.forEach((curve, c) => {
        const canvas = root.querySelector<HTMLCanvasElement>(`canvas[data-strip="${curve}"]`);
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;
        Object.assign(canvas, { width: POINTS, height: 1 });
        const image = context.createImageData(POINTS, 1);
        for (let i = 0; i < POINTS; ++i) {
            const from = (i * 4 + c) * 4;
            for (let k = 0; k < 3; ++k) image.data[i * 4 + k] = (data[from + k] as number) * 255;
            image.data[i * 4 + 3] = 255;
        }
        context.putImageData(image, 0, 0);
    });
}

function plot() {
    if (!values) return;
    const data = values;
    const width = plotEl.clientWidth || 480;
    const height = plotEl.clientHeight || 320;
    plotEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const bottom = height - MARGIN.bottom;
    const x = (stops: number) => INSET + ((stops - FROM) / (TO - FROM)) * (width - INSET);
    const y = (value: number) => bottom - value * (bottom - MARGIN.top);
    const f = (n: number) => n.toFixed(1);
    const line = (x1: number, y1: number, x2: number, y2: number, cls: string) =>
        `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" class="${cls}"/>`;
    let svg = "";
    for (const value of [0, 0.25, 0.5, 0.75, 1]) {
        svg += line(INSET, y(value), width, y(value), "figure-grid curves-row");
        svg += svgText(INSET - LABEL_GAP, y(value), String(value), "figure-grid-label figure-anchor-end");
    }
    for (let stops = FROM; stops <= TO; stops += 2) {
        const text = stops === 0 ? "white" : `${stops > 0 ? "+" : "−"}${Math.abs(stops)}`;
        const cls = stops === TO ? "figure-label figure-anchor-end" : "figure-label";
        svg += svgText(x(stops), bottom + 12, text, cls);
    }
    svg += svgText((INSET + width) / 2, height - 7, "exposed light, stops from white", "figure-label");
    svg += svgText(INSET + LABEL_GAP, MARGIN.top + 11, "the pixel, sRGB encoded", "figure-label figure-anchor-start");
    svg += line(x(0), MARGIN.top, x(0), bottom, "curves-mark");
    svg += line(x(METERED), MARGIN.top, x(METERED), bottom, "curves-mark curves-quiet");
    svg += svgText(x(METERED) + LABEL_GAP, y(0.06), "metered average", "figure-label figure-anchor-start");
    const c = Math.max(CURVES.indexOf(chosen("curve") ?? "neutral"), 0);
    ["red", "green", "blue"].forEach((channel, k) => {
        const points = Array.from({ length: POINTS }, (_, i) => {
            const stops = FROM + (i / (POINTS - 1)) * (TO - FROM);
            return `${f(x(stops))},${f(y(data[(i * 4 + c) * 4 + k] as number))}`;
        });
        svg += `<polyline points="${points.join(" ")}" class="curves-line curves-${channel}"/>`;
    });
    drawSvg(plotEl, svg, 1);
}

async function refresh() {
    const [r, g, b] = COLORS[chosen("color") ?? "sunset"] as [number, number, number];
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    values = await evaluate([r / luminance, g / luminance, b / luminance]);
    strips(values);
    plot();
}

if (!gpu.error) {
    refresh();
    new ResizeObserver(plot).observe(plotEl);
    for (const radio of root.querySelectorAll('input[name="curves-color"]')) radio.addEventListener("change", refresh);
    for (const radio of root.querySelectorAll('input[name="curves-curve"]')) radio.addEventListener("change", plot);
}
