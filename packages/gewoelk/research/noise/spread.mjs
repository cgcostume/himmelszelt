// How widely gwPerlin's slices spread at the heights the sheets used to read them at, against gwPerlin2's: what
// GW_PERLIN2_HEIGHT is set by, so the sheets' constants hold for either.
import { gpu, pipelineOf, wgsl } from "./lib.mjs";

const { device } = await gpu();
const SIZE = 1024;
const noise = wgsl("noise.wgsl");
const cases = [
    ...[0, 0.1, 0.2, 0.3, 0.4, 0.5].map((z) => [
        `gwPerlin, slice at z = ${z}`,
        `gwPerlin(vec3f(p, ${z.toFixed(1)}), vec3i(1 << 20), 3u)`,
    ]),
    ["gwPerlin2", "gwPerlin2(p, vec2i(1 << 20), 3u)"],
];
const out = device.createTexture({
    size: [SIZE, SIZE, cases.length],
    format: "r32float",
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
});
const encoder = device.createCommandEncoder();
for (const [layer, [, expression]] of cases.entries()) {
    const pipeline = await pipelineOf(
        device,
        `${noise}
@group(0) @binding(0) var o: texture_storage_2d_array<r32float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let p = (vec2f(id.xy) + 0.5) * 0.173;
    textureStore(o, vec2i(id.xy), ${layer}, vec4f(${expression}));
}`,
        "main",
    );
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    const entries = [{ binding: 0, resource: out.createView({ dimension: "2d-array" }) }];
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
    pass.dispatchWorkgroups(SIZE / 8, SIZE / 8);
    pass.end();
}
const read = device.createBuffer({
    size: SIZE * SIZE * 4 * cases.length,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
encoder.copyTextureToBuffer({ texture: out }, { buffer: read, bytesPerRow: SIZE * 4, rowsPerImage: SIZE }, [
    SIZE,
    SIZE,
    cases.length,
]);
device.queue.submit([encoder.finish()]);
await read.mapAsync(GPUMapMode.READ);
const all = new Float32Array(read.getMappedRange().slice(0));
for (const [layer, [name]] of cases.entries()) {
    const a = all.subarray(layer * SIZE * SIZE, (layer + 1) * SIZE * SIZE);
    let [min, max, sum, sq] = [Infinity, -Infinity, 0, 0];
    for (const v of a) [min, max, sum, sq] = [Math.min(min, v), Math.max(max, v), sum + v, sq + v * v];
    const sd = Math.sqrt(sq / a.length - (sum / a.length) ** 2);
    console.log(name.padEnd(28), `sd ${sd.toFixed(3)}  range ${min.toFixed(2)}..${max.toFixed(2)}`);
}
process.exit(0);
