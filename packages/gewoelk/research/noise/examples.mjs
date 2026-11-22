// Pictures of the noise before and now, side by side in `out/`, the baseline's on the left: the functions themselves,
// the maps the package bakes from them, and the sheets' noise. Each picture's mean is printed beside its name.
import { mkdirSync } from "node:fs";
import { gpu, layerMapGroups, noise2, pipelineOf, png, SIDES } from "./lib.mjs";
import { cloudModel, highModel, layerModel, storageFormat } from "./models.mjs";

const { device } = await gpu();
const OUT = new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const STORAGE = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;
const uniform = (data) => {
    const buffer = device.createBuffer({
        size: Math.ceil(data.byteLength / 16) * 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, data);
    return { buffer };
};

// Everything rendered lands in one buffer, read once at the end: [name, side] to where its texels start.
const jobs = [];
const encoder = device.createCommandEncoder();
async function run(code, entry, entries, texture, dispatch) {
    const pipeline = await pipelineOf(device, code, entry);
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
        0,
        device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: entries.map((resource, binding) => ({ binding, resource })),
        }),
    );
    pass.dispatchWorkgroups(...dispatch);
    pass.end();
    return texture;
}

// A picture of an expression of `p`, a point `span` units across the picture, and of the texel `id`.
const SIZE = 512;
async function picture(name, side, prelude, expression, span) {
    const texture = device.createTexture({ size: [SIZE, SIZE], format: "rgba16float", usage: STORAGE });
    await run(
        `${prelude}
@group(0) @binding(0) var o: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let p = (vec2f(id.xy) + 0.5) / ${SIZE}.0 * ${span.toFixed(3)};
    textureStore(o, vec2i(id.xy), vec4f(${expression}));
}`,
        "main",
        [texture.createView()],
        texture,
        [SIZE / 8, SIZE / 8],
    );
    jobs.push({ name, side, texture, size: SIZE, layer: 0, channel: 0, bytes: 8 });
}

// The functions: a slice of each, 12 cells across.
const FUNCTIONS = {
    "1-perlin": "0.5 + 0.5 * gwPerlin(vec3f(p, 0.37), vec3i(12), 3u)",
    "1-fbm": "0.5 + 0.5 * tanh((gwFbm(vec3f(p / 3.0, 0.37), vec3i(4, 4, 8), 5u, 3u) - 0.5) * 4.8)",
    "1-alligator": "gwAlligator(vec3f(p, 0.37), vec3i(12), 3u) * 1.6",
    "1-curly-alligator": "gwCurlyAlligator(vec3f(p, 0.37), vec3i(12), 3u, 0.6)",
};
for (const [name, expression] of Object.entries(FUNCTIONS)) {
    for (const [side, { shader }] of SIDES.entries()) await picture(name, side, shader("noise.wgsl"), expression, 12);
}

// The sheets' noise, km across the picture: gwSheet's density of a patch, as it stacks them.
const density = (noise) => `
fn exampleFlow(ground: vec2f) -> vec2f {
    let sweep = ${noise("ground / 15.0", "0.5", "3u")} * 2.4;
    let hook = ${noise("ground / 3.0", "1.5", "4u")} * 0.48;
    return vec2f(ground.x, ground.y + sweep + hook);
}
fn exampleSheet(ground: vec2f, ripples: f32) -> f32 {
    let footprint = 0.002;
    let flow = exampleFlow(ground);
    let bundle = 0.5 + 0.5 * ${noise("vec2f(flow.x / 9.9, flow.y / 3.0)", "5.7", "15u")};
    let fiber = gwFibers(flow, 0.6, 4.0, 10.0, footprint, 3u) * mix(1.0, smoothstep(0.45, 0.8, bundle), 0.5);
    let eroding = (1.0 - fiber) * 0.7 * 0.9;
    var n = clamp((0.75 - eroding) / max(1.0 - eroding, 1e-3), 0.0, 1.0) * mix(1.0, 1.8 * fiber, 0.7);
    n = n * mix(1.0, gwRipples(flow, 0.6, footprint, 3u), ripples);
    let broad = ${noise("ground / 12.0", "8.9", "33u")};
    let flocking = (1.0 - gwFlocks(ground, 0.15, footprint, 3u)) * 0.15;
    n = clamp((n - flocking) / max(1.0 - flocking, 1e-3), 0.0, 1.0);
    return n * mix(1.0, 2.0 * gwGrain(ground, 0.1, footprint, 3u), 0.5) * max(1.0 + 0.4 * broad, 0.0);
}`;
const sheets = SIDES.map(({ shader }) => {
    const [noise, sheet] = [shader("noise.wgsl"), shader("sheet.wgsl")];
    const functions = sheet.slice(
        sheet.indexOf("// A sheet's fibers"),
        sheet.indexOf("// Light scattered along a ray"),
    );
    return `${noise}\n${functions}\n${density((p, z, seed) => noise2(sheet, p, seed, z))}`;
});
const SHEETS = {
    "3-sheet-fibers-6km": ["gwFibers(exampleFlow(p), 0.6, 4.0, 10.0, 0.002, 3u)", 6],
    "3-sheet-flocks-1.5km": ["gwFlocks(p, 0.15, 0.002, 3u)", 1.5],
    "3-sheet-grain-1km": ["gwGrain(p, 0.1, 0.002, 3u)", 1],
    "3-sheet-ripples-6km": ["gwRipples(exampleFlow(p), 0.6, 0.002, 3u)", 6],
    "3-sheet-whole-24km": ["exampleSheet(p, 0.0)", 24],
    "3-sheet-whole-6km": ["exampleSheet(p, 0.0)", 6],
    "3-sheet-rippled-12km": ["exampleSheet(p, 1.0)", 12],
};
for (const [name, [expression, span]] of Object.entries(SHEETS))
    for (const side of [0, 1]) await picture(name, side, sheets[side], expression, span);

// The maps, baked by the package's shaders from each noise.
for (const [side, { shader }] of SIDES.entries()) {
    const noise = shader("noise.wgsl");
    const cloud = device.createTexture({ size: [512, 512, 1], format: "rgba16float", usage: STORAGE });
    await run(
        `${noise}\n${shader("params.wgsl")}\n${shader("cloudmap.comp.wgsl")}`,
        "gwCloudMap",
        [uniform(cloudModel(0.5)), cloud.createView({ dimension: "2d-array" })],
        cloud,
        [64, 64],
    );
    jobs.push({ name: "2-cloudmap-coverage", side, texture: cloud, size: 512, layer: 0, channel: 0, bytes: 8 });
    jobs.push({ name: "2-cloudmap-towers", side, texture: cloud, size: 512, layer: 0, channel: 3, bytes: 8 });
    const layers = device.createTexture({ size: [512, 512, 3], format: "rgba16float", usage: STORAGE });
    for (const [layer, [kind, label]] of [
        [0, "heaps"],
        [2, "towers"],
        [3, "front"],
    ].entries()) {
        const layermap = shader("layermap.comp.wgsl");
        const groups = layerMapGroups(layermap, 512);
        await run(
            `${noise}\n${layermap}`,
            "gwLayerMap",
            [uniform(layerModel(kind, layer)), layers.createView({ dimension: "2d-array" })],
            layers,
            [groups, groups],
        );
        jobs.push({ name: `2-layermap-${label}`, side, texture: layers, size: 512, layer, channel: 0, bytes: 8 });
        if (kind === 2)
            jobs.push({
                name: "2-layermap-towers-anvils",
                side,
                texture: layers,
                size: 512,
                layer,
                channel: 1,
                bytes: 8,
            });
    }
    // The map's format as its shader declares it: rgba16float at first, rgba8unorm since its amounts are applied at the read.
    const highmap = shader("highmap.comp.wgsl");
    const highFormat = storageFormat(highmap, "gwHighMapOut");
    const high = device.createTexture({ size: [2048, 2048], format: highFormat, usage: STORAGE });
    await run(
        `${noise}\n${highmap}`,
        "gwHighMapBake",
        [uniform(highModel(highmap, 0)), high.createView()],
        high,
        [256, 256],
    );
    // A quarter of the tile, at the map's own texels.
    for (const [channel, label] of ["puffs", "veil", "broad", "billows"].entries())
        jobs.push({
            name: `2-highmap-${label}`,
            side,
            texture: high,
            size: 2048,
            crop: channel === 2 ? 0 : 512,
            layer: 0,
            channel,
            bytes: highFormat === "rgba16float" ? 8 : 4,
        });
    const detail = device.createTexture({
        dimension: "3d",
        size: [128, 128, 128],
        format: "rgba8unorm",
        usage: STORAGE,
    });
    await run(`${noise}\n${shader("detail.comp.wgsl")}`, "gwDetail", [detail.createView()], detail, [32, 32, 32]);
    for (const [channel, label] of ["wispy-low", "wispy-high", "billowy-low", "billowy-high"].entries())
        jobs.push({ name: `2-detail-${label}`, side, texture: detail, size: 128, layer: 0, channel, bytes: 4 });
}

// One copy of each texture's layer, one buffer, one map.
const copies = new Map();
let total = 0;
for (const job of jobs) {
    const key = `${jobs.findIndex((j) => j.texture === job.texture)}/${job.layer}`;
    if (!copies.has(key)) {
        copies.set(key, { offset: total, job });
        total += job.size * job.size * job.bytes;
    }
    job.offset = copies.get(key).offset;
}
const read = device.createBuffer({ size: total, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
for (const { offset, job } of copies.values())
    encoder.copyTextureToBuffer(
        { texture: job.texture, origin: [0, 0, job.layer] },
        { buffer: read, offset, bytesPerRow: job.size * job.bytes, rowsPerImage: job.size },
        [job.size, job.size, 1],
    );
device.queue.submit([encoder.finish()]);
await read.mapAsync(GPUMapMode.READ);
const bytes = read.getMappedRange().slice(0);

const half = (h) => {
    const [sign, exponent, fraction] = [h & 0x8000 ? -1 : 1, (h >> 10) & 31, h & 1023];
    return sign * (exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15));
};
/** A job's picture as 8 bit gray, 512 across: its channel, cropped or enlarged to that. */
function gray(job) {
    const data =
        job.bytes === 8
            ? new Uint16Array(bytes, job.offset, job.size * job.size * 4)
            : new Uint8Array(bytes, job.offset, job.size * job.size * 4);
    const out = new Uint8Array(SIZE * SIZE);
    const step = job.crop ? 1 : job.size / SIZE;
    for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE; x++) {
            const texel = data[(Math.floor(y * step) * job.size + Math.floor(x * step)) * 4 + job.channel];
            const value = job.bytes === 8 ? half(texel) : texel / 255;
            out[y * SIZE + x] = Math.max(0, Math.min(255, Math.round(value * 255)));
        }
    return out;
}
const GAP = 16;
for (const name of new Set(jobs.map((job) => job.name))) {
    const [left, right] = [0, 1].map((side) => gray(jobs.find((job) => job.name === name && job.side === side)));
    const pair = new Uint8Array((2 * SIZE + GAP) * SIZE).fill(255);
    for (let y = 0; y < SIZE; y++) {
        pair.set(left.subarray(y * SIZE, (y + 1) * SIZE), y * (2 * SIZE + GAP));
        pair.set(right.subarray(y * SIZE, (y + 1) * SIZE), y * (2 * SIZE + GAP) + SIZE + GAP);
    }
    png(`${OUT}${name}.png`, 2 * SIZE + GAP, SIZE, pair);
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length / 255;
    console.log(name.padEnd(28), `mean before ${mean(left).toFixed(3)}  now ${mean(right).toFixed(3)}`);
}
process.exit(0);
