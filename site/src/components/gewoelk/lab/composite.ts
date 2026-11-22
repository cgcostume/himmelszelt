import { type LayeredCloudPass, wgsl } from "@himmelszelt/gewoelk";

/**
 * What a designer's textures make together, seen straight from above over its patch, north up: the sheet's density as
 * every pixel's read composes it from the map's four channels, or the deep layer's columns, the taller the brighter, with their anvils. Read by
 * the library's own functions, on the passes' own uniforms, so it is what the patch is rendered from.
 */

const ABOVE = /* wgsl */ `
// The patch: its middle from the observer, east and north in km, how many km it is across, and the layer.
struct Above { center: vec2f, extent: f32, layer: f32 }
@group(2) @binding(0) var<uniform> above: Above;

fn aboveAt(id: vec2u) -> vec2f {
    let uv = (vec2f(id) + 0.5) / vec2f(gwOutputSize());
    return above.center + (vec2f(uv.x, 1.0 - uv.y) - 0.5) * above.extent;
}
`;
const SHEET = /* wgsl */ `
@compute @workgroup_size(8, 8, 1)
fn sheetAbove(@builtin(global_invocation_id) id: vec3u) {
    let size = gwOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let texel = gwHigh.tile / f32(textureDimensions(gwHighMap).x);
    let density = gwHighDensity(aboveAt(id.xy), max(log2(above.extent / f32(size.x) / texel), 0.0));
    gwOutputStore(id.xy, vec4f(vec3f(density), 1.0));
}
`;
const LAYER = /* wgsl */ `
@group(0) @binding(0) var<uniform> gwParams: GwParams;
@group(0) @binding(1) var<uniform> gwLayered: GwLayered;
@group(0) @binding(2) var gwLayerMaps: texture_2d_array<f32>;
@group(0) @binding(3) var gwLayerSampler: sampler;
// How bright an anvil's skirt is drawn beside a column of the layer's whole depth: its ice is far thinner.
const ABOVE_ANVIL: f32 = 0.3;

@compute @workgroup_size(8, 8, 1)
fn layerAbove(@builtin(global_invocation_id) id: vec3u) {
    let size = gwOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let i = u32(above.layer + 0.5);
    let m = gwLayerColumn(i, aboveAt(id.xy) + gwLayered.observer);
    let span = gwLayerSpan(gwLayered.layer[i].depth, m.r);
    let column = (span.y - span.x) * step(1e-3, m.r);
    gwOutputStore(id.xy, vec4f(vec3f(max(column, ABOVE_ANVIL * m.g)), 1.0));
}
`;

const SIZE = 256;

/** The composite on `device`: `encode` it over a patch, then show its `texture`, rgba16float with the value in red. */
export async function createComposite(device: GPUDevice) {
    const output = wgsl.cloudOutput("rgba16float");
    const pipeline = (code: string[], entryPoint: string) =>
        device.createComputePipelineAsync({
            label: `sternwarte:${entryPoint}`,
            layout: "auto",
            compute: { module: device.createShaderModule({ code: code.join("\n") }), entryPoint },
        });
    const [sheet, layer] = await Promise.all([
        pipeline([wgsl.params, wgsl.camera, output, wgsl.highsheet, ABOVE, SHEET], "sheetAbove"),
        pipeline([wgsl.params, wgsl.layerread, output, ABOVE, LAYER], "layerAbove"),
    ]);
    const texture = device.createTexture({
        label: "sternwarte:cloudComposite",
        size: [SIZE, SIZE],
        format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const above = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const sampler = device.createSampler({
        addressModeU: "repeat",
        addressModeV: "repeat",
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
    });
    const group = (of: GPUComputePipeline, index: number, entries: GPUBindGroupEntry[]) =>
        device.createBindGroup({ layout: of.getBindGroupLayout(index), entries });
    let made: { pass: LayeredCloudPass; sheet: GPUBindGroup; layer: GPUBindGroup } | null = null;

    return {
        texture,
        /** Records the composite into `encoder`: of the layer `index` of `pass`, or of its sheet without one. */
        encode(
            encoder: GPUCommandEncoder,
            pass: LayeredCloudPass,
            index: number | null,
            centerKm: readonly [number, number],
            extentKm: number,
        ) {
            if (made?.pass !== pass) {
                made = {
                    pass,
                    sheet: group(sheet, 0, [
                        { binding: 2, resource: { buffer: pass.high.uniforms } },
                        { binding: 3, resource: pass.high.map.createView() },
                        { binding: 4, resource: sampler },
                    ]),
                    layer: group(layer, 0, [
                        { binding: 1, resource: { buffer: pass.layers.uniforms } },
                        { binding: 2, resource: pass.layers.maps.createView({ dimension: "2d-array" }) },
                        { binding: 3, resource: sampler },
                    ]),
                };
            }
            device.queue.writeBuffer(above, 0, new Float32Array([...centerKm, extentKm, index ?? 0]));
            const of = index === null ? sheet : layer;
            const composing = encoder.beginComputePass({ label: "sternwarte:cloudComposite" });
            composing.setPipeline(of);
            composing.setBindGroup(0, index === null ? made.sheet : made.layer);
            composing.setBindGroup(1, group(of, 1, [{ binding: 0, resource: texture.createView() }]));
            composing.setBindGroup(2, group(of, 2, [{ binding: 0, resource: { buffer: above } }]));
            composing.dispatchWorkgroups(SIZE / 8, SIZE / 8);
            composing.end();
        },
    };
}
