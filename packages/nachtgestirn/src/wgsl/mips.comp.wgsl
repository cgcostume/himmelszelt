// Halves one level of a map into the next: each texel the mean of the four below it. The color map holds sRGB-encoded
// values, averaged as the light they stand for and encoded again; a normal map is averaged as it is. Requires
// `surface.wgsl` for the sRGB curve and the output binding from `moonOutput`.

@group(0) @binding(0) var nbMipSource: texture_2d<f32>;

override NB_MIP_SRGB: bool = true;

fn nbLinearToSrgb(c: vec3f) -> vec3f {
    let low = c * 12.92;
    let high = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
    return select(high, low, c <= vec3f(0.0031308));
}

@compute @workgroup_size(8, 8, 1)
fn nbDownsample(@builtin(global_invocation_id) id: vec3u) {
    let size = nbOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let sourceSize = textureDimensions(nbMipSource);
    var sum = vec4f(0.0);
    for (var k = 0u; k < 4u; k = k + 1u) {
        let texel = min(id.xy * 2u + vec2u(k & 1u, k >> 1u), sourceSize - 1u);
        var t = textureLoad(nbMipSource, texel, 0);
        if (NB_MIP_SRGB) {
            t = vec4f(nbSrgbToLinear(t.rgb), t.a);
        }
        sum = sum + t;
    }
    var mean = sum / 4.0;
    if (NB_MIP_SRGB) {
        mean = vec4f(nbLinearToSrgb(mean.rgb), mean.a);
    }
    nbOutputStore(id.xy, mean);
}
