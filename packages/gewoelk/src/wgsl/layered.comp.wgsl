// The layered model's composition: the marched layers, at their share of the frame, and the sheet of high cloud over the
// background, the corona over both, then white balance, exposure and the tone curve. Requires `params`, `camera`,
// `corona`, `whitebalance`, `tonemap` and `cloudOutput`.

@group(0) @binding(0) var<uniform> gwParams: GwParams;
@group(0) @binding(1) var gwLayersLight: texture_2d<f32>;
@group(0) @binding(2) var gwLayersSampler: sampler;
@group(0) @binding(3) var gwHighLight: texture_2d<f32>;
@group(0) @binding(4) var gwBackground: texture_2d<f32>;
// helldunkel's blue noise, read with GW_DITHER.
@group(0) @binding(5) var gwBlueNoise: texture_2d<f32>;
// x the sheet's altitude in km, y and z whether the layers and the sheet are there.
@group(0) @binding(6) var<uniform> gwLayered: vec4f;

// Tone map for a display by Neutral (1), AgX (2), ACES (3) or none (4); 0 writes the exposed luminance, linear.
override GW_TONE_MAP: u32 = 1u;
override GW_HEADROOM: f32 = 1.0;
override GW_DITHER: bool = true;
// Whether a background is bound; without one the clouds alone are written, premultiplied, with their transmittance.
override GW_BACKGROUND: bool = true;

fn gwLayeredToneMap(exposed: vec3f) -> vec3f {
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
fn gwLayeredCompose(@builtin(global_invocation_id) id: vec3u) {
    let size = gwOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let ndc = (vec2f(id.xy) + 0.5) / vec2f(size) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
    let v = dkProjectRay(gwParams.inverseViewProjection, ndc, clamp(gwParams.projectionDistance, 0.0, 1.0));
    // The layers from four taps two thirds of a texel of theirs out: a box three texels wide, over which the march's
    // jitter is even by design, so its grain goes.
    var layers = vec4f(0.0, 0.0, 0.0, 1.0);
    if (gwLayered.y > 0.5) {
        let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
        let apart = 2.0 / 3.0 / vec2f(textureDimensions(gwLayersLight));
        layers = vec4f(0.0);
        for (var k = 0; k < 4; k = k + 1) {
            let corner = vec2f(f32(k & 1), f32(k >> 1)) * 2.0 - 1.0;
            layers = layers + 0.25 * textureSampleLevel(gwLayersLight, gwLayersSampler, uv + corner * apart, 0.0);
        }
    }
    var high = vec4f(0.0, 0.0, 0.0, 1.0);
    if (gwLayered.z > 0.5) {
        high = textureLoad(gwHighLight, vec2i(id.xy), 0);
    }
    // The sheet lies behind the layers for an observer under it, in front for one above.
    var front = layers;
    var back = high;
    if (gwParams.observerAltitude > gwLayered.x) {
        front = high;
        back = layers;
    }
    var color = back.rgb * front.a + front.rgb;
    var alpha = back.a * front.a;
    let through = alpha;
    if (GW_BACKGROUND) {
        color = color + textureLoad(gwBackground, vec2i(id.xy), 0).rgb * alpha;
        alpha = 1.0;
    }
    // The corona of the Sun and of the Moon, where the clouds let some of their light through.
    if (gwParams.coronaRadius > 0.0 && through < 1.0) {
        let sun = gwCorona(v, normalize(gwParams.sunDirection), gwParams.sunIlluminance, through, gwParams.coronaRadius, gwParams.coronaSpread);
        let moon = gwCorona(v, normalize(gwParams.moonDirection), gwParams.moonIlluminance, through, gwParams.coronaRadius, gwParams.coronaSpread);
        color = color + sun + moon;
    }
    color = hdWhiteBalance(color, gwParams.whiteBalance) * gwParams.exposure;
    if (GW_TONE_MAP != 0u) {
        color = gwLayeredToneMap(color);
        if (GW_DITHER) {
            color = clamp(hdDitherBlue(color, id.xy, 255.0, gwBlueNoise), vec3f(0.0), hdEncodeSrgbExtended(vec3f(GW_HEADROOM), GW_HEADROOM));
        }
    }
    gwOutputStore(id.xy, vec4f(color, alpha));
}
