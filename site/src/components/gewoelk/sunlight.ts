import type { AtmosphereLUTs } from "@himmelszelt/dunstkreis";
import { wgsl } from "@himmelszelt/dunstkreis";
import { SUNLIGHT_ENTRIES, type SunlightRow } from "@himmelszelt/gewoelk";

/**
 * gewoelk's sunlight table from dunstkreis' transmittance table: the sun's illuminance at each row's altitude for each
 * of its elevations above the local horizon, per channel in lux. Far clouds towards the sun stay lit after the ground
 * has fallen into shadow, by a redder sun. One small compute pass per sky-view change, read back.
 */
const SOURCE = `${wgsl.scattering}
@group(0) @binding(0) var<uniform> atmosphere: DkAtmosphere;
@group(0) @binding(1) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(2) var lutSampler: sampler;
@group(0) @binding(3) var<storage, read> query: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> result: array<vec4f>;

@compute @workgroup_size(64)
fn sunlight(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= arrayLength(&query)) {
        return;
    }
    let a = atmosphere;
    let altitude = query[id.x].x;
    var transmittance = vec4f(0.0);
    if (altitude <= a.Rt - a.Rg) {
        transmittance = dkSampleTransmittanceToTop(a, transmittanceLut, lutSampler, altitude, query[id.x].y);
    }
    result[id.x] = vec4f(dkToRgb(a, a.solarIlluminance * transmittance), 1.0);
}`;

type Rgb = [number, number, number];

export function createSunlight(device: GPUDevice) {
    const module = device.createShaderModule({ label: "sternwarte:sunlight", code: SOURCE });
    const pipeline = device.createComputePipeline({
        label: "sternwarte:sunlight",
        layout: "auto",
        compute: { module, entryPoint: "sunlight" },
    });
    const count = 4 * SUNLIGHT_ENTRIES;
    const query = device.createBuffer({ size: count * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const result = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const staging = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    let busy = false;
    return {
        /** The table for gewoelk's `rows`, through `luts`' air, or nothing while the last is still being read. The
         *  table's rays start in the apparent direction: `apparent` lifts a true elevation at an altitude to it. */
        async table(
            luts: AtmosphereLUTs,
            rows: SunlightRow[],
            apparent: (altitudeKm: number, elevation: number) => number = (_, e) => e,
        ): Promise<Rgb[] | null> {
            if (busy) return null;
            busy = true;
            const data = new Float32Array(count * 2);
            rows.slice(0, 4).forEach((row, i) => {
                for (let k = 0; k < SUNLIGHT_ENTRIES; k++) {
                    const elevation = row.fromRad + ((row.toRad - row.fromRad) * k) / (SUNLIGHT_ENTRIES - 1);
                    data.set(
                        [row.altitudeKm, Math.sin(apparent(row.altitudeKm, elevation))],
                        (i * SUNLIGHT_ENTRIES + k) * 2,
                    );
                }
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
            pass.dispatchWorkgroups(Math.ceil(count / 64));
            pass.end();
            encoder.copyBufferToBuffer(result, 0, staging, 0, count * 16);
            device.queue.submit([encoder.finish()]);
            await staging.mapAsync(GPUMapMode.READ);
            const values = new Float32Array(staging.getMappedRange().slice(0));
            staging.unmap();
            busy = false;
            return Array.from(
                { length: count },
                (_, i): Rgb => [values[i * 4], values[i * 4 + 1], values[i * 4 + 2]] as Rgb,
            );
        },
    };
}
