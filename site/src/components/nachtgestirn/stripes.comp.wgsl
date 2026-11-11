// The chapter's comparisons: a Moon as nachtgestirn's pass finished it, striped where its light is off another's by
// more than a third of a stop, as a camera stripes what clips: red where it is brighter, blue where darker, in four
// steps of opacity, from a third of a stop, two thirds, one and two stops off; and only where either is bright enough
// to tell. Both lights exposed, linear and premultiplied, from the pass without a background. Takes the output binding
// from nachtgestirn's `moonOutput`.

@group(0) @binding(0) var finished: texture_2d<f32>;
@group(0) @binding(1) var shown: texture_2d<f32>;
@group(0) @binding(2) var reference: texture_2d<f32>;

const LUMINANCE = vec3f(0.2126, 0.7152, 0.0722);
// Below this exposed luminance a pixel is too dark to tell.
const DARK = 1e-3;

@compute @workgroup_size(8, 8, 1)
fn stripe(@builtin(global_invocation_id) id: vec3u) {
    let size = ngOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let pixel = vec2i(id.xy);
    let finishedColor = textureLoad(finished, pixel, 0);
    let shownLight = textureLoad(shown, pixel, 0);
    var color = finishedColor.rgb;

    let striped = (id.x + id.y) % 6u < 3u;
    let shownLuminance = dot(shownLight.rgb, LUMINANCE);
    let referenceLuminance = dot(textureLoad(reference, pixel, 0).rgb, LUMINANCE);
    if (striped && shownLight.a > 0.5 && max(shownLuminance, referenceLuminance) > DARK) {
        let stops = log2(max(shownLuminance, DARK) / max(referenceLuminance, DARK));
        let off = abs(stops);
        let amount = select(select(select(0.3, 0.6, off > 2.0 / 3.0), 0.8, off > 1.0), 1.0, off > 2.0);
        if (stops > 1.0 / 3.0) {
            color = mix(color, vec3f(1.0, 0.0, 0.3), amount);
        } else if (stops < -1.0 / 3.0) {
            color = mix(color, vec3f(0.1, 0.45, 1.0), amount);
        }
    }
    ngOutputStore(id.xy, vec4f(color, finishedColor.a));
}
