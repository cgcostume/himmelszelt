import type { AtmosphereLUTs, SkyPass } from "@himmelszelt/dunstkreis";
import {
    apparentDirection,
    createSkyPass,
    DEFAULT_ATMOSPHERE_MODEL,
    precomputeAtmosphere,
    wgsl,
} from "@himmelszelt/dunstkreis";
import { fromJulianDay, julianDayFromDate, julianEphemerisDay, sun } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { onDemand } from "../frame";
import { COMPASS } from "../sternzeit/figure";
import { configureCanvas, gpu, gpuDevice, onTables, quality, SDR, tables } from "./atmosphere";

// The Sun rising over the planet's rim from the space station, rendered next to a photograph of it: a fixed moment and
// place, not the page's, with the Sun 0.6 degrees below the rim, where the air squeezes it most.

const DEG = Math.PI / 180;
const SVG = "http://www.w3.org/2000/svg";
const time = fromJulianDay(julianDayFromDate(new Date("2026-04-06T02:04:00Z")));
const observer = { latitude: 52.395, longitude: 13.085, heightM: 408_000 };
const sunDirection = sun.direction(time, observer);
const sunAngularDiameter = sun.apparentAngularDiameter(julianEphemerisDay(time));
// The photograph's: a Nikon D4's 23.9 mm sensor height behind 500 mm, and its exposure, f/10 at 1/400 s and ISO 1000.
const PHOTO_FOV = 2 * Math.atan(11.95 / 500);
const PHOTO_EV100 = Math.log2(10 ** 2 * 400) - Math.log2(1000 / 100);

type Vec3 = [number, number, number];
const dot = (a: readonly number[], b: readonly number[]) =>
    (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
const altitudeOf = (d: readonly number[]) => Math.atan2(d[2] ?? 0, Math.hypot(d[0] ?? 0, d[1] ?? 0));

const root = find<HTMLElement>("#refraction");
const canvas = find<HTMLCanvasElement>('[data-field="canvas"]', root);
const overlay = find<SVGSVGElement>('[data-field="overlay"]', root);

// Aimed at where the Sun shows, so it stays in view with the refraction off.
const aim = apparentDirection(sunDirection, DEFAULT_ATMOSPHERE_MODEL, observer.heightM);
const camera = { yaw: Math.atan2(aim[0], aim[1]), pitch: altitudeOf(aim), fov: PHOTO_FOV };

function basis(aspect: number) {
    const { yaw, pitch, fov } = camera;
    const f: Vec3 = [Math.cos(pitch) * Math.sin(yaw), Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch)];
    const r: Vec3 = [Math.cos(yaw), -Math.sin(yaw), 0];
    const u: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const ty = Math.tan(fov / 2);
    return { f, r, u, tx: ty * aspect, ty };
}
type Basis = ReturnType<typeof basis>;

/** The ray through the view at `x`, `y` from -1 to 1, right and up. */
const ray = ({ f, r, u, tx, ty }: Basis, x: number, y: number): Vec3 =>
    [0, 1, 2].map((i) => (f[i] ?? 0) + x * tx * (r[i] ?? 0) + y * ty * (u[i] ?? 0)) as Vec3;

/** Where the altitude `a` crosses the view's left edge, from -1 to 1 up, by bisection: it only grows upwards. */
function edgeY(b: Basis, a: number) {
    let [low, high] = [-1.5, 1.5];
    for (let i = 0; i < 32; i++) {
        const middle = (low + high) / 2;
        if (altitudeOf(ray(b, -1, middle)) < a) low = middle;
        else high = middle;
    }
    return (low + high) / 2;
}

const svg = (name: string, attributes: Record<string, string | number>, text?: string) => {
    const element = document.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (text) element.textContent = text;
    return element;
};

/** The compass directions where they meet the horizon, and the altitude along the left edge, in steps that keep their
 *  labels apart. */
function drawOverlay(b: Basis, width: number, height: number) {
    overlay.replaceChildren();
    overlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
    COMPASS.forEach((name, i) => {
        const direction = [Math.sin(i * 45 * DEG), Math.cos(i * 45 * DEG), 0];
        const along = dot(direction, b.f);
        if (along <= 0) return;
        const x = (dot(direction, b.r) / along / b.tx + 1) * 0.5 * width;
        const y = (1 - dot(direction, b.u) / along / b.ty) * 0.5 * height;
        overlay.append(svg("text", { class: "refraction-compass", x, y }, name));
    });
    // The Sun's name inside the circle where it truly is, fading out as the circle shrinks around it.
    const along = dot(sunDirection, b.f);
    const fit = Math.min(1, Math.max(0, ((sunAngularDiameter * DEG * height) / 2 / camera.fov - 16) / 8));
    if (along > 0 && fit > 0) {
        const x = (dot(sunDirection, b.r) / along / b.tx + 1) * 0.5 * width;
        const y = (1 - dot(sunDirection, b.u) / along / b.ty) * 0.5 * height;
        const opacity = fit * fit * (3 - 2 * fit);
        overlay.append(svg("text", { class: "refraction-compass", x, y, opacity }, "Sun"));
    }
    const perDegree = height / (camera.fov / DEG);
    const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20].find((s) => s * perDegree >= 32) ?? 20;
    const minor = step / (step * perDegree >= 60 ? 5 : 2);
    const top = altitudeOf(ray(b, -1, 1)) / DEG;
    const bottom = altitudeOf(ray(b, -1, -1)) / DEG;
    const decimals = step < 1 ? 1 : 0;
    for (let n = Math.ceil(bottom / minor); n * minor <= top; n++) {
        const a = n * minor;
        const y = (1 - edgeY(b, a * DEG)) * 0.5 * height;
        const major = Math.abs(a / step - Math.round(a / step)) < 1e-6;
        overlay.append(svg("line", { class: "refraction-tick", x1: 0, x2: major ? 6 : 3, y1: y, y2: y }));
        if (major && y > 10 && y < height - 6) {
            const label = `${a.toFixed(decimals).replace("-", "−")}°`;
            overlay.append(svg("text", { class: "refraction-label", x: 9, y: y + 3 }, label));
        }
    }
}

// A camera's glow around what is brightest: the linear sky halved level by level down a pyramid, each texel the mean of
// the sixteen under it, then summed back up with a tent filter, so every level adds a blur twice as wide as the one
// before. Mixed into the sky by a small share, it moves light rather than adding it; then tone mapped and dithered.
const GLOW = 0.002;
const GLOW_LEVELS = 8;
const glowSource = `
${wgsl.tonemap}

struct Params {
    glow: f32,
    levels: f32,
}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linear: sampler;
@group(0) @binding(2) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var level: texture_2d<f32>;
@group(0) @binding(4) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var<uniform> params: Params;
@group(0) @binding(6) var clear: texture_2d<f32>;

// The disc's light can run past what half floats hold: scaled down whole, its color kept.
fn held(light: vec4f) -> vec4f {
    let peak = max(light.r, max(light.g, light.b));
    return select(light, light * (6e4 / peak), peak > 6e4);
}

fn tent(uv: vec2f, texel: vec2f) -> vec4f {
    var sum = vec4f(0.0);
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let weight = f32((2 - abs(x)) * (2 - abs(y)));
            sum += weight * textureSampleLevel(source, linear, uv + vec2f(f32(x), f32(y)) * texel, 0.0);
        }
    }
    return sum / 16.0;
}

@compute @workgroup_size(8, 8, 1)
fn down(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(destination);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    let texel = 1.0 / vec2f(textureDimensions(source));
    var sum = vec4f(0.0);
    for (var i = 0; i < 4; i++) {
        let offset = vec2f(f32(i & 1) * 2.0 - 1.0, f32(i >> 1) * 2.0 - 1.0);
        sum += held(textureSampleLevel(source, linear, uv + offset * texel, 0.0));
    }
    textureStore(destination, id.xy, sum / 4.0);
}

@compute @workgroup_size(8, 8, 1)
fn up(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(destination);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    let below = tent(uv, 1.0 / vec2f(textureDimensions(source)));
    textureStore(destination, id.xy, textureLoad(level, id.xy, 0) + below);
}

fn noise(p: vec2u) -> f32 {
    var h = p.x * 1664525u + p.y * 1013904223u;
    h = (h ^ (h >> 16u)) * 2246822519u;
    h = h ^ (h >> 13u);
    return f32(h & 0xffffu) / 65535.0;
}

@compute @workgroup_size(8, 8, 1)
fn composite(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(output);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    // The sky without the disc, and the disc's own light from the difference to the sky with it, by the share of the
    // pixel it covers: tone mapped apart and mixed after, so a pixel the disc barely touches does not turn white.
    let lit = textureLoad(level, id.xy, 0);
    var sky = held(textureLoad(clear, id.xy, 0)).rgb;
    let share = lit.a;
    var disc = held(vec4f(max(lit.rgb - sky, vec3f(0.0)) / max(share, 1e-4), 1.0)).rgb;
    if (params.glow > 0.0) {
        let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
        let glow = tent(uv, 1.0 / vec2f(textureDimensions(source))).rgb / params.levels;
        sky = mix(sky, glow, params.glow);
        disc = disc * (1.0 - params.glow);
    }
    let mapped = mix(dkToneMapNeutral(sky), dkToneMapNeutral(sky + disc), share);
    let encoded = mapped + (noise(id.xy) - 0.5) / 255.0;
    textureStore(output, id.xy, vec4f(clamp(encoded, vec3f(0.0), vec3f(1.0)), 1.0));
}
`;

let glowPipelines: Record<"down" | "up" | "composite", GPUComputePipeline> | null = null;
let glowSampler: GPUSampler | null = null;
let glowParams: GPUBuffer | null = null;
// The sky, linear and exposed, and the pyramid's levels, each with its sum of the levels below.
let glowTextures: { sky: GPUTexture; clear: GPUTexture; levels: GPUTexture[]; sums: GPUTexture[] } | null = null;

function glowResources(width: number, height: number) {
    const device = gpuDevice();
    if (!glowPipelines) {
        const module = device.createShaderModule({ label: "sternwarte:glow", code: glowSource });
        const make = (entryPoint: string) =>
            device.createComputePipeline({
                label: `sternwarte:glow:${entryPoint}`,
                layout: "auto",
                compute: { module, entryPoint },
            });
        glowPipelines = { down: make("down"), up: make("up"), composite: make("composite") };
        glowSampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
        glowParams = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    if (glowTextures?.sky.width !== width || glowTextures.sky.height !== height) {
        if (glowTextures)
            for (const texture of [glowTextures.sky, glowTextures.clear, ...glowTextures.levels, ...glowTextures.sums])
                texture.destroy();
        const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
        const texture = (w: number, h: number) =>
            device.createTexture({ size: [Math.max(1, w), Math.max(1, h)], format: "rgba16float", usage });
        const levels: GPUTexture[] = [];
        const sums: GPUTexture[] = [];
        for (let i = 1; i <= GLOW_LEVELS && Math.min(width, height) >> i >= 2; i++) {
            levels.push(texture(width >> i, height >> i));
            sums.push(texture(width >> i, height >> i));
        }
        glowTextures = { sky: texture(width, height), clear: texture(width, height), levels, sums };
    }
    return {
        pipelines: glowPipelines,
        sampler: glowSampler as GPUSampler,
        params: glowParams as GPUBuffer,
        ...glowTextures,
    };
}

/** Records the glow over the linear sky in `sky` and writes it, tone mapped, into `target`. */
function encodeGlow(encoder: GPUCommandEncoder, target: GPUTexture) {
    const device = gpuDevice();
    const { pipelines, sampler, params, sky, clear, levels, sums } = glowResources(target.width, target.height);
    device.queue.writeBuffer(params, 0, new Float32Array([GLOW, levels.length, 0, 0]));
    const dispatch = (pipeline: GPUComputePipeline, entries: [number, GPUBindingResource][], size: GPUTexture) => {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(
            0,
            device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: entries.map(([binding, resource]) => ({ binding, resource })),
            }),
        );
        pass.dispatchWorkgroups(Math.ceil(size.width / 8), Math.ceil(size.height / 8));
        pass.end();
    };
    const view = (texture: GPUTexture) => texture.createView();
    levels.forEach((texture, i) => {
        dispatch(
            pipelines.down,
            [
                [0, view(levels[i - 1] ?? sky)],
                [1, sampler],
                [2, view(texture)],
            ],
            texture,
        );
    });
    for (let i = levels.length - 2; i >= 0; i--) {
        const [level, sum, below] = [levels[i], sums[i], i === levels.length - 2 ? levels[i + 1] : sums[i + 1]];
        if (!level || !sum || !below) continue;
        dispatch(
            pipelines.up,
            [
                [0, view(below)],
                [1, sampler],
                [2, view(sum)],
                [3, view(level)],
            ],
            sum,
        );
    }

    const top = (levels.length > 1 ? sums[0] : levels[0]) ?? sky;
    const entries: [number, GPUBindingResource][] = [
        [0, view(top)],
        [1, sampler],
        [3, view(sky)],
        [4, view(target)],
        [6, view(clear)],
    ];
    dispatch(pipelines.composite, [...entries, [5, { buffer: params }]], target);
}

// The figure's own tables, the page's model with the refraction the switch asks for where the page's differ.
type Own = { from: AtmosphereLUTs; bent: boolean; luts?: AtmosphereLUTs };
let own: Own | null = null;

function drawTables(): AtmosphereLUTs | null {
    const page = tables()?.luts;
    if (!page) return null;
    const pageBent = page.model.refractivity > 0;
    // Always bent, even where the page's tables are not.
    const bent = true;
    if (bent === pageBent) return page;
    if (own?.from === page && own.bent === bent) return own.luts ?? null;
    const asked: Own = { from: page, bent };
    own = asked;
    const refractivity = bent ? DEFAULT_ATMOSPHERE_MODEL.refractivity : 0;
    precomputeAtmosphere(gpuDevice(), { model: { ...page.model, refractivity }, config: page.config }).then((luts) => {
        if (own !== asked) return luts.destroy();
        asked.luts = luts;
        draw();
    });
    return null;
}

// The sky with the disc, its share of each pixel in alpha, and the sky without it.
let pass: { lit: SkyPass; clear: SkyPass } | null = null;
let passLuts: AtmosphereLUTs | null = null;
let passFor: { luts?: AtmosphereLUTs; building?: boolean } = {};

const draw = onDemand(() => {
    const luts = drawTables();
    const context = canvas.getContext("webgpu");
    if (!luts || !context) return;
    if (passFor.luts !== luts) {
        if (passFor.building) return;
        const settings = { luts, building: true };
        passFor = settings;
        const options = { luts, format: "rgba16float" as const, toneMap: false as const, debugGrid: true };
        const made = { ...options, groundLight: quality.groundLight };
        Promise.all([
            createSkyPass(gpuDevice(), { ...made, discAlpha: true }),
            createSkyPass(gpuDevice(), { ...made, sunDisc: false }),
        ]).then(([lit, clear]) => {
            const next = { lit, clear };
            const old = passLuts;
            pass?.lit.destroy();
            pass?.clear.destroy();
            // Own tables nothing draws with any more.
            if (old && old !== luts && old !== tables()?.luts && old !== own?.luts) old.destroy();
            pass = next;
            passLuts = luts;
            settings.building = false;
            draw();
        });
        return;
    }
    if (!pass) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    const b = basis(width / height);
    const { r, u, f, tx, ty } = b;
    const params = {
        sunDirection,
        sunAngularDiameter,
        observerHeightM: observer.heightM,
        ev100: PHOTO_EV100,
        pixelRatio: dpr,
        inverseViewProjection: new Float32Array([
            ...r.map((c) => c * tx),
            0,
            ...u.map((c) => c * ty),
            0,
            0,
            0,
            0,
            1,
            ...f,
            0,
        ]),
    };
    const encoder = gpuDevice().createCommandEncoder();
    const target = context.getCurrentTexture();
    const { sky, clear } = glowResources(width, height);
    pass.lit.update(params, encoder);
    pass.clear.update(params, encoder);
    pass.lit.encode(encoder, sky);
    pass.clear.encode(encoder, clear);
    encodeGlow(encoder, target);
    gpuDevice().queue.submit([encoder.finish()]);
    drawOverlay(b, canvas.clientWidth, canvas.clientHeight);
}, canvas);

if (gpu.device) {
    const context = canvas.getContext("webgpu");
    if (context) configureCanvas(context, SDR);
    canvas.addEventListener("pointerdown", (event) => {
        canvas.setPointerCapture(event.pointerId);
        const start = { x: event.clientX, y: event.clientY, yaw: camera.yaw, pitch: camera.pitch };
        // A pixel of drag turns the view by a pixel's worth of the field of view, so the sky follows the pointer.
        const move = (e: PointerEvent) => {
            const perPixel = camera.fov / canvas.clientHeight;
            camera.yaw = start.yaw - (e.clientX - start.x) * perPixel;
            camera.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, start.pitch + (e.clientY - start.y) * perPixel));
            draw();
        };
        canvas.addEventListener("pointermove", move);
        canvas.addEventListener("pointerup", () => canvas.removeEventListener("pointermove", move), { once: true });
    });
    canvas.addEventListener(
        "wheel",
        (event) => {
            event.preventDefault();
            camera.fov = Math.max(0.2 * DEG, Math.min(90 * DEG, camera.fov * Math.exp(event.deltaY * 0.001)));
            draw();
        },
        { passive: false },
    );
    onTables(draw);
    new ResizeObserver(draw).observe(canvas);
    draw();
} else if (gpu.error) {
    const error = document.createElement("div");
    error.className = "sky-error";
    error.innerHTML = `<p>${gpu.error}</p>`;
    canvas.replaceWith(error);
}
