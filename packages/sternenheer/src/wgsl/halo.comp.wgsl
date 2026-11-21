// The halos' grid, summed by the bin pass, spread into each star's halo: the grid halved level by level, each texel the
// mean of the four below it, then added back up from the coarsest level, each level its share of the light,
// `haloWeights`, and the sum of those above it blurred by a tent. A level holds the light about twice as wide as the
// one below, and the shares make the sum fall as a halo does, with the cube of the distance: light is moved, none is
// added, whatever the number of stars. The grid holds exposed luminance in units of display white, as half floats.
// Requires `params.wgsl`, and `air.wgsl` and `seeing.wgsl` (dunstkreis').

@group(0) @binding(0) var<uniform> shParams: ShParams;
// The finest level, three floats a texel as bits, as the bin pass summed them.
@group(0) @binding(1) var<storage, read> shHaloSums: array<u32>;
// The level this dispatch writes, the level below it, which it halves, or its own level, which it adds up, and the
// sum of the levels above it.
@group(0) @binding(2) var shHaloLevel: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var shHaloFiner: texture_2d<f32>;
@group(0) @binding(4) var shHaloCoarser: texture_2d<f32>;
@group(0) @binding(5) var shHaloSampler: sampler;
@group(0) @binding(6) var<uniform> shHaloStep: ShHaloStep;

// Which level a dispatch writes.
struct ShHaloStep {
    level: u32,
    pad0: u32,
    pad1: u32,
    pad2: u32,
}

// The size of the finest level in texels: the target and its margin, at the grid's scale.
fn shHaloSize() -> vec2u {
    return (vec2u(shParams.width, shParams.height) + 2u * SH_HALO_MARGIN + SH_HALO_SCALE - 1u) / SH_HALO_SCALE;
}

fn shHaloSum(texel: vec2u) -> vec3f {
    let size = shHaloSize();
    if (any(texel >= size)) {
        return vec3f(0.0);
    }
    let at = (texel.y * size.x + texel.x) * 3u;
    return vec3f(bitcast<f32>(shHaloSums[at]), bitcast<f32>(shHaloSums[at + 1u]), bitcast<f32>(shHaloSums[at + 2u]));
}

// A texel of the level below: none past its edge, so the mean keeps the light where the grid does not divide evenly.
fn shHaloBelow(texel: vec2u) -> vec3f {
    if (shHaloStep.level == 1u) {
        return shHaloSum(texel);
    }
    if (any(texel >= textureDimensions(shHaloFiner))) {
        return vec3f(0.0);
    }
    return textureLoad(shHaloFiner, texel, 0).rgb;
}

@compute @workgroup_size(8, 8)
fn shHaloDown(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(shHaloLevel))) {
        return;
    }
    let base = id.xy * 2u;
    let sum = shHaloBelow(base) + shHaloBelow(base + vec2u(1u, 0u)) + shHaloBelow(base + vec2u(0u, 1u)) + shHaloBelow(base + 1u);
    textureStore(shHaloLevel, vec2i(id.xy), vec4f(min(0.25 * sum, vec3f(SH_HALO_MOST)), 1.0));
}

@compute @workgroup_size(8, 8)
fn shHaloUp(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(shHaloLevel);
    if (any(id.xy >= size)) {
        return;
    }
    let level = shHaloStep.level;
    var light = vec3f(0.0);
    if (level == 0u) {
        light = shHaloSum(id.xy);
    } else {
        light = textureLoad(shHaloFiner, id.xy, 0).rgb;
    }
    light = light * shParams.haloWeights[level / 4u][level % 4u];
    if (level + 1u < shParams.haloLevels) {
        // The coarser level spans twice this one's texels, and as many more where this one's count is odd.
        let coarser = vec2f(textureDimensions(shHaloCoarser));
        let center = (vec2f(id.xy) + 0.5) * 0.5;
        for (var y = -1; y <= 1; y = y + 1) {
            for (var x = -1; x <= 1; x = x + 1) {
                let weight = f32((2 - abs(x)) * (2 - abs(y))) / 16.0;
                let uv = (center + vec2f(f32(x), f32(y)) * 0.5) / coarser;
                light = light + textureSampleLevel(shHaloCoarser, shHaloSampler, uv, 0.0).rgb * weight;
            }
        }
    }
    textureStore(shHaloLevel, vec2i(id.xy), vec4f(min(light, vec3f(SH_HALO_MOST)), 1.0));
}
