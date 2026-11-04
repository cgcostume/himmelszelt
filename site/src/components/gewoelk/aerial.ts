import type { AerialPerspectiveVolume, AtmosphereLUTs } from "@himmelszelt/dunstkreis";
import { wgsl } from "@himmelszelt/dunstkreis";
import type { AerialPerspective } from "@himmelszelt/gewoelk";

/**
 * gewoelk's aerial perspective from dunstkreis' volume: its four wavelengths turned into RGB, froxel by froxel, the
 * luminance kept at the sky pass' scale, the transmittance tinted as sunlight is. A 32³ pass, recorded each frame.
 */
const SOURCE = `${wgsl.atmosphere}
${wgsl.aerial}
@group(0) @binding(0) var<uniform> atmosphere: DkAtmosphere;
@group(0) @binding(1) var luminanceIn: texture_3d<f32>;
@group(0) @binding(2) var transmittanceIn: texture_3d<f32>;
@group(0) @binding(3) var luminanceOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(4) var transmittanceOut: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(4, 4, 4)
fn aerialRgb(@builtin(global_invocation_id) id: vec3u) {
    if (any(id >= textureDimensions(luminanceOut))) {
        return;
    }
    let a = atmosphere;
    let luminance = dkToRgb(a, textureLoad(luminanceIn, id, 0));
    let transmittance = dkTransmittanceRgb(a, textureLoad(transmittanceIn, id, 0));
    textureStore(luminanceOut, id, vec4f(luminance, 1.0));
    textureStore(transmittanceOut, id, vec4f(transmittance, 1.0));
}`;

export function createAerialRgb(device: GPUDevice) {
    const module = device.createShaderModule({ label: "sternwarte:aerialRgb", code: SOURCE });
    const pipeline = device.createComputePipeline({
        label: "sternwarte:aerialRgb",
        layout: "auto",
        compute: { module, entryPoint: "aerialRgb" },
    });
    let out: { luminance: GPUTexture; transmittance: GPUTexture; group: GPUBindGroup; from: GPUTexture } | null = null;
    return {
        /** Records the conversion of `volume` into `encoder`: gewoelk's volume, valid once the encoder runs. */
        encode(encoder: GPUCommandEncoder, luts: AtmosphereLUTs, volume: AerialPerspectiveVolume, scale: number) {
            const source = volume.luminance;
            if (out?.from !== source) {
                out?.luminance.destroy();
                out?.transmittance.destroy();
                const make = (label: string) =>
                    device.createTexture({
                        label,
                        dimension: "3d",
                        size: [source.width, source.height, source.depthOrArrayLayers],
                        format: "rgba16float",
                        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
                    });
                const luminance = make("sternwarte:aerialLuminance");
                const transmittance = make("sternwarte:aerialTransmittance");
                const group = device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: luts.atmosphereBuffer } },
                        { binding: 1, resource: source.createView() },
                        { binding: 2, resource: volume.transmittance.createView() },
                        { binding: 3, resource: luminance.createView() },
                        { binding: 4, resource: transmittance.createView() },
                    ],
                });
                out = { luminance, transmittance, group, from: source };
            }
            const pass = encoder.beginComputePass({ label: "sternwarte:aerialRgb" });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, out.group);
            pass.dispatchWorkgroups(
                Math.ceil(source.width / 4),
                Math.ceil(source.height / 4),
                Math.ceil(source.depthOrArrayLayers / 4),
            );
            pass.end();
            const air: AerialPerspective = {
                luminance: out.luminance,
                transmittance: out.transmittance,
                maxDistanceKm: volume.maxDistanceKm,
                scale,
            };
            return air;
        },
    };
}
