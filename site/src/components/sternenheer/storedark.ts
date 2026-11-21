import type { ToneCurve } from "@himmelszelt/helldunkel";
import { ev100FromLuminance, exposureFromEV100, wgsl } from "@himmelszelt/helldunkel";
import { createMilkyWay, MILKY_WAY_LUMINANCE } from "@himmelszelt/sternenheer";
import { find } from "../dom";
import { display, gpu, gpuDevice, onDisplay } from "../dunstkreis/atmosphere";
import { onDemand, watchView } from "../frame";
import { paintRange } from "../range";
import { drawSvg, svgText } from "../sternzeit/figure";

type Kind = "srgb" | "log" | "float";
type Patch = { low: number; median: number; high: number };
const KINDS: Kind[] = ["float", "srgb", "log"];
const CURVES: Record<ToneCurve, number> = { neutral: 1, agx: 2, aces: 3, clip: 4 };
const PLOT = { height: 92, top: 6, bottom: 18, left: 36, right: 4, doublings: 11 };

const SOURCE = /* wgsl */ `
${wgsl.tonemap}
struct Params { exposure: f32, stops: f32, zoom: f32, curve: u32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;
@group(0) @binding(3) var output: texture_storage_2d<rgba8unorm, write>;

fn curve(exposed: vec3f) -> vec3f {
    switch params.curve {
        case 2u: { return hdToneMapAgx(exposed); }
        case 3u: { return hdToneMapAces(exposed); }
        case 4u: { return hdToneMapClip(exposed); }
        default: { return hdToneMapNeutral(exposed); }
    }
}

// What sternenheer's compose pass reads at a point of the map: each channel's logarithm undone, between the texels in
// stops, the darkest step black; an sRGB texture is decoded and filtered by the GPU, half floats as they are.
fn light(uv: vec2f) -> vec3f {
    let stored = textureSampleLevel(source, sourceSampler, uv, 0.0).rgb;
    if (params.stops > 0.0) {
        return select(exp2((stored - 1.0) * params.stops), vec3f(0.0), stored <= vec3f(0.0));
    }
    return stored;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(output);
    if (any(id.xy >= size)) {
        return;
    }
    // Four samples a pixel, so a patch drawn smaller than its texels is averaged rather than aliased.
    var sum = vec3f(0.0);
    for (var i = 0u; i < 4u; i++) {
        let offset = vec2f(f32(i & 1u), f32(i >> 1u)) * 0.5 + 0.25;
        sum += light(0.5 + ((vec2f(id.xy) + offset) / vec2f(size) - 0.5) / params.zoom);
    }
    let color = hdDither(curve(sum * 0.25 * params.exposure), id.xy, 255.0);
    textureStore(output, vec2i(id.xy), vec4f(color, 1.0));
}`;

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const halfToFloat = (h: number) => {
    const exponent = (h >> 10) & 31;
    const value = exponent ? (1 + (h & 1023) / 1024) * 2 ** (exponent - 15) : ((h & 1023) / 1024) * 2 ** -14;
    return h & 0x8000 ? -value : value;
};

/** The levels each encoding spends on the stops below 1, the first to the `stops`th: its codes whose value lies there. */
function levelsPerStop(kind: Kind, stops: number) {
    const levels = new Array<number>(stops).fill(0);
    if (kind === "float") return levels.fill(1024);
    for (let code = 1; code < 256; code++) {
        const log2 = kind === "srgb" ? Math.log2(srgbToLinear(code / 255)) : (code / 255 - 1) * stops;
        const stop = Math.floor(-log2 + 1e-9);
        if (stop < stops) levels[stop] = (levels[stop] ?? 0) + 1;
    }
    return levels;
}

/** A data file of byte planes, gzip compressed, as sternenheer's scripts write them, back in record order. */
async function fetchPlanes(url: string) {
    let bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    const stride = new DataView(bytes.buffer).getUint32(4, true);
    const records = (bytes.length - 8) / stride;
    const out = new Uint8Array(bytes.length - 8);
    for (let k = 0; k < stride; k++)
        for (let i = 0; i < records; i++) out[i * stride + k] = bytes[8 + k * records + i] as number;
    return out.buffer;
}

/**
 * The figure on `root`: the chosen patch in three canvases, each drawn by one compute pass from its own texture, and the
 * levels each encoding spends per stop under it. Loads a patch's files once the figure comes near.
 */
export function storeDarkFigure(root: HTMLElement) {
    const status = find("[data-field=status]", root);
    if (gpu.error) {
        status.innerHTML = gpu.error;
        status.hidden = false;
        return;
    }
    const device = gpuDevice();
    const base = root.dataset.base ?? "";
    const stops = Number(root.dataset.stops ?? 12);
    const patches = JSON.parse(root.dataset.patches ?? "{}") as Record<string, Patch>;
    const exposure = find<HTMLInputElement>("[data-field=exposure]", root);
    const exposureValue = find("[data-field=exposureValue]", root);
    const zoom = find<HTMLButtonElement>("[data-field=zoom]", root);
    const compressed = find<HTMLButtonElement>("[data-field=webp]", root);
    const pipeline = device.createComputePipeline({
        label: "sternwarte:storeDark",
        layout: "auto",
        compute: { module: device.createShaderModule({ code: SOURCE }), entryPoint: "main" },
    });
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const panels = KINDS.map((kind) => {
        const view = find(`[data-panel=${kind}]`, root);
        const canvas = find<HTMLCanvasElement>("canvas", view);
        const context = canvas.getContext("webgpu");
        context?.configure({
            device,
            format: "rgba8unorm",
            alphaMode: "opaque",
            usage: GPUTextureUsage.STORAGE_BINDING,
        });
        const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const levels = levelsPerStop(kind, stops);
        return { kind, view, canvas, context, params, levels, plot: find<SVGSVGElement>("svg", view) };
    });

    type Texture = { texture: GPUTexture; sampler: GPUSampler; stops: number };
    type Textures = Record<Kind | "srgbRounded" | "logRounded", Texture>;
    const loaded = new Map<string, Promise<Textures>>();
    const shipped = (image: ImageBitmap, encoded: number): Texture => {
        const map = createMilkyWay(device, image, { luminance: MILKY_WAY_LUMINANCE, stops: encoded });
        return { texture: map.texture, sampler: map.sampler, stops: map.stops };
    };
    const decoded = { colorSpaceConversion: "none", premultiplyAlpha: "none" } as const;
    const load = (name: string) => {
        let textures = loaded.get(name);
        if (!textures) {
            const image = async (kind: Kind) =>
                createImageBitmap(await (await fetch(`${base}/${name}-${kind}.webp`)).blob(), decoded);
            textures = Promise.all([image("srgb"), image("log"), fetchPlanes(`${base}/${name}-float.bin.gz`)]).then(
                async ([srgb, log, planes]) => {
                    const rgb = new Uint16Array(planes);
                    const size = Math.round(Math.sqrt(rgb.length / 3));
                    const rgba = new Uint16Array(size * size * 4).fill(0x3c00);
                    for (let i = 0; i < size * size; i++) rgba.set(rgb.subarray(i * 3, i * 3 + 3), i * 4);
                    const texture = device.createTexture({
                        label: "sternwarte:storeDarkFloat",
                        size: [size, size],
                        format: "rgba16float",
                        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                    });
                    device.queue.writeTexture({ texture }, rgba, { bytesPerRow: size * 8 }, [size, size]);
                    // The same floats rounded to 8 bits as milkyway.mjs rounds them, before any WebP.
                    const rounded = async (encode: (v: number) => number) => {
                        const bytes = new Uint8ClampedArray(size * size * 4).fill(255);
                        for (let i = 0; i < size * size; i++)
                            for (let c = 0; c < 3; c++) bytes[i * 4 + c] = encode(halfToFloat(rgb[i * 3 + c] ?? 0));
                        return createImageBitmap(new ImageData(bytes, size, size), decoded);
                    };
                    const [srgbRounded, logRounded] = await Promise.all([
                        rounded((v) => Math.round(linearToSrgb(Math.min(Math.max(v, 0), 1)) * 255)),
                        rounded((v) => (v <= 0 ? 0 : Math.round((Math.log2(v) / stops + 1) * 255))),
                    ]);
                    return {
                        srgb: shipped(srgb, 0),
                        log: shipped(log, stops),
                        srgbRounded: shipped(srgbRounded, 0),
                        logRounded: shipped(logRounded, stops),
                        float: { texture, sampler, stops: 0 },
                    };
                },
            );
            loaded.set(name, textures);
        }
        return textures;
    };

    const chosen = () => root.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value ?? "pole";
    let near = false;
    let current: { name: string; textures: Textures } | null = null;

    /** The levels per stop as bars, a stop's bar in the accent where the patch lies, on a scale of doublings. */
    const plotLevels = (panel: (typeof panels)[number], patch: Patch) => {
        const width = Math.max(panel.plot.clientWidth, 120);
        const { height, top, bottom, left, right, doublings } = PLOT;
        const step = (width - left - right) / stops;
        const y = (levels: number) => height - bottom - (Math.log2(2 * levels) / doublings) * (height - top - bottom);
        const from = Math.ceil(-patch.high) - 1;
        const to = Math.ceil(-patch.low) - 1;
        let svg = `<rect class="storedark-range" x="${left + from * step}" y="${top}" width="${(to - from + 1) * step}" height="${height - top - bottom}" />`;
        for (const [label, levels] of [
            ["1", 1],
            ["32", 32],
            ["1024", 1024],
        ] as const)
            svg += `<line class="figure-grid" x1="${left}" x2="${width - right}" y1="${y(levels)}" y2="${y(levels)}" />${svgText(left - 4, y(levels), label, "figure-grid-label")}`;
        panel.levels.forEach((levels, stop) => {
            const inside = stop >= from && stop <= to;
            const x = left + stop * step + 1.5;
            svg += `<rect class="storedark-bar${inside ? " storedark-bar-patch" : ""}" x="${x}" y="${y(levels)}" width="${step - 3}" height="${height - bottom - y(levels)}" />`;
        });
        for (const stop of [1, 4, 8, 12])
            svg += svgText(left + (stop - 0.5) * step, height - bottom / 2 + 1, stop, "figure-label");
        panel.plot.setAttribute("viewBox", `0 0 ${width} ${height}`);
        drawSvg(panel.plot, svg, 1);
        const spent = panel.levels.slice(from, to + 1);
        const fewest = Math.min(...spent).toLocaleString("en-US");
        const most = Math.max(...spent).toLocaleString("en-US");
        find("[data-field=levels]", panel.view).textContent =
            fewest === most ? `${most} levels` : `${fewest} to ${most} levels`;
    };

    const draw = () => {
        const name = chosen();
        const patch = patches[name];
        if (!patch) return;
        for (const panel of panels) plotLevels(panel, patch);
        const ev100 = -Number(exposure.value);
        exposureValue.textContent = `${ev100 < 0 ? "−" : ""}${Math.abs(ev100).toFixed(1)}`;
        if (current?.name !== name) {
            if (near)
                load(name).then((textures) => {
                    current = { name, textures };
                    request();
                });
            return;
        }
        const encoder = device.createCommandEncoder({ label: "sternwarte:storeDark" });
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        for (const panel of panels) {
            if (!panel.context) continue;
            const scale = window.devicePixelRatio || 1;
            const side = Math.max(1, Math.round(panel.canvas.clientWidth * scale));
            if (panel.canvas.width !== side) Object.assign(panel.canvas, { width: side, height: side });
            const webp = compressed.getAttribute("aria-pressed") === "true" || panel.kind === "float";
            const {
                texture,
                sampler: filter,
                stops: encoded,
            } = current.textures[webp ? panel.kind : panel.kind === "srgb" ? "srgbRounded" : "logRounded"];
            const data = new ArrayBuffer(16);
            const shown = MILKY_WAY_LUMINANCE * exposureFromEV100(ev100);
            new Float32Array(data).set([shown, encoded, zoom.getAttribute("aria-pressed") === "true" ? 4 : 1]);
            new Uint32Array(data)[3] = CURVES[display.toneCurve];
            device.queue.writeBuffer(panel.params, 0, data);
            pass.setBindGroup(
                0,
                device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: panel.params } },
                        { binding: 1, resource: texture.createView() },
                        { binding: 2, resource: filter },
                        { binding: 3, resource: panel.context.getCurrentTexture().createView() },
                    ],
                }),
            );
            pass.dispatchWorkgroups(Math.ceil(side / 8), Math.ceil(side / 8));
        }
        pass.end();
        device.queue.submit([encoder.finish()]);
    };
    const request = onDemand(draw, root);

    // A patch chosen sets the exposure to its meter reading: its median texel at a tenth of saturation.
    const meter = () => {
        const patch = patches[chosen()];
        if (!patch) return;
        exposure.value = (-ev100FromLuminance(2 ** patch.median * MILKY_WAY_LUMINANCE)).toFixed(1);
        paintRange(exposure);
    };
    meter();
    for (const radio of root.querySelectorAll("input[type=radio]"))
        radio.addEventListener("change", () => {
            meter();
            request();
        });
    exposure.addEventListener("input", request);
    for (const button of [zoom, compressed])
        button.addEventListener("click", () => {
            button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
            request();
        });
    onDisplay(request);
    new ResizeObserver(request).observe(root);
    watchView(root, "100% 0px", (on) => {
        near = near || on;
        if (near) request();
    });
}
