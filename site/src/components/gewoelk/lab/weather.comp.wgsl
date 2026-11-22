// The whole-sky research figure's composition: gewoelk's layered clouds, exposed and premultiplied with what they let
// through, over a real sky, dunstkreis' with the stars and the Moon, which comes exposed but linear; then the tone
// curve. Requires the research prelude.

@group(0) @binding(0) var<uniform> V: LabView;
@group(0) @binding(1) var skyExposed: texture_2d<f32>;
@group(0) @binding(2) var skyClouds: texture_2d<f32>;
// What the frame's light is multiplied by before the tone curve, and what the ground's is besides.
struct SkyFrame {
    dimmed: f32,
    ground: f32,
}
@group(0) @binding(3) var<uniform> skyFrame: SkyFrame;
@group(1) @binding(0) var skyCanvas: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn weatherCompose(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(skyCanvas);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    var behind = textureLoad(skyExposed, vec2i(id.xy), 0).rgb;
    let clouds = textureLoad(skyClouds, vec2i(id.xy), 0);
    let o = vec3f(0.0, 0.0, V.planetRadius + V.observer);
    let v = labRay(V, vec2f(id.xy) + 0.5, size);
    if (skyFrame.ground < 1.0 && labSphere(o, v, V.planetRadius).x > 0.0) {
        behind = behind * skyFrame.ground;
    }
    textureStore(skyCanvas, vec2i(id.xy), vec4f(hdToneMapNeutralHdr((behind * clouds.a + clouds.rgb) * skyFrame.dimmed, V.headroom), 1.0));
}
