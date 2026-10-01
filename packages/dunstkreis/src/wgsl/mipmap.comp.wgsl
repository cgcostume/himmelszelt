// Halves one level of a cube map into the next: each texel the mean of the four below it, face by face. Requires
// `cube.wgsl`. A pass, so it declares its source; the output, the next level, comes from `skyCubeOutput`. The source
// is read as a cube, as whoever samples the cube map reads it, at its texels' centers with a nearest sampler: one view
// dimension for the texture, all WebGPU's compatibility mode allows.

@group(0) @binding(0) var dkMipSource: texture_cube<f32>;
@group(0) @binding(1) var dkMipSampler: sampler;

@compute @workgroup_size(8, 8, 1)
fn dkDownsample(@builtin(global_invocation_id) id: vec3u) {
    let size = dkOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let sourceSize = textureDimensions(dkMipSource).x;
    var sum = vec4f(0.0);
    for (var k = 0u; k < 4u; k = k + 1u) {
        let texel = min(id.xy * 2u + vec2u(k & 1u, k >> 1u), vec2u(sourceSize - 1u));
        sum = sum + textureSampleLevel(dkMipSource, dkMipSampler, dkCubeDirection(id.z, texel, sourceSize), 0.0);
    }
    dkOutputStore(id.xy, id.z, sum / 4.0);
}
