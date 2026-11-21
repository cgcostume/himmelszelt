/** A harness like `evaluateWgsl` with the air table bound: a WGSL expression per input, over a table and a seeing. */
import { type AirTable, createAirTexture } from "../src/air.js";
import { type Seeing, seeingUniformData } from "../src/seeing.js";
import { wgslSource } from "./gpu.js";

/**
 * Evaluates `expression` once per input with `air.wgsl` and `seeing.wgsl` in scope: `input` is the input, a vec4f,
 * `air` the table's texture and `seeing` a `DkSeeing`. It must give a vec4f. At most 4096 inputs.
 */
export async function evaluateWithAir(
    device: GPUDevice,
    table: AirTable,
    expression: string,
    inputs: readonly (readonly [number, number, number, number])[],
    seeing: Seeing = {},
    declarations = "",
): Promise<[number, number, number, number][]> {
    const count = inputs.length;
    const module = device.createShaderModule({
        code: `${wgslSource("air")}
${wgslSource("seeing")}
${declarations}
@group(0) @binding(0) var<storage, read> inputs: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> outputs: array<vec4f>;
@group(0) @binding(2) var air: texture_2d<f32>;
@group(0) @binding(3) var<uniform> seeing: DkSeeing;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= ${count}u) { return; }
    let input = inputs[id.x];
    outputs[id.x] = ${expression};
}`,
    });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length > 0) throw new Error(`WGSL: ${errors.map((m) => `${m.lineNum}: ${m.message}`).join("\n")}`);

    const size = count * 16;
    const inputBuffer = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(inputBuffer, 0, new Float32Array(inputs.flat()));
    const outputBuffer = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readBuffer = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const seeingData = seeingUniformData(seeing);
    const seeingBuffer = device.createBuffer({
        size: seeingData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(seeingBuffer, 0, seeingData as Float32Array<ArrayBuffer>);
    const texture = createAirTexture(device, table);

    // Explicit, so an expression that leaves the table or the seeing out keeps its bindings.
    const layout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        ],
    });
    const pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: "main" },
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
        0,
        device.createBindGroup({
            layout,
            entries: [
                { binding: 0, resource: { buffer: inputBuffer } },
                { binding: 1, resource: { buffer: outputBuffer } },
                { binding: 2, resource: texture.createView() },
                { binding: 3, resource: { buffer: seeingBuffer } },
            ],
        }),
    );
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    encoder.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, size);
    device.queue.submit([encoder.finish()]);

    await readBuffer.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readBuffer.getMappedRange()).slice();
    readBuffer.unmap();
    for (const buffer of [inputBuffer, outputBuffer, readBuffer, seeingBuffer]) buffer.destroy();
    texture.destroy();
    return Array.from(
        { length: count },
        (_, i) => [...values.subarray(i * 4, i * 4 + 4)] as [number, number, number, number],
    );
}
