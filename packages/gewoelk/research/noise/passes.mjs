// The passes that bake from the noise, each built from the baseline's shaders and from the working tree's, timed
// interleaved: ms per bake, medians of 41. And what the sheets ask of the noise per pixel and frame.
import { gpu, layerMapGroups, pipelineOf, SIDES, time } from "./lib.mjs";
import { cloudModel, highModel, layerModel, sheetBench, storageFormat } from "./models.mjs";

const { device } = await gpu();

const uniform = (data) => {
    const buffer = device.createBuffer({
        size: Math.ceil(data.byteLength / 16) * 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, data);
    return { buffer };
};
const STORAGE = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;

const detailOut = device.createTexture({
    dimension: "3d",
    size: [128, 128, 128],
    format: "rgba8unorm",
    usage: STORAGE,
});
const layerOut = device.createTexture({ size: [512, 512, 3], format: "rgba16float", usage: STORAGE });
const cloudOut = device.createTexture({ size: [512, 512, 2], format: "rgba16float", usage: STORAGE });
const sheetOut = device.createTexture({ size: [1920, 1080], format: "r32float", usage: STORAGE });
const array = { dimension: "2d-array" };

const cases = [];
const names = [];
for (const side of SIDES) {
    const noise = side.shader("noise.wgsl");
    const add = async (name, code, entry, entries, dispatch) => {
        const pipeline = await pipelineOf(device, code, entry);
        const resources = entries.map((resource, binding) => ({ binding, resource }));
        const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: resources });
        cases.push({ name: `${name}/${side.name}`, pipeline, group, dispatch });
        if (!names.includes(name)) names.push(name);
    };
    await add(
        "detail 128³",
        `${noise}\n${side.shader("detail.comp.wgsl")}`,
        "gwDetail",
        [detailOut.createView()],
        [32, 32, 32],
    );
    const highmap = side.shader("highmap.comp.wgsl");
    const highOut = device.createTexture({
        size: [2048, 2048],
        format: storageFormat(highmap, "gwHighMapOut"),
        usage: STORAGE,
    });
    await add(
        "highmap 2048²",
        `${noise}\n${highmap}`,
        "gwHighMapBake",
        [uniform(highModel(highmap)), highOut.createView()],
        [256, 256],
    );
    const layermap = side.shader("layermap.comp.wgsl");
    const groups = layerMapGroups(layermap, 512);
    for (const [kind, label] of [
        [0, "heaps"],
        [2, "towers"],
        [3, "front"],
    ])
        await add(
            `layermap 512², ${label}`,
            `${noise}\n${layermap}`,
            "gwLayerMap",
            [uniform(layerModel(kind)), layerOut.createView(array)],
            [groups, groups],
        );
    const cloudmap = `${noise}\n${side.shader("params.wgsl")}\n${side.shader("cloudmap.comp.wgsl")}`;
    for (const towers of [0, 0.5])
        await add(
            `cloudmap 512², towers ${towers}`,
            cloudmap,
            "gwCloudMap",
            [uniform(cloudModel(towers)), cloudOut.createView(array)],
            [64, 64],
        );
    const sheet = side.shader("sheet.wgsl");
    for (const footprint of ["0.001", "0.05", "0.3"])
        await add(
            `sheet noise 1080p, ${footprint} km px`,
            `${noise}\n${sheetBench(sheet, footprint)}`,
            "bench",
            [sheetOut.createView()],
            [240, 135],
        );
}
const result = await time(device, cases, 41);
console.log("pass".padEnd(32), ...SIDES.map((s) => `${s.name} ms`.padStart(12)), "  speedup");
for (const name of names) {
    const ms = SIDES.map((s) => result[`${name}/${s.name}`].median);
    console.log(name.padEnd(32), ...ms.map((n) => n.toFixed(3).padStart(12)), `  ${(ms[0] / ms[1]).toFixed(2)}x`);
}
process.exit(0);
