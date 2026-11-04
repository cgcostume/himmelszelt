// The clouds over the background: the cloudscape's layer, premultiplied luminance and transmittance, at whatever size
// it was rendered, read bilinearly over the target, over the sheets, read here at the target's full size for their
// fine strands, over the background in cd/m² where there is one, then exposed and tone mapped like dunstkreis' sky,
// or left linear. Requires `noise.wgsl`, `params.wgsl`, `camera.wgsl`, `sheet.wgsl`, `tonemap.wgsl` and the output
// binding.

@group(0) @binding(0) var<uniform> gwParams: GwParams;
@group(0) @binding(1) var gwClouds: texture_2d<f32>;
@group(0) @binding(2) var gwCloudsSampler: sampler;
@group(0) @binding(3) var gwBackground: texture_2d<f32>;
@group(0) @binding(4) var gwMap: texture_2d_array<f32>;
@group(0) @binding(5) var gwVolumeSampler: sampler;
@group(0) @binding(6) var<uniform> gwSunlight: GwSunlight;
@group(0) @binding(7) var gwAerialLuminance: texture_3d<f32>;
@group(0) @binding(8) var gwAerialTransmittance: texture_3d<f32>;
@group(0) @binding(9) var gwClampSampler: sampler;
@group(0) @binding(10) var gwLight: texture_3d<f32>;
@group(0) @binding(11) var<storage, read> gwDeck: array<f32>;

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
    let low = textureSampleLevel(gwClouds, gwCloudsSampler, uv, 0.0);
    let v = gwPixelRay(vec2f(id.xy) + 0.5, size);
    let o = vec3f(0.0, 0.0, gwParams.planetRadius + gwParams.observerAltitude);
    let spread = length(gwPixelRay(vec2f(id.xy) + vec2f(1.5, 0.5), size) - v);
    var behind = vec3f(0.0);
    if (GW_BACKGROUND) {
        behind = textureLoad(gwBackground, vec2i(id.xy), 0).rgb;
        // The ground in the clouds' shadow: what it sends back dimmed, the air in front of it kept.
        let earth = gwSphere(o, v, gwParams.planetRadius);
        if (earth.hits && earth.near > 0.0) {
            let air = gwAirAt(uv, earth.near, behind);
            behind = air.luminance + (behind - air.luminance) * gwGroundShadow(o + v * earth.near, normalize(gwParams.sunDirection));
        }
    }
    let sheets = gwSheets(o, v, normalize(gwParams.sunDirection), spread, uv, gwAirLight(behind, GW_BACKGROUND));
    // The sheets lie above the cloudscape, unless the observer is above them too.
    var clouds = gwOver(GwLayer(low.rgb, low.a), sheets);
    if (gwParams.sheets > 0u && gwParams.observerAltitude > gwParams.sheet[0].altitude) {
        clouds = gwOver(sheets, GwLayer(low.rgb, low.a));
    }
    var color = clouds.luminance;
    var alpha = clouds.transmittance;
    if (GW_BACKGROUND) {
        color = behind * clouds.transmittance + clouds.luminance;
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
