// Halves one level of a cube map into the next: each texel the mean of the four below it, face by face. A pass, so it
// declares its source; the output, the next level, comes from `skyCubeOutput`.

@group(0) @binding(0) var dkMipSource: texture_2d_array<f32>;

@compute @workgroup_size(8, 8, 1)
fn dkDownsample(@builtin(global_invocation_id) id: vec3u) {
    let size = dkOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let last = vec2i(textureDimensions(dkMipSource)) - 1;
    var sum = vec4f(0.0);
    for (var k = 0u; k < 4u; k = k + 1u) {
        let texel = min(vec2i(id.xy * 2u + vec2u(k & 1u, k >> 1u)), last);
        sum = sum + textureLoad(dkMipSource, texel, i32(id.z), 0);
    }
    dkOutputStore(id.xy, id.z, sum / 4.0);
}
