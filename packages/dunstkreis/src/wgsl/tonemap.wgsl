// Tone curves for a display: exposed luminance, scene-linear Rec. 709 where 1 saturates, to sRGB-encoded values in
// [0, 1] for an 8-bit target. Binding-free, so a renderer that tone maps its whole frame can use the same.

// Exposed by EV100, a light meter's reading lands at 1/9.6 of saturation, its calibration K = 12.5 over ISO 100 times
// 1.2: a camera's convention, which the ACES fit was built for. Neutral and AgX expect scene middle gray at 0.18 instead:
// this is the gain from one to the other, 0.18 * 9.6.
const DK_MIDDLE_GRAY_GAIN: f32 = 1.728;

fn dkEncodeSrgb(linear: vec3f) -> vec3f {
    let x = clamp(linear, vec3f(0.0), vec3f(1.0));
    return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}

// Khronos PBR Neutral (2024): linear up to 0.76 apart from a small offset in the blacks, so colors stay as they are,
// then compressed towards white and desaturated only as much as that takes. Hues never shift.
fn dkToneMapNeutral(exposed: vec3f) -> vec3f {
    let startCompression = 0.8 - 0.04;
    let desaturation = 0.15;
    var color = max(exposed * DK_MIDDLE_GRAY_GAIN, vec3f(0.0));
    let x = min(color.r, min(color.g, color.b));
    color = color - select(0.04, x - 6.25 * x * x, x < 0.08);
    let peak = max(color.r, max(color.g, color.b));
    if (peak < startCompression) {
        return dkEncodeSrgb(color);
    }
    let d = 1.0 - startCompression;
    let newPeak = 1.0 - d * d / (peak + d - startCompression);
    color = color * (newPeak / peak);
    let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    return dkEncodeSrgb(mix(color, vec3f(newPeak), g));
}

// Narkowicz's fit of the ACES filmic curve (2016), what dunstkreis used before: a toe, a straight middle and a
// shoulder rolling off towards white. Saturated, and it shifts bright hues towards yellow and white.
fn dkToneMapAces(exposed: vec3f) -> vec3f {
    let x = max(exposed, vec3f(0.0));
    return dkEncodeSrgb(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14));
}

// Sobotka's AgX, in Wrensch's minimal fit: into a slightly desaturated working space, a sigmoid over 16.5 stops in
// log2, and back. Bright colors fade towards white as film does, so the sun's glow and a sunset's brightest band turn
// white rather than clipping to a flat hue. Its output is display-encoded already.
fn dkToneMapAgx(exposed: vec3f) -> vec3f {
    let inset = mat3x3f(
        0.842479062253094, 0.0423282422610123, 0.0423756549057051,
        0.0784335999999992, 0.878468636469772, 0.0784336,
        0.0792237451477643, 0.0791661274605434, 0.879142973793104,
    );
    let outset = mat3x3f(
        1.19687900512017, -0.0528968517574562, -0.0529716355144438,
        -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
        -0.0990297440797205, -0.0989611768448433, 1.15107367264116,
    );
    let minEv = -12.47393;
    let maxEv = 4.026069;
    let lifted = inset * (exposed * DK_MIDDLE_GRAY_GAIN);
    let x = (clamp(log2(max(lifted, vec3f(1e-10))), vec3f(minEv), vec3f(maxEv)) - minEv) / (maxEv - minEv);
    let x2 = x * x;
    let x4 = x2 * x2;
    let curve = 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
    return clamp(outset * curve, vec3f(0.0), vec3f(1.0));
}
