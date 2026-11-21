// The whole-sky research figure's composition: gewoelk's layered clouds, exposed and premultiplied with what they let
// through, over a real sky, dunstkreis' with the stars and the Moon, which comes exposed but linear; then the tone
// curve. Requires the research prelude.

@group(0) @binding(0) var<uniform> V: LabView;
@group(0) @binding(1) var skyExposed: texture_2d<f32>;
@group(0) @binding(2) var skyClouds: texture_2d<f32>;
// x what the frame's light is multiplied by before the tone curve.
@group(0) @binding(3) var<uniform> skyDimmed: vec4f;
@group(1) @binding(0) var skyCanvas: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn weatherCompose(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(skyCanvas);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let behind = textureLoad(skyExposed, vec2i(id.xy), 0).rgb;
    let clouds = textureLoad(skyClouds, vec2i(id.xy), 0);
    textureStore(skyCanvas, vec2i(id.xy), vec4f(hdToneMapNeutralHdr((behind * clouds.a + clouds.rgb) * skyDimmed.x, V.headroom), 1.0));
}
