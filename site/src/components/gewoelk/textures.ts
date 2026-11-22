import { configureCanvas, SDR } from "../dunstkreis/atmosphere";

/**
 * The textures a cloud figure renders from, as thumbnails down the left of its view: each drawn by a small compute
 * pass in the figure's own frame, with its name, format, size, memory and, where the figure times it, what it took to
 * compute under it, and what it is for as its tooltip.
 */

/** How a texture is shown: its colors as they are, one channel as gray, or what the channels mean. */
export const SHOW = { rgb: 0, red: 1, green: 2, blue: 3, alpha: 4, modeling: 5, shade: 6 } as const;

export interface Shown {
    label: string;
    title: string;
    /**
     * For a gallery: the texture's name, under which its channels stand side by side as one asset, its format, size
     * and memory said once over them and each tile left with its label and channel.
     */
    group?: string;
    /** For what is no texture of the library's but drawn from them: said in place of its format, size and memory. */
    drawn?: string;
    texture: GPUTexture;
    kind: "2d" | "array" | "3d";
    mode?: number;
    /** What a gray is multiplied by, or for `shade` the depth per unit that dims to 1/e. */
    scale?: number;
    /** The layer of an array; of a volume the height of a level slice, 0 to 1, or -1 for an upright cut east to west;
     *  of a plain texture the share of its tile across the thumbnail, all of it by default. */
    at?: number;
    /**
     * For a volume's level slice: how many slices of it stand beside the thumbnail as a small stack to pick from. They
     * are examples, evenly up the volume, not its every level.
     */
    slices?: number;
    /** The channel `shade` reads. */
    channel?: number;
    /** What the texture last took to compute on the GPU, in ms, once known, and what else that time covers. */
    ms?: () => number | undefined;
    timed?: string;
}

const TEXEL_BYTES: Partial<Record<GPUTextureFormat, number>> = {
    r8unorm: 1,
    r16float: 2,
    rg16float: 4,
    r32float: 4,
    r32uint: 4,
    rgba8unorm: 4,
    rg32float: 8,
    rgba16float: 8,
    rgba32float: 16,
};

/** What a texture takes on the GPU with all its levels, a layer's share for an array: "512 KiB", "44.7 MiB". */
function memoryOf(texture: GPUTexture, kind: Shown["kind"]) {
    let texels = 0;
    for (let i = 0; i < texture.mipLevelCount; i++) {
        const deep = kind === "3d" ? Math.max(1, texture.depthOrArrayLayers >> i) : 1;
        texels += Math.max(1, texture.width >> i) * Math.max(1, texture.height >> i) * deep;
    }
    const bytes = texels * (TEXEL_BYTES[texture.format] ?? 4);
    if (bytes < 2 ** 20) return `${Math.round(bytes / 1024)} KiB`;
    return `${(bytes / 2 ** 20).toFixed(bytes < 100 * 2 ** 20 ? 1 : 0)} MiB`;
}

/** A texture's size in texels, a layer's for an array: "2048²", "256² × 64". */
function sizeOf(texture: GPUTexture, kind: Shown["kind"]) {
    const across = texture.width === texture.height ? `${texture.width}²` : `${texture.width} × ${texture.height}`;
    return kind === "3d" ? `${across} × ${texture.depthOrArrayLayers}` : across;
}

const SIZE = 128;
const KINDS = {
    "2d": [
        "texture_2d<f32>",
        "textureSampleLevel(source, bilinear, vec2f(uv.x, 1.0 - uv.y) * select(1.0, show.at, show.at > 0.0), 0.0)",
    ],
    array: [
        "texture_2d_array<f32>",
        "textureSampleLevel(source, bilinear, vec2f(uv.x, 1.0 - uv.y), i32(show.at), 0.0)",
    ],
    "3d": [
        "texture_3d<f32>",
        "textureSampleLevel(source, bilinear, select(vec3f(uv.x, 1.0 - uv.y, show.at), vec3f(uv.x, 0.5, 1.0 - uv.y), show.at < 0.0), 0.0)",
    ],
} as const;
const shader = (type: string, read: string) => `
struct Show { mode: f32, scale: f32, at: f32, channel: f32 }
@group(0) @binding(0) var<uniform> show: Show;
@group(0) @binding(1) var source: ${type};
@group(0) @binding(2) var bilinear: sampler;
@group(1) @binding(0) var shown: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(shown);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    let t = ${read};
    let mode = u32(show.mode + 0.5);
    var color = t.rgb * show.scale;
    if (mode >= 1u && mode <= 4u) {
        color = vec3f(t[mode - 1u] * show.scale);
    } else if (mode == 5u) {
        // Inside a cloud the depth under its surface, warm to white; outside the distance to the nearest, in blues.
        color = mix(mix(vec3f(0.03, 0.07, 0.2), vec3f(0.35, 0.55, 0.95), t.a), mix(vec3f(0.85, 0.5, 0.25), vec3f(1.0), t.r), step(1e-4, t.r));
    } else if (mode == 6u) {
        color = vec3f(exp(-show.scale * t[u32(show.channel + 0.5)]));
    }
    textureStore(shown, vec2i(id.xy), vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), 1.0));
}`;

const pipelines = new WeakMap<GPUDevice, Record<string, GPUComputePipeline>>();
function pipelinesOf(device: GPUDevice) {
    let made = pipelines.get(device);
    if (!made) {
        made = Object.fromEntries(
            Object.entries(KINDS).map(([kind, [type, read]]) => [
                kind,
                device.createComputePipeline({
                    label: `sternwarte:cloudTexture:${kind}`,
                    layout: "auto",
                    compute: { module: device.createShaderModule({ code: shader(type, read) }), entryPoint: "main" },
                }),
            ]),
        );
        pipelines.set(device, made);
    }
    return made;
}

/** What a texture is, said before its format: a volume, one layer of an array, or a plain one. */
const DIMENSIONS = { "2d": "2D", array: "2D array", "3d": "3D" } as const;
const CHANNELS: Record<number, string> = {
    [SHOW.red]: "R",
    [SHOW.green]: "G",
    [SHOW.blue]: "B",
    [SHOW.alpha]: "A",
};

const SVG = "http://www.w3.org/2000/svg";

/**
 * A volume as a stack of `count` level slices, seen from above its corner: a click on one picks its height, 0 to 1,
 * and the one nearest `at` is marked as picked.
 */
function sliceStack(count: number, at: number, pick: (at: number) => void) {
    // In a square as large as a thumbnail, the slices as far apart as fills it.
    const [height, half, flat] = [100, 48, 15];
    const rise = (height - 2 * flat - 2) / Math.max(count - 1, 1);
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", `0 0 ${2 * half + 4} ${height}`);
    svg.setAttribute("class", "volume-slices");
    svg.setAttribute("role", "group");
    svg.setAttribute("aria-label", "Slices of the volume, from its bottom to its top");
    const heights = Array.from({ length: count }, (_, k) => (k + 0.5) / count);
    const nearest = heights.reduce(
        (best, h, k) => (Math.abs(h - at) < Math.abs((heights[best] ?? 0) - at) ? k : best),
        0,
    );
    const slices = heights.map((h, k) => {
        const y = height - flat - 1 - k * rise;
        const slice = svg.appendChild(document.createElementNS(SVG, "polygon"));
        slice.setAttribute("points", `2,${y} ${half + 2},${y - flat} ${2 * half + 2},${y} ${half + 2},${y + flat}`);
        slice.setAttribute("role", "button");
        slice.setAttribute("tabindex", "0");
        slice.setAttribute("aria-pressed", String(k === nearest));
        slice.appendChild(document.createElementNS(SVG, "title")).textContent =
            `The slice at ${Math.round(h * 100)} % of the volume's height`;
        slice.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            choose(k);
        });
        return slice;
    });
    let chosen = nearest;
    const choose = (k: number) => {
        if (k === chosen) return;
        chosen = k;
        for (const [i, slice] of slices.entries()) slice.setAttribute("aria-pressed", String(i === k));
        pick(heights[k] ?? 0);
    };
    // A press picks the slice whose front edge is under the pointer, and held, the pointer runs through them.
    const under = (event: PointerEvent) => {
        const box = svg.getBoundingClientRect();
        const y = ((event.clientY - box.top) / box.height) * height;
        choose(Math.min(Math.max(Math.round((height - 1 - y) / rise), 0), count - 1));
    };
    svg.addEventListener("pointerdown", (event) => {
        svg.setPointerCapture(event.pointerId);
        under(event);
    });
    svg.addEventListener("pointermove", (event) => {
        if (svg.hasPointerCapture(event.pointerId)) under(event);
    });
    return svg;
}

/**
 * The panel in `root`'s `[data-field="textures"]`: `show` what to draw, `encode` into the figure's frame. Its
 * thumbnails are `size` texels across, a multiple of 8.
 */
export function texturePanel(root: HTMLElement, device: GPUDevice, size = SIZE, onChange?: () => void) {
    const holder = root.querySelector<HTMLElement>('[data-field="textures"]');
    const sampler = device.createSampler({
        addressModeU: "repeat",
        addressModeV: "repeat",
        addressModeW: "clamp-to-edge",
        magFilter: "linear",
        minFilter: "linear",
    });
    const ids = new WeakMap<GPUTexture, number>();
    let count = 0;
    const idOf = (texture: GPUTexture) => {
        if (!ids.has(texture)) ids.set(texture, ++count);
        return ids.get(texture);
    };
    type Item = { pipeline: GPUComputePipeline; group: GPUBindGroup; context: GPUCanvasContext };
    let items: Item[] = [];
    let times: { note: HTMLElement; memory: string; ms: () => number | undefined; timed: string }[] = [];
    const refresh = () => {
        for (const { note, memory, ms, timed } of times) {
            const took = ms();
            const time =
                took === undefined ? "" : ` · ${took.toFixed(took < 0.095 ? 3 : 2)} ms${timed && `, ${timed}`}`;
            if (note.textContent !== memory + time) note.textContent = memory + time;
        }
    };
    let key = "";
    // The slice picked of each volume shown with a stack, by its group and label: kept where the panel is remade.
    const picked = new Map<string, number>();
    const outputs = new WeakMap<GPUTexture, GPUBindGroup>();

    return {
        /** The textures to show, in order: the panel is remade only when they or their settings change. */
        show(list: Shown[]) {
            if (!holder) return;
            const next = list
                .map((s) =>
                    [s.label, s.group, s.drawn, idOf(s.texture), s.mode, s.scale, s.at, s.channel, s.slices].join(":"),
                )
                .join("|");
            if (next === key) return;
            key = next;
            holder.replaceChildren();
            times = [];
            const made = pipelinesOf(device);
            const groups = new Map<string, HTMLElement>();
            const span = (to: HTMLElement, textContent: string) =>
                to.appendChild(Object.assign(document.createElement("span"), { textContent }));
            // What a texture is and takes, with its time kept up to date where the figure times it.
            const facts = (to: HTMLElement, s: Shown) => {
                span(to, `${DIMENSIONS[s.kind]} ${s.texture.format} ${sizeOf(s.texture, s.kind)}`);
                const memory = memoryOf(s.texture, s.kind);
                if (s.ms) times.push({ note: span(to, memory), memory, ms: s.ms, timed: s.timed ?? "" });
                else span(to, memory);
            };
            items = list.flatMap((s) => {
                let into = holder;
                if (s.group !== undefined) {
                    let group = groups.get(s.group);
                    if (!group) {
                        group = holder.appendChild(document.createElement("div"));
                        group.className = "asset-group";
                        const head = group.appendChild(document.createElement("p"));
                        head.className = "asset-head";
                        span(head, s.group);
                        if (s.drawn) span(head, s.drawn);
                        else facts(head, s);
                        group.appendChild(document.createElement("div")).className = "asset-tiles";
                        groups.set(s.group, group);
                    }
                    into = group.lastElementChild as HTMLElement;
                }
                const figure = into.appendChild(document.createElement("figure"));
                figure.className = "cloud-texture";
                figure.title = s.title;
                const canvas = figure.appendChild(document.createElement("canvas"));
                Object.assign(canvas, { width: size, height: size });
                const caption = figure.appendChild(document.createElement("figcaption"));
                const label = span(caption, s.label);
                // The channel shown, in its color: beside the label in a gallery, after it over a view.
                const channel = s.drawn ? undefined : CHANNELS[s.mode ?? SHOW.rgb];
                if (channel) {
                    const letter = Object.assign(document.createElement("b"), { textContent: channel });
                    letter.className = "texture-channel";
                    letter.dataset.channel = channel;
                    if (s.group === undefined) label.append(" ", letter);
                    else caption.append(letter);
                }
                if (s.group === undefined) facts(caption, s);
                const context = canvas.getContext("webgpu");
                const pipeline = made[s.kind];
                if (!context || !pipeline) return [];
                configureCanvas(context, SDR);
                const uniform = device.createBuffer({
                    size: 16,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                const name = `${s.group}:${s.label}`;
                const values = [s.mode ?? SHOW.rgb, s.scale ?? 1, picked.get(name) ?? s.at ?? 0, s.channel ?? 0];
                device.queue.writeBuffer(uniform, 0, new Float32Array(values));
                if (s.slices && s.kind === "3d") {
                    into.append(
                        sliceStack(s.slices, values[2] ?? 0, (at) => {
                            picked.set(name, at);
                            device.queue.writeBuffer(uniform, 8, new Float32Array([at]));
                            onChange?.();
                        }),
                    );
                }
                const view = s.texture.createView(s.kind === "array" ? { dimension: "2d-array" } : {});
                const group = device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: uniform } },
                        { binding: 1, resource: view },
                        { binding: 2, resource: sampler },
                    ],
                });
                return [{ pipeline, group, context }];
            });
        },
        /** The times under the thumbnails as they are now: for when they are read back, after the frame. */
        refresh,
        /** Draws the thumbnails, while the panel is shown. */
        encode(encoder: GPUCommandEncoder, on = true) {
            if (!holder) return;
            holder.hidden = !on;
            refresh();
            if (!on || items.length === 0) return;
            const pass = encoder.beginComputePass({ label: "sternwarte:cloudTextures" });
            for (const { pipeline, group, context } of items) {
                const target = context.getCurrentTexture();
                let output = outputs.get(target);
                if (!output) {
                    output = device.createBindGroup({
                        layout: pipeline.getBindGroupLayout(1),
                        entries: [{ binding: 0, resource: target.createView() }],
                    });
                    outputs.set(target, output);
                }
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, group);
                pass.setBindGroup(1, output);
                pass.dispatchWorkgroups(size / 8, size / 8);
            }
            pass.end();
        },
    };
}
