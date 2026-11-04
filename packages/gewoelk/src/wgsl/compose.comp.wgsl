// The clouds over the background: the cloud layer, premultiplied luminance and transmittance, at whatever size it was
// rendered, read bilinearly over the target, over the background in cd/m² where there is one, then exposed and tone
// mapped like dunstkreis' sky, or left linear. Requires `params.wgsl`, `tonemap.wgsl` and the output binding.

@group(0) @binding(0) var<uniform> gwParams: GwParams;
@group(0) @binding(1) var gwClouds: texture_2d<f32>;
@group(0) @binding(2) var gwCloudsSampler: sampler;
@group(0) @binding(3) var gwBackground: texture_2d<f32>;

// Tone map for a display by Neutral (1), AgX (2), ACES (3) or none (4); 0 writes the exposed luminance, linear.
override GW_TONE_MAP: u32 = 1u;
override GW_HEADROOM: f32 = 1.0;
override GW_DITHER: bool = true;
// Whether a background is bound; without one the clouds alone are written, premultiplied, with their transmittance.
override GW_BACKGROUND: bool = true;

fn gwToneMap(exposed: vec3f) -> vec3f {
    if (GW_TONE_MAP == 2u) {
        return hdToneMapAgx(exposed);
    }
    if (GW_TONE_MAP == 3u) {
        return hdToneMapAces(exposed);
    }
    if (GW_TONE_MAP == 4u) {
        return hdToneMapClipHdr(exposed, GW_HEADROOM);
    }
    return hdToneMapNeutralHdr(exposed, GW_HEADROOM);
}

@compute @workgroup_size(8, 8, 1)
fn gwCompose(@builtin(global_invocation_id) id: vec3u) {
    let size = gwOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    let clouds = textureSampleLevel(gwClouds, gwCloudsSampler, uv, 0.0);
    var color = clouds.rgb;
    var alpha = clouds.a;
    if (GW_BACKGROUND) {
        let behind = textureLoad(gwBackground, vec2i(id.xy), 0).rgb;
        color = behind * clouds.a + clouds.rgb;
        alpha = 1.0;
    }
    color = color * gwParams.exposure;
    if (GW_TONE_MAP != 0u) {
        color = gwToneMap(color);
        if (GW_DITHER) {
            color = clamp(hdDither(color, id.xy, 255.0), vec3f(0.0), hdEncodeSrgbExtended(vec3f(GW_HEADROOM), GW_HEADROOM));
        }
    }
    gwOutputStore(id.xy, vec4f(color, alpha));
}
