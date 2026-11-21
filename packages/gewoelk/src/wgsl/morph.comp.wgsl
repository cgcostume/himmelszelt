// The cloudscape between two keyframes: the volumes the march reads, written as a blend of two sets built ahead, so a
// change of shape, of light or of weather shows as a morph while the next keyframe is still being built. Mixed by
// `gwMorph.x`, 0 for the first and 1 for the second; only the distance outside the clouds is not. Requires nothing.

@group(0) @binding(0) var<uniform> gwMorph: vec4f;
@group(0) @binding(1) var gwFromModeling: texture_3d<f32>;
@group(0) @binding(2) var gwToModeling: texture_3d<f32>;
@group(0) @binding(3) var gwModelingOut: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(4) var gwFromLight: texture_3d<f32>;
@group(0) @binding(5) var gwToLight: texture_3d<f32>;
@group(0) @binding(6) var gwLightOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(7) var gwFromAmbient: texture_3d<f32>;
@group(0) @binding(8) var gwToAmbient: texture_3d<f32>;
@group(0) @binding(9) var gwAmbientOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(10) var gwFromMap: texture_2d<f32>;
@group(0) @binding(11) var gwToMap: texture_2d<f32>;
@group(0) @binding(12) var gwMapOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(13) var<storage, read> gwFromDeck: array<f32>;
@group(0) @binding(14) var<storage, read> gwToDeck: array<f32>;
@group(0) @binding(15) var<storage, read_write> gwDeckOut: array<f32>;

// The modeling data between two keyframes. The profile mixes, so a cloud only one of them has thins out or grows in
// through the detail noise's erosion; its type and scale are that keyframe's then, the other's being those of clear
// sky. In between, the clouds are the union of both, so the distance outside is the nearer of the two: a mixed one
// would step past a surface.
fn gwMorphedModeling(a: vec4f, b: vec4f, t: f32) -> vec4f {
    let one = (a.r > 0.0) != (b.r > 0.0);
    let look = select(mix(a.gb, b.gb, t), select(b.gb, a.gb, a.r > 0.0), one);
    var outside = min(a.a, b.a);
    if (t <= 0.0) {
        outside = a.a;
    } else if (t >= 1.0) {
        outside = b.a;
    }
    return vec4f(mix(a.r, b.r, t), look, outside);
}

@compute @workgroup_size(4, 4, 4)
fn gwMorphVolume(@builtin(global_invocation_id) id: vec3u) {
    if (any(id >= textureDimensions(gwModelingOut))) {
        return;
    }
    let at = vec3i(id);
    let t = clamp(gwMorph.x, 0.0, 1.0);
    textureStore(gwModelingOut, at, gwMorphedModeling(textureLoad(gwFromModeling, at, 0), textureLoad(gwToModeling, at, 0), t));
    textureStore(gwLightOut, at, mix(textureLoad(gwFromLight, at, 0), textureLoad(gwToLight, at, 0), t));
}

@compute @workgroup_size(4, 4, 4)
fn gwMorphAmbient(@builtin(global_invocation_id) id: vec3u) {
    if (any(id >= textureDimensions(gwAmbientOut))) {
        return;
    }
    let at = vec3i(id);
    textureStore(gwAmbientOut, at, mix(textureLoad(gwFromAmbient, at, 0), textureLoad(gwToAmbient, at, 0), clamp(gwMorph.x, 0.0, 1.0)));
}

// The cloud map, which the march thins the clouds by, and what the deck lets through on average.
@compute @workgroup_size(8, 8, 1)
fn gwMorphMap(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(gwMapOut);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let at = vec2i(id.xy);
    let t = clamp(gwMorph.x, 0.0, 1.0);
    textureStore(gwMapOut, at, mix(textureLoad(gwFromMap, at, 0), textureLoad(gwToMap, at, 0), t));
    if (id.x == 0u && id.y == 0u) {
        for (var i = 0u; i < 4u; i = i + 1u) {
            gwDeckOut[i] = mix(gwFromDeck[i], gwToDeck[i], t);
        }
    }
}
