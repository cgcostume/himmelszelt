import { MULTI_SCATTERING_LOG2_OFFSET, spectrumToRgb, wgsl } from "@himmelszelt/dunstkreis";
import { gpu, tables } from "./atmosphere.js";

/**
 * Previews of the tables and cube maps, drawn on the GPU straight into a canvas: sampled nearest or linear, tone mapped
 * by a scale reduced from the texture itself, and sRGB encoded, with nothing read back. Nearest maps device pixel p of P
 * to texel floor((2p + 1) n / 2P), in integers, as `texelOf` does for the pointer and the highlight.
 */

/**
 * What a table's four channels hold, dunstkreis' four wavelengths: light, turned into RGB by the model's matrix, or a
 * ratio on the sunlight, shown as the color sunlight takes through it, white for 1. Cube maps are RGB already.
 */
export const SPECTRAL = { none: 0, light: 1, ratio: 2 };

/** How a preview scales the values it shows: as they are, by their maximum, or around their geometric mean. */
export const SCALE = { none: 0, max: 1, mean: 2 };

/** How each table is shown: transmittance as it is, multiple scattering by its maximum, the sky view tone mapped around
 *  its geometric mean, since it spans from night to the sun's glow. Altitude up, like a plot; the sky view as seen, the
 *  zenith at the top and its halves apart. */
export const TABLE_PREVIEW = {
    transmittance: { scale: SCALE.none, flip: true, spectral: SPECTRAL.ratio },
    // Stored as log2, decoded to the values themselves.
    multiScattering: { scale: SCALE.max, flip: true, log2: true, spectral: SPECTRAL.ratio },
    skyView: { scale: SCALE.mean, flip: false, split: true, spectral: SPECTRAL.light },
};

/** The texel device pixel `p` of `pixels` shows in nearest filtering, exactly as the preview shader picks it. */
// Params: nine scalars, padded to twelve, the mat4x3f at byte 48, the sun's spectrum at 112.
const PARAMS_SIZE = 128;

export const texelOf = (p, n, pixels) => Math.floor(((2 * p + 1) * n) / (2 * pixels));

// The output in rgba8unorm stores the values tone mapped, for the canvas and a PNG; in rgba32float as they are, for HDR.
const source = (cube, format) => `
${cube ? wgsl.cube : ""}
${wgsl.spiral}
struct Params {
    scale: u32,
    linear: u32,
    // 2D: rows bottom up, and sky and ground apart at the middle row, like the sky pass' lookup of the sky view.
    flip: u32,
    split: u32,
    // Cube: the mip level, and whether it is cubified.
    level: f32,
    cubified: u32,
    // Stored as log2 plus an offset, as dunstkreis' multiple-scattering table.
    log2: u32,
    // SPECTRAL: the four channels as they are, as light, or as a ratio on the sunlight.
    spectral: u32,
    // 2D: the table again to the left, mirrored at its first column and dimmed, the sky view's other side of the sun.
    mirror: u32,
    toRgb: mat4x3f,
    sun: vec4f,
}

fn decoded(stored: vec4f) -> vec3f {
    let c = select(stored, exp2(stored - ${MULTI_SCATTERING_LOG2_OFFSET}.0), params.log2 != 0u);
    if (params.spectral == 1u) {
        return params.toRgb * c;
    }
    if (params.spectral == 2u) {
        return params.toRgb * (c * params.sun) / (params.toRgb * params.sun);
    }
    return c.rgb;
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source: ${cube ? "texture_cube<f32>" : "texture_2d<f32>"};
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var nearestSampler: sampler;
// The maximum and the mean log2 luminance, reduced first.
@group(0) @binding(4) var<storage, read_write> reduced: vec2f;
@group(0) @binding(5) var output: texture_storage_2d<${format}, write>;

const PI: f32 = 3.141592653589793;
const LUMINANCE = vec3f(0.2126, 0.7152, 0.0722);
const THREADS: u32 = 256u;

var<workgroup> sums: array<vec2f, THREADS>;

fn sampleDirection(d: vec3f, s: sampler) -> vec3f {
    ${cube ? "return textureSampleLevel(source, s, select(d, dkCubeFromSphere(d), params.cubified != 0u), params.level).rgb;" : "return vec3f(0.0);"}
}

fn gather(c: vec3f, sum: vec2f) -> vec2f {
    return vec2f(max(sum.x, max(c.r, max(c.g, c.b))), sum.y + log2(max(dot(c, LUMINANCE), 1e-6)));
}

// The texture's maximum and mean log2 luminance: over its texels, or for a cube map, over directions spread evenly by a
// Fibonacci spiral, so no face's corners weigh more than its middle.
@compute @workgroup_size(THREADS)
fn reduce(@builtin(local_invocation_index) index: u32) {
    var sum = vec2f(0.0);
    var count: u32;
    ${
        cube
            ? `count = THREADS * 16u;
    for (var i = index; i < count; i = i + THREADS) {
        let k = f32(i) + 0.5;
        let z = 1.0 - 2.0 * k / f32(count);
        let r = sqrt(max(1.0 - z * z, 0.0));
        let azimuth = dkGoldenAzimuth(i);
        sum = gather(sampleDirection(vec3f(r * cos(azimuth), r * sin(azimuth), z), linearSampler), sum);
    }`
            : `let size = textureDimensions(source);
    count = size.x * size.y;
    for (var i = index; i < count; i = i + THREADS) {
        sum = gather(decoded(textureLoad(source, vec2u(i % size.x, i / size.x), 0)), sum);
    }`
    }
    sums[index] = sum;
    workgroupBarrier();
    for (var stride = THREADS / 2u; stride > 0u; stride = stride / 2u) {
        if (index < stride) {
            sums[index] = vec2f(max(sums[index].x, sums[index + stride].x), sums[index].y + sums[index + stride].y);
        }
        workgroupBarrier();
    }
    if (index == 0u) {
        reduced = vec2f(sums[0].x, sums[0].y / f32(count));
    }
}

fn toneMap(c: vec3f) -> vec3f {
    var v = c;
    if (params.scale == 1u) {
        v = c / max(reduced.x, 1e-12);
    } else if (params.scale == 2u) {
        let key = 0.18 / exp2(reduced.y);
        v = c * key / (1.0 + dot(c, LUMINANCE) * key);
    }
    let m = clamp(v, vec3f(0.0), vec3f(1.0));
    return select(1.055 * pow(m, vec3f(1.0 / 2.4)) - 0.055, m * 12.92, m <= vec3f(0.0031308));
}

@compute @workgroup_size(8, 8)
fn display(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(output);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    var c: vec3f;
    ${
        cube
            ? `// Unrolled into a panorama: azimuth from north through east across, altitude up.
    let altitude = 0.5 * PI - (f32(id.y) + 0.5) / f32(size.y) * PI;
    let azimuth = (f32(id.x) + 0.5) / f32(size.x) * 2.0 * PI;
    let d = vec3f(cos(altitude) * sin(azimuth), cos(altitude) * cos(azimuth), sin(altitude));
    if (params.linear != 0u) {
        c = sampleDirection(d, linearSampler);
    } else {
        c = sampleDirection(d, nearestSampler);
    }`
            : `let n = textureDimensions(source);
    let mirrored = params.mirror != 0u;
    let columns = select(n.x, 2u * n.x, mirrored);
    if (params.linear == 0u) {
        var texel = (2u * id.xy + 1u) * vec2u(columns, n.y) / (2u * size);
        if (mirrored) {
            texel.x = select(n.x - 1u - texel.x, texel.x - n.x, texel.x >= n.x);
        }
        c = decoded(textureLoad(source, vec2u(texel.x, select(texel.y, n.y - 1u - texel.y, params.flip != 0u)), 0));
    } else {
        let fraction = (vec2f(id.xy) + 0.5) / vec2f(size);
        var uv = vec2f(
            select(fraction.x, abs(2.0 * fraction.x - 1.0), mirrored),
            select(fraction.y, 1.0 - fraction.y, params.flip != 0u),
        );
        if (params.split != 0u) {
            let half = 0.5 / f32(n.y);
            uv.y = select(max(uv.y, 0.5 + half), min(uv.y, 0.5 - half), fraction.y < 0.5);
        }
        c = decoded(textureSampleLevel(source, linearSampler, uv, 0.0));
    }`
    }
    ${cube ? "" : "if (params.mirror != 0u && 2u * id.x < size.x) { c = c * 0.2; }"}
    textureStore(output, vec2i(id.xy), vec4f(${format === "rgba8unorm" ? "toneMap(c)" : "c"}, 1.0));
}
`;

const pipelines = new Map();
function pipelinesFor(cube, format) {
    const key = `${cube},${format}`;
    if (!pipelines.has(key)) {
        const { device } = gpu;
        const module = device.createShaderModule({ label: "sternwarte:preview", code: source(cube, format) });
        const create = (entryPoint) =>
            device.createComputePipeline({
                label: `sternwarte:${entryPoint}`,
                layout: "auto",
                compute: { module, entryPoint },
            });
        pipelines.set(key, { reduce: create("reduce"), display: create("display") });
    }
    return pipelines.get(key);
}

let samplers = null;

/**
 * Records `texture` drawn into `output`, a storage view of `width` by `height` in `format`: a 2D table, or with `cube`,
 * a cube map unrolled into a panorama at mip `level`, `cubified` or not. `filter` is "nearest" or "linear", `scale` one
 * of `SCALE`; `flip` shows a table's rows bottom up, `split` keeps its halves apart, `mirror` adds it mirrored, dimmed.
 */
function encode(encoder, texture, options, output, width, height, format, buffers) {
    const { device } = gpu;
    const { cube = false, filter = "nearest", scale = SCALE.none, flip = false, split = false } = options;
    const { level = 0, cubified = false, log2 = false, spectral = SPECTRAL.none, mirror = false } = options;
    samplers ??= {
        linear: device.createSampler({ magFilter: "linear", minFilter: "linear" }),
        nearest: device.createSampler(),
    };
    const { reduce, display } = pipelinesFor(cube, format);
    const data = new ArrayBuffer(PARAMS_SIZE);
    const flags = [scale, filter === "linear" ? 1 : 0, flip ? 1 : 0, split ? 1 : 0, 0, cubified ? 1 : 0, log2 ? 1 : 0];
    new Uint32Array(data).set([...flags, spectral, mirror ? 1 : 0]);
    const floats = new Float32Array(data);
    floats[4] = level;
    // The tables' model: its matrix, column by column, padded to four floats, and the sun's spectrum.
    const model = tables()?.luts.model;
    if (spectral !== SPECTRAL.none && model) {
        const matrix = spectrumToRgb(model);
        for (let j = 0; j < 4; ++j) floats.set([matrix[0][j], matrix[1][j], matrix[2][j]], 12 + j * 4);
        floats.set(model.solarSpectrum, 28);
    }
    device.queue.writeBuffer(buffers.params, 0, data);
    const all = [
        { binding: 0, resource: { buffer: buffers.params } },
        { binding: 1, resource: texture.createView(cube ? { dimension: "cube" } : {}) },
        { binding: 2, resource: samplers.linear },
        { binding: 3, resource: samplers.nearest },
        { binding: 4, resource: { buffer: buffers.reduced } },
        { binding: 5, resource: output },
    ];
    // "auto" layouts hold only what each entry point uses.
    const bindGroup = (pipeline, bindings) =>
        device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: all.filter(({ binding }) => bindings.includes(binding)),
        });
    const pass = encoder.beginComputePass({ label: "sternwarte:preview" });
    // The linear output needs no scale; the tone mapped one reads it in every mode but "none".
    if (scale !== SCALE.none && format === "rgba8unorm") {
        pass.setPipeline(reduce);
        pass.setBindGroup(0, bindGroup(reduce, cube ? [0, 1, 2, 4] : [0, 1, 4]));
        pass.dispatchWorkgroups(1);
    }
    pass.setPipeline(display);
    const toneMapped = format === "rgba8unorm" ? [4] : [];
    const bindings = cube ? [0, 1, 2, 3, 5, ...toneMapped] : [0, 1, 2, 5, ...toneMapped];
    pass.setBindGroup(0, bindGroup(display, bindings));
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
}

const createBuffers = () => ({
    params: gpu.device.createBuffer({ size: PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    reduced: gpu.device.createBuffer({ size: 8, usage: GPUBufferUsage.STORAGE }),
});

/** A preview drawing into `canvas`, which it takes over as a WebGPU canvas. */
export function createPreview(canvas) {
    const { device } = gpu;
    const context = canvas.getContext("webgpu");
    context.configure({
        device,
        format: "rgba8unorm",
        alphaMode: "opaque",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING,
    });
    const buffers = createBuffers();
    return {
        /** Draws `texture` over the canvas' device pixels, with the options `encode` takes. */
        draw(texture, options) {
            const dpr = window.devicePixelRatio || 1;
            const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
            const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
            if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
            const encoder = device.createCommandEncoder({ label: "sternwarte:preview" });
            const output = context.getCurrentTexture().createView();
            encode(encoder, texture, options, output, width, height, "rgba8unorm", buffers);
            device.queue.submit([encoder.finish()]);
        },
    };
}

/**
 * `texture` rendered offscreen at `width` by `height` and read back: tone mapped as 8-bit RGBA for a PNG, or with
 * `hdr`, the values themselves as 32-bit floats, four a pixel, row after row.
 */
export async function renderPixels(texture, options, width, height, hdr = false) {
    const { device } = gpu;
    const format = hdr ? "rgba32float" : "rgba8unorm";
    const target = device.createTexture({
        size: { width, height },
        format,
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const bytesPerPixel = hdr ? 16 : 4;
    const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
    const readback = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const buffers = createBuffers();
    const encoder = device.createCommandEncoder({ label: "sternwarte:export" });
    encode(encoder, texture, options, target.createView(), width, height, format, buffers);
    encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow }, { width, height });
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(readback.getMappedRange());
    const pixels = new Uint8Array(width * height * bytesPerPixel);
    for (let y = 0; y < height; ++y) {
        pixels.set(
            mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * bytesPerPixel),
            y * width * bytesPerPixel,
        );
    }
    readback.unmap();
    for (const resource of [readback, target, buffers.params, buffers.reduced]) resource.destroy();
    return hdr ? new Float32Array(pixels.buffer) : new Uint8ClampedArray(pixels.buffer);
}
