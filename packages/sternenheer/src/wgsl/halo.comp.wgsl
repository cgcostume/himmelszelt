// The halos' grid, summed by the bin pass, into the first level of the halos' pyramid, which helldunkel's bloom chain
// then halves level by level and adds back up: each level holds a star's excess light spread twice as wide and a
// quarter as bright, and all of them together fall as 1 / r² from the star, over the whole target, at the cost of a
// blur and whatever the number of stars. Held under what half floats take.

@group(0) @binding(0) var<storage, read> shHaloSums: array<u32>;
@group(0) @binding(1) var shHaloLevel: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn shHaloResolve(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(shHaloLevel);
    if (any(id.xy >= size)) {
        return;
    }
    let at = (id.y * size.x + id.x) * 3u;
    let light = vec3f(bitcast<f32>(shHaloSums[at]), bitcast<f32>(shHaloSums[at + 1u]), bitcast<f32>(shHaloSums[at + 2u]));
    textureStore(shHaloLevel, vec2i(id.xy), vec4f(min(light, vec3f(3e4)), 1.0));
}
