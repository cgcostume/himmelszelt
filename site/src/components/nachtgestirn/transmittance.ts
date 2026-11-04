import type { AtmosphereLUTs } from "@himmelszelt/dunstkreis";
import { wgsl } from "@himmelszelt/dunstkreis";

/**
 * What dunstkreis' air lets through along a line of sight to space, in RGB: the Moon's light is dimmed and reddened by
 * it, as the Sun's is. One lookup into the transmittance table, as the sun's illuminance is taken, divided by the
 * Sun's light itself so the four wavelengths come out as a ratio per channel. Read back, so it arrives a frame late.
 */
const SOURCE = `${wgsl.scattering}
@group(0) @binding(0) var<uniform> atmosphere: DkAtmosphere;
@group(0) @binding(1) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(2) var lutSampler: sampler;
@group(0) @binding(3) var<storage, read> query: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> result: array<vec4f>;

@compute @workgroup_size(64)
fn transmittance(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= arrayLength(&query)) {
        return;
    }
    let a = atmosphere;
    let altitude = query[id.x].x;
    var t = vec4f(1.0);
    if (altitude <= a.Rt - a.Rg) {
        t = dkSampleTransmittanceToTop(a, transmittanceLut, lutSampler, altitude, query[id.x].y);
    }
    let through = dkToRgb(a, a.solarIlluminance * t);
    let sun = dkToRgb(a, a.solarIlluminance * vec4f(1.0));
    result[id.x] = vec4f(through / max(sun, vec3f(1e-6)), 1.0);
}`;

export type Rgb = [number, number, number];

export function createTransmittance(device: GPUDevice) {
    const module = device.createShaderModule({ label: "sternwarte:transmittance", code: SOURCE });
    const pipeline = device.createComputePipeline({
        label: "sternwarte:transmittance",
        layout: "auto",
        compute: { module, entryPoint: "transmittance" },
    });
    const query = device.createBuffer({ size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const result = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const staging = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    let busy = false;
    return {
        /** The transmittance through `luts`' air from `altitudeKm` up along a ray of `cosZenith`, or null while the
         *  last query is still being read. */
        async at(luts: AtmosphereLUTs, altitudeKm: number, cosZenith: number): Promise<Rgb | null> {
            if (busy) return null;
            busy = true;
            device.queue.writeBuffer(query, 0, new Float32Array([altitudeKm, cosZenith]));
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
            const encoder = device.createCommandEncoder({ label: "sternwarte:transmittance" });
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(1);
            pass.end();
            encoder.copyBufferToBuffer(result, 0, staging, 0, 16);
            device.queue.submit([encoder.finish()]);
            await staging.mapAsync(GPUMapMode.READ);
            const values = new Float32Array(staging.getMappedRange().slice(0));
            staging.unmap();
            busy = false;
            return [values[0] ?? 1, values[1] ?? 1, values[2] ?? 1];
        },
    };
}
