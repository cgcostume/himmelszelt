import { expect, test } from "@playwright/test";
import { createCubeFromPanoramaPass, createEnvironmentBlendPass, createPanoramaPass, wgsl } from "../dist/index.js";
import { gpuDevice } from "./gpu.js";

const FACE = 64;
const SIZE = 48;

/** A cube map holding, in every texel, the direction it stands for, each channel in [0, 1] and linear in it. */
function directionCube(device: GPUDevice, cubified: boolean) {
    const cube = device.createTexture({
        size: [FACE, FACE, 6],
        format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        textureBindingViewDimension: "cube",
    });
    const pipeline = device.createComputePipeline({
        layout: "auto",
        compute: {
            module: device.createShaderModule({
                code: `${wgsl.cube}
@group(0) @binding(0) var written: texture_storage_2d_array<rgba16float, write>;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let point = rbCubePointAt(id.z, vec2f(id.xy) + 0.5, ${FACE}u);
    let d = ${cubified ? "rbSphereFromCube(point)" : "normalize(point)"};
    textureStore(written, vec2i(id.xy), i32(id.z), vec4f(d * 0.5 + 0.5, 1.0));
}`,
            }),
            entryPoint: "main",
        },
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
        0,
        device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: cube.createView({ dimension: "2d-array" }) }],
        }),
    );
    pass.dispatchWorkgroups(FACE, FACE, 6);
    pass.end();
    device.queue.submit([encoder.finish()]);
    return cube;
}

/** How far each texel of a panorama is from the direction `rbPanoramaDirection` gives it, the worst of them. */
async function worstError(device: GPUDevice, panorama: GPUTexture, projection: number) {
    const texels = device.createBuffer({
        size: SIZE * SIZE * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const pipeline = device.createComputePipeline({
        layout: "auto",
        compute: {
            module: device.createShaderModule({
                code: `${wgsl.panorama}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> worst: array<f32>;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let texel = textureLoad(source, id.xy, 0);
    let uv = (vec2f(id.xy) + 0.5) / ${SIZE}.0;
    let d = rbPanoramaDirection(${projection}u, uv, 0.0);
    // The fisheye's corner texel holds the nadir, and beyond the circles the texels hold the rim's direction.
    worst[id.y * ${SIZE}u + id.x] = select(length(texel.rgb * 2.0 - 1.0 - d), 0.0, all(id.xy == vec2u(0u)));
}`,
            }),
            entryPoint: "main",
        },
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
        0,
        device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: panorama.createView() },
                { binding: 1, resource: { buffer: texels } },
            ],
        }),
    );
    pass.dispatchWorkgroups(SIZE, SIZE);
    pass.end();
    const read = device.createBuffer({
        size: SIZE * SIZE * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyBufferToBuffer(texels, 0, read, 0, SIZE * SIZE * 4);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const errors = new Float32Array(read.getMappedRange().slice(0));
    for (const buffer of [texels, read]) buffer.destroy();
    return errors.reduce((a, b) => Math.max(a, b), 0);
}

const PROJECTIONS = [
    ["equirectangular", 1],
    ["octahedral", 2],
    ["fisheye", 3],
    ["sphere", 4],
] as const;

for (const cubified of [false, true]) {
    for (const [projection, number] of PROJECTIONS) {
        test(`a ${cubified ? "cubified " : ""}cube map lands where the ${projection} panorama says`, async () => {
            const device = await gpuDevice();
            test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
            if (!device) return;
            const cube = directionCube(device, cubified);
            const panorama = device.createTexture({
                size: [SIZE, SIZE],
                format: "rgba16float",
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            });
            const pass = await createPanoramaPass(device, { projection, format: "rgba16float", cubified });
            const encoder = device.createCommandEncoder();
            pass.encode(encoder, cube, panorama);
            device.queue.submit([encoder.finish()]);
            // A bilinear lookup between texels of a sixty-fourth of a face each, on a smooth function.
            expect(await worstError(device, panorama, number)).toBeLessThan(0.02);
            cube.destroy();
            panorama.destroy();
        });
    }
}

test("a panorama of directions comes back from a cube map where it was, and a fade lies between its ends", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const flags = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    const start = directionCube(device, false);
    const panorama = device.createTexture({ size: [SIZE, SIZE], format: "rgba16float", usage: flags });
    const cube = device.createTexture({
        size: [FACE, FACE, 6],
        mipLevelCount: 3,
        format: "rgba16float",
        usage: flags,
        textureBindingViewDimension: "cube",
    });
    const blended = device.createTexture({
        size: [FACE, FACE, 6],
        format: "rgba16float",
        usage: flags,
        textureBindingViewDimension: "cube",
    });
    const back = device.createTexture({ size: [SIZE, SIZE], format: "rgba16float", usage: flags });
    const out = await createPanoramaPass(device, { projection: "equirectangular", format: "rgba16float" });
    const into = await createCubeFromPanoramaPass(device);
    const blend = await createEnvironmentBlendPass(device);
    const encoder = device.createCommandEncoder();
    out.encode(encoder, start, panorama);
    into.encode(encoder, panorama, cube);
    // A fade of a cube map with itself: the same, whatever t is.
    blend.encode(encoder, cube, cube, blended, 0.5);
    out.encode(encoder, blended, back);
    device.queue.submit([encoder.finish()]);
    expect(await worstError(device, back, 1)).toBeLessThan(0.08);
    for (const texture of [start, panorama, cube, blended, back]) texture.destroy();
    blend.destroy();
});
