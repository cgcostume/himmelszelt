// Halves one level of a map into the next: each texel the mean of the four below it. The color map holds sRGB-encoded
// values, averaged as the light they stand for and encoded again; the relief, heights and slopes, is averaged as it
// is. Requires `surface.wgsl` for the sRGB curves and the output binding from `moonOutput`.

@group(0) @binding(0) var ngMipSource: texture_2d<f32>;

// Whether the map holds sRGB-encoded colors, the color map, or values to average as they are, the relief.
override NG_MIP_SRGB: bool = true;

@compute @workgroup_size(8, 8, 1)
fn ngDownsample(@builtin(global_invocation_id) id: vec3u) {
    let size = ngOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let sourceSize = textureDimensions(ngMipSource);
    var sum = vec4f(0.0);
    for (var corner = 0u; corner < 4u; corner = corner + 1u) {
        let texel = min(id.xy * 2u + vec2u(corner & 1u, corner >> 1u), sourceSize - 1u);
        var value = textureLoad(ngMipSource, texel, 0);
        if (NG_MIP_SRGB) {
            value = vec4f(ngSrgbToLinear(value.rgb), value.a);
        }
        sum = sum + value;
    }
    var mean = sum / 4.0;
    if (NG_MIP_SRGB) {
        mean = vec4f(ngLinearToSrgb(mean.rgb), mean.a);
    }
    ngOutputStore(id.xy, mean);
}
