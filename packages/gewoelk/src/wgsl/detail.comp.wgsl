// The detail noise the dimensional profile is eroded with, as Nubis3's: four channels of a tiling 3D texture, curly
// alligator noise at a low and a high frequency for wisps, alligator noise at both for billows, made once on the GPU.
// Requires `noise.wgsl`.

@group(0) @binding(0) var gwDetailOut: texture_storage_3d<rgba8unorm, write>;

fn gwStretch(ridge: f32) -> f32 {
    return clamp(ridge * 2.2, 0.0, 1.0);
}

@compute @workgroup_size(4, 4, 4)
fn gwDetail(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(gwDetailOut);
    if (any(id >= size)) {
        return;
    }
    let uv = (vec3f(id) + 0.5) / vec3f(size);
    let low = vec3i(4);
    let high = vec3i(12);
    // The ridges' value runs to about 0.5: stretched to fill [0, 1], and the wisps as its inverse.
    let wispyLow = 1.0 - gwStretch(1.0 - gwCurlyAlligator(uv * 4.0, low, 1u, 0.6));
    let wispyHigh = 1.0 - gwStretch(1.0 - gwCurlyAlligator(uv * 12.0, high, 2u, 0.6));
    // Two octaves each, so the billows have billows on them.
    let billowLow = gwStretch(0.7 * gwAlligator(uv * 4.0, low, 3u) + 0.3 * gwAlligator(uv * 8.0, low * 2, 4u));
    let billowHigh = gwStretch(0.7 * gwAlligator(uv * 12.0, high, 5u) + 0.3 * gwAlligator(uv * 24.0, high * 2, 6u));
    textureStore(gwDetailOut, vec3i(id), vec4f(wispyLow, wispyHigh, billowLow, billowHigh));
}
