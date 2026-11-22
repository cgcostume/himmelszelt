// Do the noises still tile, and spread as before? Each function before and now over a tile of PERIOD cells (6 by
// default; 40 for statistics over many cells): its mean, spread and range, the largest difference to itself shifted by
// whole periods, which is 0 where it tiles, and the step across the tile's seam against one inside it.
import { gpu, pipelineOf, SIDES } from "./lib.mjs";

const { device } = await gpu();
const SIZE = 512;
const PERIOD = Number(process.env.PERIOD ?? 6);
const EXPRESSIONS = {
    perlin: "gwPerlin(p, P, 3u)",
    fbm5: "gwFbm(p, P, 5u, 3u)",
    alligator: "gwAlligator(p, P, 3u)",
    curlyAlligator: "gwCurlyAlligator(p, P, 3u, 0.6)",
    "curl x": "gwCurl(p, P, 3u).x",
    "curl z": "gwCurl(p, P, 3u).z",
};
const SHIFTS = ["vec3f(0.0)", "vec3f(P)", "vec3f(-3.0 * vec3f(P))"];
const jobs = [];
for (const side of SIDES)
    for (const name of Object.keys(EXPRESSIONS)) for (const s of SHIFTS.keys()) jobs.push({ side, name, s });
const out = device.createTexture({
    size: [SIZE, SIZE, jobs.length],
    format: "r32float",
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
});
const buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(buffer, 0, new Int32Array([PERIOD, PERIOD, 4, 0]));
const encoder = device.createCommandEncoder();
for (const [layer, { side, name, s }] of jobs.entries()) {
    const pipeline = await pipelineOf(
        device,
        `${side.shader("noise.wgsl")}
@group(0) @binding(0) var verifyOut: texture_storage_2d_array<r32float, write>;
@group(0) @binding(1) var<uniform> U: vec4i;
@compute @workgroup_size(8, 8, 1)
fn verify(@builtin(global_invocation_id) id: vec3u) {
    let P = U.xyz;
    let p = vec3f((vec2f(id.xy) + 0.5) / ${SIZE}.0 * vec2f(P.xy), 0.37) + ${SHIFTS[s]};
    textureStore(verifyOut, vec2i(id.xy), ${layer}, vec4f(${EXPRESSIONS[name]}));
}`,
        "verify",
    );
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    const entries = [
        { binding: 0, resource: out.createView({ dimension: "2d-array" }) },
        { binding: 1, resource: { buffer } },
    ];
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
    pass.dispatchWorkgroups(SIZE / 8, SIZE / 8);
    pass.end();
}
const read = device.createBuffer({
    size: SIZE * SIZE * 4 * jobs.length,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
encoder.copyTextureToBuffer({ texture: out }, { buffer: read, bytesPerRow: SIZE * 4, rowsPerImage: SIZE }, [
    SIZE,
    SIZE,
    jobs.length,
]);
device.queue.submit([encoder.finish()]);
await read.mapAsync(GPUMapMode.READ);
const all = new Float32Array(read.getMappedRange().slice(0));
const layerOf = (side, name, s) => {
    const k = jobs.findIndex((j) => j.side === side && j.name === name && j.s === s);
    return all.subarray(k * SIZE * SIZE, (k + 1) * SIZE * SIZE);
};
const worst = (a, b) => a.reduce((w, v, i) => Math.max(w, Math.abs(v - b[i])), 0);
console.log(`a tile of ${PERIOD} cells, ${SIZE}² texels`);
for (const name of Object.keys(EXPRESSIONS)) {
    console.log(name);
    for (const side of SIDES) {
        const a = layerOf(side, name, 0);
        let [min, max, sum, sq] = [Infinity, -Infinity, 0, 0];
        for (const v of a) [min, max, sum, sq] = [Math.min(min, v), Math.max(max, v), sum + v, sq + v * v];
        const mean = sum / a.length;
        const tiles = Math.max(worst(a, layerOf(side, name, 1)), worst(a, layerOf(side, name, 2)));
        let [seam, inner] = [0, 0];
        for (let y = 0; y < SIZE; y++) {
            seam = Math.max(seam, Math.abs(a[y * SIZE] - a[y * SIZE + SIZE - 1]));
            inner = Math.max(inner, Math.abs(a[y * SIZE + 200] - a[y * SIZE + 201]));
        }
        const spread = `mean ${mean.toFixed(3)}  sd ${Math.sqrt(sq / a.length - mean * mean).toFixed(3)}  range ${min.toFixed(2)}..${max.toFixed(2)}`;
        console.log(
            `  ${side.name.padEnd(7)} ${spread}  shifted by periods ${tiles.toExponential(1)}  seam ${seam.toFixed(3)} (inside ${inner.toFixed(3)})`,
        );
    }
}
process.exit(0);
