import {
    METER_BINS_PER_STOP,
    METER_LOWEST_STOP,
    type MeterAverage,
    type MeterHistogram,
} from "@himmelszelt/helldunkel";
import { find } from "../dom";
import { gpu, gpuDevice } from "../dunstkreis/atmosphere";
import {
    changed,
    context,
    draw,
    hdri,
    METERING_RADIUS,
    type Metering,
    meterCounts,
    onHdri,
    remeter,
    view,
} from "../environment/hdri";
import { onDemand } from "../frame";

const root = find("#range");
const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
const canvas = field<HTMLCanvasElement>("canvas");
const plotCanvas = field<HTMLCanvasElement>("histogram");
const labels = field("labels");
/** What each output holds, as the exposed light at its first step above black and at its top. */
const OUTPUTS: Record<string, { black: number; white: number }> = {
    linear: { black: 1 / 255, white: 1 },
    srgb: { black: 1 / 255 / 12.92, white: 1 },
    hdr: { black: 1 / 255 / 12.92, white: 4 },
};
/** How far the plot's curves are smoothed, in bins to either side: an RGBE file's values come in steps, which comb it. */
const REACH = 8;
/** The scale under the plot, in CSS pixels. */
const AXIS = 24;
/** How far from the image's middle, in stops, the axis starts to squeeze: a Sun's long tail would take half of it. */
const SQUEEZE = 6;
const AVERAGES: Record<string, MeterAverage> = {
    floor: {},
    middle: { percentiles: [0.1, 0.9] },
    bright: { percentiles: [0.5, 0.95] },
};

const SHADER = /* wgsl */ `
struct Params { first: f32, last: f32, black: f32, white: f32, mean: f32, top: f32, axis: f32, dpr: f32, middle: f32, squeeze: f32, wholeTop: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> counts: array<u32, 10240>;
@group(0) @binding(2) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<storage, read> whole: array<u32, 10240>;

const BINS = 2048;

// A channel's height at a stop, 0 to 1, by the root of its share of the whole image: the sky's few bright stops would vanish otherwise.
fn height(channel: i32, stop: f32, total: f32) -> f32 {
    // Between the bins, so the curves run without steps however the axis lands on them.
    let bin = (stop - (${METER_LOWEST_STOP.toFixed(1)})) * ${METER_BINS_PER_STOP.toFixed(1)};
    var sum = 0.0;
    for (var k = -${REACH}; k <= ${REACH + 1}; k = k + 1) {
        // Bin 0 holds all that is too dark to place.
        let at = i32(floor(bin)) + k;
        if (at > 0 && at < BINS) {
            sum = sum + f32(counts[channel * BINS + at]) * max(1.0 - abs(f32(at) - bin) / ${REACH + 1}.0, 0.0);
        }
    }
    return sqrt(sum / total / params.top);
}

// The same of the whole image's luminance, for reference, on its own scale: it stands still whatever the meter weighs.
fn wholeHeight(stop: f32, total: f32) -> f32 {
    let bin = (stop - (${METER_LOWEST_STOP.toFixed(1)})) * ${METER_BINS_PER_STOP.toFixed(1)};
    var sum = 0.0;
    for (var k = -${REACH}; k <= ${REACH + 1}; k = k + 1) {
        let at = i32(floor(bin)) + k;
        if (at > 0 && at < BINS) {
            sum = sum + f32(whole[3 * BINS + at]) * max(1.0 - abs(f32(at) - bin) / ${REACH + 1}.0, 0.0);
        }
    }
    return sqrt(sum / total / params.wholeTop);
}

// The light under a channel's curve: dim at the base and dense towards the curve.
fn fill(up: f32, curve: f32, plot: f32) -> f32 {
    if (up > curve || curve <= 0.0) {
        return 0.0;
    }
    let along = up / curve;
    return (0.05 + 0.5 * along * along * along) * (0.4 + 0.6 * curve / plot);
}

// The distance to a line piece.
fn toPiece(point: vec2f, from_: vec2f, to_: vec2f) -> f32 {
    let along = to_ - from_;
    let share = clamp(dot(point - from_, along) / max(dot(along, along), 1e-6), 0.0, 1.0);
    return length(point - from_ - along * share);
}

// A line along a curve given at this pixel's column and two to either side, of one width however steep: by its true
// distance from the curve, not its height above it.
fn stroke(up: f32, curve: array<f32, 5>, width: f32) -> f32 {
    if (max(curve[0], max(curve[1], max(curve[2], max(curve[3], curve[4])))) < 0.5) {
        return 0.0;
    }
    let point = vec2f(0.0, up);
    var distance = 1e6;
    for (var i = 0; i < 4; i = i + 1) {
        distance = min(distance, toPiece(point, vec2f(f32(i - 2), curve[i]), vec2f(f32(i - 1), curve[i + 1])));
    }
    return 1.0 - smoothstep(width - 0.5, width + 0.5, distance);
}

@compute @workgroup_size(16)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(output);
    if (id.x >= size.x) {
        return;
    }
    // Both by the whole image's total: what a meter weighs is a part of it, in the same counts, however thinned.
    var wholeTotal = 1.0;
    for (var i = 0; i < BINS; i = i + 1) {
        wholeTotal = wholeTotal + f32(whole[3 * BINS + i]);
    }
    // Linear around the middle, and ever tighter away from it: the inverse of asinh, as it has no jumps anywhere.
    let across = params.first + (f32(id.x) + 0.5) * (params.last - params.first) / f32(size.x);
    let perAcross = (params.last - params.first) / f32(size.x);
    let stop = params.middle + params.squeeze * sinh(across);
    let perPixel = params.squeeze * cosh(across) * perAcross;
    let plot = f32(size.y) - params.axis;
    // Room above the highest curve.
    let reach = plot * 0.88;
    var curves: array<array<f32, 5>, 4>;
    var referenceCurve: array<f32, 5>;
    for (var i = 0; i < 5; i = i + 1) {
        let at = params.middle + params.squeeze * sinh(across + f32(i - 2) * perAcross);
        for (var c = 0; c < 4; c = c + 1) {
            curves[c][i] = height(c, at, wholeTotal) * reach;
        }
        referenceCurve[i] = wholeHeight(at, wholeTotal) * reach;
    }
    let rgb = vec3f(curves[0][2], curves[1][2], curves[2][2]);
    let reference = referenceCurve[2];
    let inside = stop >= params.black && stop <= params.white;
    let width = 0.6 * params.dpr;
    let onEdge = abs(stop - params.black) < perPixel || abs(stop - params.white) < perPixel;
    let onMean = abs(stop - params.mean) < perPixel * 0.75 * params.dpr;
    for (var y = 0u; y < size.y; y = y + 1u) {
        // Under the plot, the scale on the plot's own gray, its baseline between them.
        var color = select(vec3f(0.11), vec3f(0.32), abs(f32(y) + 0.5 - plot) < 0.5 * params.dpr);
        if (f32(y) < plot) {
            let up = plot - f32(y) - 0.5;
            color = select(vec3f(0.035), vec3f(0.11), inside);
            // What clips, striped as the image is: red to white, blue to black.
            if (!inside && fract((f32(id.x) + f32(y)) / (10.0 * params.dpr)) < 0.3) {
                color = select(vec3f(0.03, 0.09, 0.26), vec3f(0.3, 0.03, 0.09), stop > params.white);
            }
            // Behind it all, the whole image, however little of it the meter weighs.
            if (up < reference) {
                color = color + vec3f(0.07);
            }
            color = color + vec3f(0.16 * stroke(up, referenceCurve, width));
            let light = vec3f(
                fill(up, rgb.r, plot) + 1.2 * stroke(up, curves[0], width),
                fill(up, rgb.g, plot) + 1.2 * stroke(up, curves[1], width),
                fill(up, rgb.b, plot) + 1.2 * stroke(up, curves[2], width),
            );
            color = color + (1.0 - exp(-1.9 * light));
            if (onEdge) {
                color = vec3f(0.62);
            }
            if (onMean && fract(f32(y) / (8.0 * params.dpr)) < 0.55) {
                color = vec3f(1.0);
            }
            // The luminance over it all.
            color = mix(color, vec3f(1.0), stroke(up, curves[3], width));
        }
        textureStore(output, vec2i(i32(id.x), i32(y)), vec4f(min(color, vec3f(1.0)), 1.0));
    }
}`;

let pipeline: GPUComputePipeline | null = null;

const stopOf = (bin: number) => METER_LOWEST_STOP + bin / METER_BINS_PER_STOP;

/** The stops the image reaches, and the highest any channel's curve goes, as the shader smooths it. */
function extent(histogram: MeterHistogram) {
    let [first, last, top] = [Number.POSITIVE_INFINITY, 0, 0];
    for (const channel of [histogram.red, histogram.green, histogram.blue, histogram.luminance]) {
        for (let bin = 1; bin < channel.length; ++bin) {
            if (!((channel[bin] as number) > 0)) continue;
            first = Math.min(first, bin);
            last = Math.max(last, bin);
            let sum = 0;
            for (let k = -REACH; k <= REACH; ++k) sum += (channel[bin + k] ?? 0) * (1 - Math.abs(k) / (REACH + 1));
            top = Math.max(top, sum);
        }
    }
    return { low: stopOf(first), high: stopOf(last), top: top || 1 };
}

/** The stop half of the image lies below: where the axis keeps its stops widest, not in a Sun's empty tail. */
function median(bins: Float64Array) {
    let [sum, bin] = [0, 0];
    while (bin < bins.length - 1 && sum < 0.5) sum += bins[bin++] as number;
    return stopOf(bin);
}

/** How many stops hold all but half a percent of the sphere at either end: unlike the extremes, it hardly depends on a stray texel. */
function span(bins: Float64Array) {
    const total = bins.reduce((a, b) => a + b, 0);
    let [sum, first, last] = [0, 0, bins.length - 1];
    bins.forEach((value, k) => {
        if (sum < 0.005 * total) first = k;
        sum += value;
        if (sum - value < 0.995 * total) last = k;
    });
    return (last - first + 1) / METER_BINS_PER_STOP;
}

const percent = (share: number) =>
    share > 0 && share < 0.001 ? "under 0.1%" : `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;

function output() {
    return OUTPUTS[root.querySelector<HTMLInputElement>('input[name="range-output"]:checked')?.value ?? "srgb"];
}

async function plot() {
    const { histogram, whole, wholeCounts } = hdri;
    const counts = await meterCounts();
    if (!histogram || !whole || !wholeCounts || !counts) return;
    const device = gpuDevice();
    const target = plotCanvas.getContext("webgpu");
    if (!target) return;
    const dpr = window.devicePixelRatio || 1;
    const [cssWidth, cssHeight] = [plotCanvas.clientWidth, plotCanvas.clientHeight];
    const [width, height] = [cssWidth, cssHeight].map((n) => Math.max(1, Math.round(n * dpr))) as [number, number];
    if (plotCanvas.width !== width || plotCanvas.height !== height) Object.assign(plotCanvas, { width, height });
    if (!target.getConfiguration())
        target.configure({
            device,
            format: "rgba8unorm",
            alphaMode: "opaque",
            usage: GPUTextureUsage.STORAGE_BINDING,
        });
    pipeline ??= device.createComputePipeline({
        label: "sternwarte:histogram",
        layout: "auto",
        compute: { module: device.createShaderModule({ code: SHADER }), entryPoint: "main" },
    });
    const { black, white } = output() ?? (OUTPUTS.srgb as { black: number; white: number });
    // Exposed light is the luminance over 1.2 × 2^EV, so the output's ends in the image's own stops.
    const saturates = Math.log2(1.2) + hdri.ev100;
    const whiteStop = saturates + Math.log2(white);
    const blackStop = saturates + Math.log2(black);
    const mean = hdri.metered + Math.log2(12.5 / 100);
    const { low, high } = extent(histogram);
    // Both axes fixed for an image, whatever the meter weighs, and this one growing without a jump only where the band leaves it.
    const all = extent(whole);
    const { top } = all;
    const axis = { low: all.low, high: all.high, middle: median(whole.luminance) };
    const warp = (stop: number) => Math.asinh((stop - axis.middle) / SQUEEZE);
    const from = warp(Math.min(axis.low, blackStop) - 1);
    const to = warp(Math.max(axis.high, whiteStop) + 1);
    const params = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    new Float32Array(params.getMappedRange()).set([
        from,
        to,
        blackStop,
        whiteStop,
        mean,
        top,
        AXIS * dpr,
        dpr,
        axis.middle,
        SQUEEZE,
        all.top,
    ]);
    params.unmap();
    const encoder = device.createCommandEncoder({ label: "sternwarte:histogram" });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
        0,
        device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: params } },
                { binding: 1, resource: { buffer: counts } },
                { binding: 2, resource: target.getCurrentTexture().createView() },
                { binding: 3, resource: { buffer: wholeCounts } },
            ],
        }),
    );
    pass.dispatchWorkgroups(Math.ceil(width / 16));
    pass.end();
    device.queue.submit([encoder.finish()]);
    params.destroy();

    let [toWhite, toBlack] = [0, 0];
    histogram.peak.forEach((share, bin) => {
        if (stopOf(bin) >= whiteStop) toWhite += share;
        else if (stopOf(bin) < blackStop) toBlack += share;
    });
    const x = (stop: number) => ((warp(stop) - from) / (to - from)) * cssWidth;
    const text = (at: number, y: number, words: string, anchor = "middle") =>
        `<text x="${at.toFixed(1)}" y="${y}" text-anchor="${anchor}">${words}</text>`;
    let svg = "";
    // As many every 4 stops as fit: they lie closer where the axis squeezes.
    const first = Math.ceil((axis.middle + SQUEEZE * Math.sinh(from)) / 4) * 4;
    const last = axis.middle + SQUEEZE * Math.sinh(to);
    let free = 14;
    for (let stop = first; stop <= last; stop += 4) {
        if (x(stop) < free || x(stop) > cssWidth - 14) continue;
        svg += text(x(stop), cssHeight - 7, String(stop).replace("-", "\u2212"));
        free = x(stop) + 26;
    }
    svg += text(x(blackStop) + 6, 17, `black ${percent(toBlack)}`, "start");
    svg += text(x(whiteStop) - 6, 17, `white ${percent(toWhite)}`, "end");
    svg += text(x(mean) + 5, 34, "metered", "start");
    labels.innerHTML = `<svg viewBox="0 0 ${cssWidth} ${cssHeight}">${svg}</svg>`;
    const scope =
        view.metering === "average" ? "Most of the sphere, 99% of it," : "Most of what this meter weighs, 99% of it,";
    field("info").textContent =
        `${scope} spans ${span(histogram.luminance).toFixed(1)} stops, and from darkest to brightest ${(high - low).toFixed(1)}. ` +
        `This output holds ${Math.log2(white / black).toFixed(1)}.`;
}

/** The meter's circle over the view: nothing to show on the map, or for a meter of the whole sphere. */
function ring() {
    const circle = field("ring");
    const metering = view.metering;
    circle.hidden = (metering !== "center" && metering !== "spot") || !view.projected;
    if (metering === "center" || metering === "spot")
        circle.style.setProperty("--radius", `${(METERING_RADIUS[metering] * 50).toFixed(1)}%`);
}

function applyOutput() {
    const chosen = output();
    if (chosen) Object.assign(view, chosen);
}

if (gpu.error) {
    field("info").textContent = gpu.error;
} else {
    const target = context(canvas);
    const request = onDemand(() => {
        if (target) draw(canvas, target);
        ring();
        plot();
    }, root);
    onHdri(request);
    const resized = new ResizeObserver(request);
    resized.observe(canvas);
    resized.observe(plotCanvas);
    for (const radio of root.querySelectorAll<HTMLInputElement>('input[name="range-metering"]')) {
        radio.addEventListener("change", () => {
            view.metering = radio.value as Metering;
            remeter();
            changed();
        });
    }
    for (const radio of root.querySelectorAll<HTMLInputElement>('input[name="range-average"]')) {
        radio.addEventListener("change", () => {
            view.average = AVERAGES[radio.value] ?? {};
            remeter();
        });
    }
    for (const radio of root.querySelectorAll<HTMLInputElement>('input[name="range-size"]')) {
        radio.addEventListener("change", () => {
            view.meterSize = Number(radio.value) || undefined;
            remeter();
        });
    }
    const adaptation = field<HTMLInputElement>("adaptation");
    adaptation.addEventListener("input", () => {
        const seconds = Number(adaptation.value);
        // Towards brighter quicker than towards darker, as an eye.
        view.adaptation = seconds > 0 ? { toBrighter: seconds / 3, toDarker: seconds } : null;
        field("adaptationValue").textContent = seconds > 0 ? `${seconds.toFixed(1)}\u202fs` : "off";
    });
    for (const radio of root.querySelectorAll<HTMLInputElement>('input[name="range-output"]')) {
        radio.addEventListener("change", () => {
            applyOutput();
            changed();
        });
    }
}
