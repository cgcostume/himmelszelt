// A level of the Milky Way's map from the finer one: each channel's logarithm turned back into light, four texels
// averaged and the logarithm taken again, so a level holds the mean of the light, not of the logarithms.

override SH_STOPS: f32;

@group(0) @binding(0) var shFiner: texture_2d<f32>;
@group(0) @binding(1) var shCoarser: texture_storage_2d<rgba8unorm, write>;

fn shLight(finer: vec2i) -> vec3f {
    let code = textureLoad(shFiner, min(finer, vec2i(textureDimensions(shFiner)) - 1), 0).rgb;
    return select(exp2((code - 1.0) * SH_STOPS), vec3f(0.0), code <= vec3f(0.0));
}

@compute @workgroup_size(8, 8, 1)
fn shMilkyWayDown(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(shCoarser))) {
        return;
    }
    let p = vec2i(id.xy) * 2;
    let light = 0.25 * (shLight(p) + shLight(p + vec2i(1, 0)) + shLight(p + vec2i(0, 1)) + shLight(p + vec2i(1, 1)));
    // The darkest step is black, as the shader that reads the map has it.
    let code = select(clamp(log2(light) / SH_STOPS + 1.0, vec3f(0.0), vec3f(1.0)), vec3f(0.0), light <= vec3f(0.0));
    textureStore(shCoarser, id.xy, vec4f(code, 1.0));
}
