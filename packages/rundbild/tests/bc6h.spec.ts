import { expect, test } from "@playwright/test";
import { createBc6hPass } from "../dist/index.js";
import { gpuDevice } from "./gpu.js";

type Image = (x: number, y: number) => [number, number, number];
type Quality = "fast" | "high";

/** A sky's light, four stops across and two down, its color shifting along. */
const gradient: Image = (x, y) => [2 ** (x / 16 - 2), 2 ** (x / 20 + y / 24 - 1), 2 ** (y / 24)];

/** That sky over ground a thousand times darker and of another color, the horizon at a slant through the blocks. */
const edge: Image = (x, y) =>
    y < 20 + x / 3 ? gradient(x, y) : [0.004 * (1 + x / 32), 0.002 * (1 + y / 32), 0.001 * (1 + (x + y) / 64)];

/** Encodes `image`, `width` by `height`, into a layer of two as BC6H and reads it back through the GPU's own decoder. */
async function roundTrip(
    device: GPUDevice,
    image: Image,
    [width, height]: [number, number],
    quality: Quality,
    layer = 0,
) {
    const pixels = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) pixels.set([...image(x, y), 1], (y * width + x) * 4);
    }
    const source = device.createTexture({
        size: [width, height, 2],
        format: "rgba32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const origin = [0, 0, layer];
    device.queue.writeTexture({ texture: source, origin }, pixels, { bytesPerRow: width * 16 }, [width, height]);
    const target = device.createTexture({
        size: [Math.ceil(width / 4) * 4, Math.ceil(height / 4) * 4, 2],
        format: "bc6h-rgb-ufloat",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const pass = await createBc6hPass(device, { quality });

    const decoded = device.createBuffer({
        size: width * height * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const decode = device.createComputePipeline({
        layout: "auto",
        compute: {
            module: device.createShaderModule({
                code: `@group(0) @binding(0) var compressed: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> texels: array<vec4f>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x < ${width}u && id.y < ${height}u) { texels[id.y * ${width}u + id.x] = textureLoad(compressed, id.xy, 0); }
}`,
            }),
            entryPoint: "main",
        },
    });
    const encoder = device.createCommandEncoder();
    pass.encode(encoder, source, target, { layer });
    const compute = encoder.beginComputePass();
    compute.setPipeline(decode);
    compute.setBindGroup(
        0,
        device.createBindGroup({
            layout: decode.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: target.createView({ dimension: "2d", baseArrayLayer: layer }) },
                { binding: 1, resource: { buffer: decoded } },
            ],
        }),
    );
    compute.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    compute.end();
    const read = device.createBuffer({ size: decoded.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyBufferToBuffer(decoded, 0, read, 0, decoded.size);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const texels = new Float32Array(read.getMappedRange()).slice();
    read.unmap();
    for (const resource of [source, target, decoded, read, pass]) resource.destroy();

    // The relative error per channel, its mean and its worst, and the error the encoder minimizes: the squared log2 of
    // the ratio of each channel plus 1, weighted by luminance, summed.
    let sum = 0;
    let worst = 0;
    let msle = 0;
    for (let i = 0; i < width * height * 4; i++) {
        if (i % 4 === 3) continue;
        const [got, wanted] = [texels[i] as number, pixels[i] as number];
        const error = Math.abs(got - wanted) / wanted;
        sum += error;
        worst = Math.max(worst, error);
        msle += ([0.299, 0.587, 0.114][i % 4] as number) * Math.log2((got + 1) / (wanted + 1)) ** 2;
    }
    return { mean: sum / (width * height * 3), worst, msle };
}

for (const quality of ["high", "fast"] as const) {
    test(`BC6H (${quality}) keeps a smooth sky within 2% on average`, async () => {
        const device = await gpuDevice();
        test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
        if (!device) return;
        test.skip(!device.features.has("texture-compression-bc"), "the adapter has no BC formats");
        // Not a multiple of 4, so the last blocks repeat the edge, and in the second layer, as a cube map's face.
        const { mean, worst } = await roundTrip(device, gradient, [62, 46], quality, 1);
        expect(mean).toBeLessThan(0.02);
        expect(worst).toBeLessThan(0.1);
    });
}

test("BC6H keeps a horizon, closer with its partitions than with one line", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    test.skip(!device.features.has("texture-compression-bc"), "the adapter has no BC formats");
    const high = await roundTrip(device, edge, [64, 64], "high");
    const fast = await roundTrip(device, edge, [64, 64], "fast");
    // By the encoder's own measure, which hardly sees light far below 1: the dark ground fares worse relatively.
    expect(high.msle).toBeLessThan(fast.msle * 0.8);
    expect(high.mean).toBeLessThan(0.05);
});
