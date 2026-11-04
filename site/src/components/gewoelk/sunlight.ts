import type { AtmosphereLUTs } from "@himmelszelt/dunstkreis";
import { wgsl } from "@himmelszelt/dunstkreis";

/**
 * The sun's illuminance at a few altitudes above the observer, per channel in lux, from dunstkreis' transmittance
 * table: clouds a few kilometers up are lit after the ground has fallen into shadow, and by a redder sun. One tiny
 * compute pass per sky-view change, read back for gewoelk's per-layer `sunIlluminance`.
 */
const SOURCE = `${wgsl.scattering}
@group(0) @binding(0) var<uniform> atmosphere: DkAtmosphere;
@group(0) @binding(1) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(2) var lutSampler: sampler;
@group(0) @binding(3) var<uniform> query: array<vec4f, 4>;
@group(0) @binding(4) var<storage, read_write> result: array<vec4f, 4>;

@compute @workgroup_size(4)
fn sunlight(@builtin(global_invocation_id) id: vec3u) {
    let a = atmosphere;
    let altitude = query[id.x].x;
    let sun = query[id.x].yzw;
    var transmittance = vec4f(0.0);
    if (altitude <= a.Rt - a.Rg) {
        transmittance = dkSampleTransmittanceToTop(a, transmittanceLut, lutSampler, altitude, sun.z);
    }
    result[id.x] = vec4f(dkToRgb(a, a.solarIlluminance * transmittance), 1.0);
}`;

export function createSunlight(device: GPUDevice) {
    const module = device.createShaderModule({ label: "sternwarte:sunlight", code: SOURCE });
    const pipeline = device.createComputePipeline({
        label: "sternwarte:sunlight",
        layout: "auto",
        compute: { module, entryPoint: "sunlight" },
    });
    const query = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const result = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const staging = device.createBuffer({ size: 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    let busy = false;
    return {
        /** The sun's illuminance at up to four `altitudesKm`, for the sun at `sunDirection`, through `luts`' air. */
        async at(
            luts: AtmosphereLUTs,
            altitudesKm: number[],
            sunDirection: readonly [number, number, number],
        ): Promise<[number, number, number][]> {
            if (busy) return [];
            busy = true;
            const data = new Float32Array(16);
            altitudesKm.slice(0, 4).forEach((h, i) => {
                data.set([h, ...sunDirection], i * 4);
            });
            device.queue.writeBuffer(query, 0, data);
            const bindGroup = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: luts.atmosphereBuffer } },
                    { binding: 1, resource: luts.transmittance.createView() },
                    { binding: 2, resource: luts.sampler },
                    { binding: 3, resource: { buffer: query } },
                    { binding: 4, resource: { buffer: result } },
                ],
            });
            const encoder = device.createCommandEncoder({ label: "sternwarte:sunlight" });
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(1);
            pass.end();
            encoder.copyBufferToBuffer(result, 0, staging, 0, 64);
            device.queue.submit([encoder.finish()]);
            await staging.mapAsync(GPUMapMode.READ);
            const values = new Float32Array(staging.getMappedRange().slice(0));
            staging.unmap();
            busy = false;
            return altitudesKm.slice(0, 4).map((_, i) => [values[i * 4], values[i * 4 + 1], values[i * 4 + 2]]) as [
                number,
                number,
                number,
            ][];
        },
    };
}
