// Bloom: a lens scatters a little of all the light that passes through it, so bright things bleed into what lies around
// them. Jimenez's chain (2014): the image halved level by level, each by 13 bilinear taps, then added back up, each level
// by a 3x3 tent, and mixed into the image by a small share. No threshold: what is bright enough to show is simply bright.
// Requires the output's declaration at group 0, binding 2, `hdBloomOutput`, for its format. A pass, so it declares its
// sources. Four entry points, for the levels as `bloom.ts` runs them.

@group(0) @binding(0) var hdBloomSource: texture_2d<f32>;
@group(0) @binding(1) var hdBloomSampler: sampler;
// The level this one adds to, going up; the blurred image, for the last step.
@group(0) @binding(3) var hdBloomOther: texture_2d<f32>;
@group(0) @binding(4) var<uniform> hdBloomParams: HdBloomParams;

override HD_BLOOM_KARIS: bool = false;

struct HdBloomParams {
    // The share of the blurred image in the result.
    strength: f32,
    // Over how many texels of its level the tent reaches.
    radius: f32,
    // What the light counts as at most, going in: a Sun's disc is far beyond it, in half floats even infinite.
    ceiling: f32,
    // How many levels were added up, which the sum is divided by.
    levels: f32,
}

fn hdBloomTap(uv: vec2f) -> vec3f {
    return textureSampleLevel(hdBloomSource, hdBloomSampler, uv, 0.0).rgb;
}

fn hdBloomUv(id: vec2u) -> vec2f {
    return (vec2f(id) + 0.5) / vec2f(textureDimensions(hdBloomOutput));
}

// Jimenez's 13 taps, as five overlapping boxes of four: the one in the middle counts half, against the shimmer of a single
// box. With `first`, from the image to the first level, each box held at the ceiling; with HD_BLOOM_KARIS also weighted
// by Karis' 1 / (1 + luma), so one very bright texel counts as about one white one and cannot flicker as a blob where it
// moves, at the price of a Sun's disc hardly blooming at all.
fn hdBloomDown(id: vec2u, first: bool) -> vec3f {
    let uv = hdBloomUv(id);
    let t = 1.0 / vec2f(textureDimensions(hdBloomSource));
    var taps: array<vec3f, 13>;
    var at = 0u;
    for (var y = -2; y <= 2; y = y + 2) {
        for (var x = -2; x <= 2; x = x + 2) {
            taps[at] = hdBloomTap(uv + vec2f(f32(x), f32(y)) * t);
            at = at + 1u;
        }
    }
    for (var y = -1; y <= 1; y = y + 2) {
        for (var x = -1; x <= 1; x = x + 2) {
            taps[at] = hdBloomTap(uv + vec2f(f32(x), f32(y)) * t);
            at = at + 1u;
        }
    }
    var boxes = array<array<u32, 4>, 5>(
        array<u32, 4>(9u, 10u, 11u, 12u),
        array<u32, 4>(0u, 1u, 3u, 4u),
        array<u32, 4>(1u, 2u, 4u, 5u),
        array<u32, 4>(3u, 4u, 6u, 7u),
        array<u32, 4>(4u, 5u, 7u, 8u),
    );
    var sum = vec3f(0.0);
    var weights = 0.0;
    for (var b = 0u; b < 5u; b = b + 1u) {
        var box = vec3f(0.0);
        for (var k = 0u; k < 4u; k = k + 1u) {
            box = box + taps[boxes[b][k]] / 4.0;
        }
        var weight = select(0.125, 0.5, b == 0u);
        if (first) {
            let held = clamp(box, vec3f(0.0), vec3f(hdBloomParams.ceiling));
            box = held;
            weight = weight / select(1.0, 1.0 + dot(held, vec3f(0.2126, 0.7152, 0.0722)), HD_BLOOM_KARIS);
        }
        sum = sum + box * weight;
        weights = weights + weight;
    }
    return sum / weights;
}

@compute @workgroup_size(8, 8)
fn hdBloomDownFirst(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(hdBloomOutput))) {
        return;
    }
    textureStore(hdBloomOutput, vec2i(id.xy), vec4f(hdBloomDown(id.xy, true), 1.0));
}

@compute @workgroup_size(8, 8)
fn hdBloomDownNext(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(hdBloomOutput))) {
        return;
    }
    textureStore(hdBloomOutput, vec2i(id.xy), vec4f(hdBloomDown(id.xy, false), 1.0));
}

// This level, read from the way down, plus the one below it spread by a tent.
@compute @workgroup_size(8, 8)
fn hdBloomUp(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(hdBloomOutput))) {
        return;
    }
    let uv = hdBloomUv(id.xy);
    let t = hdBloomParams.radius / vec2f(textureDimensions(hdBloomSource));
    var sum = vec3f(0.0);
    for (var y = -1; y <= 1; y = y + 1) {
        for (var x = -1; x <= 1; x = x + 1) {
            let weight = f32((2 - abs(x)) * (2 - abs(y))) / 16.0;
            sum = sum + hdBloomTap(uv + vec2f(f32(x), f32(y)) * t) * weight;
        }
    }
    let own = textureLoad(hdBloomOther, id.xy, 0).rgb;
    textureStore(hdBloomOutput, vec2i(id.xy), vec4f(own + sum, 1.0));
}

// The image and the sum of the levels' mean, mixed: light is moved, none is added.
@compute @workgroup_size(8, 8)
fn hdBloomMix(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(hdBloomOutput))) {
        return;
    }
    let image = textureLoad(hdBloomSource, id.xy, 0);
    let blurred = textureSampleLevel(hdBloomOther, hdBloomSampler, hdBloomUv(id.xy), 0.0).rgb / hdBloomParams.levels;
    let held = min(image.rgb, vec3f(1e4));
    textureStore(hdBloomOutput, vec2i(id.xy), vec4f(mix(held, blurred, hdBloomParams.strength), image.a));
}
