// Each noise function alone, before and now: ns per evaluation over 2048² invocations of 8 each, the point moving
// 0.031 cells from texel to texel as a bake's does. Periods and seeds come from a uniform, as in the passes, so the
// compiler cannot fold the lattice's wrapping.
import { gpu, noise2, pipelineOf, SIDES, time } from "./lib.mjs";

const { device, adapter } = await gpu();
console.log(adapter.info?.vendor, adapter.info?.architecture, adapter.info?.description);

const SIZE = 2048;
const REPEAT = 8;
const EXPRESSIONS = {
    empty: () => "p.x * p.z",
    perlin: () => "gwPerlin(p, U.period, U.seed)",
    "perlin, period fixed": () => "gwPerlin(p, vec3i(1 << 20), 3u)",
    "perlin 2D": (code) => noise2(code, "p.xy", "U.seed"),
    fbm5: () => "gwFbm(p, U.small, U.octaves, U.seed)",
    alligator: () => "gwAlligator(p, U.period, U.seed)",
    curl: () => "dot(gwCurl(p, U.period, U.seed), vec3f(1.0))",
    curlyAlligator: () => "gwCurlyAlligator(p, U.period, U.seed, 0.6)",
};

const target = device.createTexture({ size: [SIZE, SIZE], format: "r32float", usage: GPUTextureUsage.STORAGE_BINDING });
const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(uniform, 0, new Int32Array([75, 75, 8, 3, 4, 4, 8, 5]));
const cases = [];
for (const side of SIDES) {
    const prelude = side.shader("noise.wgsl");
    for (const [name, expression] of Object.entries(EXPRESSIONS)) {
        const code = `${prelude}
@group(0) @binding(0) var benchOut: texture_storage_2d<r32float, write>;
struct BenchU { period: vec3i, seed: u32, small: vec3i, octaves: u32 }
@group(0) @binding(1) var<uniform> U: BenchU;
@compute @workgroup_size(8, 8, 1)
fn bench(@builtin(global_invocation_id) id: vec3u) {
    var sum = 0.0;
    for (var k = 0u; k < ${REPEAT}u; k = k + 1u) {
        let p = vec3f(vec2f(id.xy) * 0.031 + f32(k) * 1.37, 0.37 + f32(k) * 0.61);
        sum = sum + ${expression(prelude)};
    }
    textureStore(benchOut, vec2i(id.xy), vec4f(sum));
}`;
        const pipeline = await pipelineOf(device, code, "bench");
        const entries = [{ binding: 0, resource: target.createView() }];
        if (/U\./.test(expression(prelude))) entries.push({ binding: 1, resource: { buffer: uniform } });
        const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
        cases.push({ name: `${name}/${side.name}`, pipeline, group, dispatch: [SIZE / 8, SIZE / 8] });
    }
}
const result = await time(device, cases, 41);
const evals = SIZE * SIZE * REPEAT;
console.log("function".padEnd(22), ...SIDES.map((s) => `${s.name} ns`.padStart(12)), "  speedup");
for (const name of Object.keys(EXPRESSIONS)) {
    const ns = SIDES.map((s) => (result[`${name}/${s.name}`].median * 1e6) / evals);
    console.log(name.padEnd(22), ...ns.map((n) => n.toFixed(3).padStart(12)), `  ${(ns[0] / ns[1]).toFixed(2)}x`);
}
process.exit(0);
