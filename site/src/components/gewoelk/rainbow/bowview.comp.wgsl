// The bow as seen, for the figure of where it stands: a shower ahead of the observer under a dark cloud, the sun behind,
// the rain's light by gewoelk's `gwRainbowOf`, in the stereographic projection of the diagram beside it. No sky: the
// cloud behind the rain and the ground are plain grays, stand-ins. Requires gewoelk's `rainbow.wgsl` and helldunkel's
// `tonemap.wgsl`. Lengths in km, directions ENU with the observer looking along y, light in lux and cd/m².

struct BowView {
    sun: vec3f,
    // The rain's extinction per km.
    extinction: f32,
    // The sun's illuminance on the rain, and what luminance is multiplied by.
    illuminance: vec3f,
    exposure: f32,
    // The projection, in pixels: where the horizon's point straight ahead lies, and how far from it a direction 90° off.
    ahead: vec2f,
    quarter: f32,
    // The page's tone curve: 1 Neutral, 2 AgX, 3 ACES, 4 none.
    curve: u32,
}

@group(0) @binding(0) var<uniform> bow: BowView;
@group(0) @binding(1) var bowTable: texture_2d<f32>;
@group(0) @binding(2) var bowSampler: sampler;
@group(0) @binding(3) var bowCanvas: texture_storage_2d<rgba8unorm, write>;

// The shower: the distances over the ground between which it falls, and its cloud's base.
const BOW_SHOWER: vec2f = vec2f(0.5, 4.0);
const BOW_BASE: f32 = 2.5;
// The luminance of the cloud behind the rain and of the ground, per lux of the sun.
const BOW_CLOUD: f32 = 0.012;
const BOW_GROUND: f32 = 0.003;
// Samples per pixel along each axis, for the horizon's edge.
const BOW_SAMPLES: u32 = 2u;

fn bowRay(pixel: vec2f) -> vec3f {
    let p = (pixel - bow.ahead) / bow.quarter * vec2f(1.0, -1.0);
    let r = dot(p, p);
    return vec3f(2.0 * p.x, 1.0 - r, 2.0 * p.y) / (1.0 + r);
}

fn bowLight(d: vec3f) -> vec3f {
    let gray = dot(bow.illuminance, vec3f(0.2126, 0.7152, 0.0722));
    if (d.z <= 0.0) {
        return vec3f(BOW_GROUND * gray);
    }
    // The ray's stretch in the rain, from where the shower starts to where it ends or the ray enters the cloud.
    let level = max(sqrt(1.0 - d.z * d.z), 1e-4);
    let depth = bow.extinction * max(min(BOW_SHOWER.y / level, BOW_BASE / d.z) - BOW_SHOWER.x / level, 0.0);
    let passed = exp(-depth);
    // Past a thin depth the rain's light grows no further: 1 - passed in the depth's place.
    return gwRainbowOf(d, bow.sun, bow.illuminance, 1.0 - passed, bowTable, bowSampler) + BOW_CLOUD * gray * passed;
}

@compute @workgroup_size(8, 8, 1)
fn bowView(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(bowCanvas);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    var light = vec3f(0.0);
    for (var j = 0u; j < BOW_SAMPLES; j = j + 1u) {
        for (var i = 0u; i < BOW_SAMPLES; i = i + 1u) {
            light = light + bowLight(bowRay(vec2f(id.xy) + (vec2f(f32(i), f32(j)) + 0.5) / f32(BOW_SAMPLES)));
        }
    }
    let exposed = light / f32(BOW_SAMPLES * BOW_SAMPLES) * bow.exposure;
    var color = hdToneMapNeutral(exposed);
    switch bow.curve {
        case 2u: { color = hdToneMapAgx(exposed); }
        case 3u: { color = hdToneMapAces(exposed); }
        case 4u: { color = hdToneMapClip(exposed); }
        default: {}
    }
    textureStore(bowCanvas, vec2i(id.xy), vec4f(hdDither(color, id.xy, 255.0), 1.0));
}
