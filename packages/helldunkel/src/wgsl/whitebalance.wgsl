// White balance, binding-free: a reference white shown as D65 at its own luminance, by the linear Bradford transform
// (ICC.1:2022 Annex E). On linear sRGB, before the exposure and the tone curve. As `whiteBalance` and `applyWhiteBalance`.

// Linear sRGB to Bradford's sharpened cone responses, through XYZ, and back, and D65's, from sRGB's primaries.
const HD_SRGB_TO_LMS: mat3x3f = mat3x3f(
    vec3f(0.422658041, 0.0556908, 0.0213792411),
    vec3f(0.491356641, 0.961556208, 0.0876439216),
    vec3f(0.0273644971, 0.0231893749, 0.980743433),
);
const HD_LMS_TO_SRGB: mat3x3f = mat3x3f(
    vec3f(2.53844797, -0.146000365, -0.0422883757),
    vec3f(-1.29348257, 1.11662241, -0.07159007),
    vec3f(-0.0402432469, -0.0223285197, 1.02250731),
);
const HD_D65_LMS: vec3f = vec3f(0.941379179, 1.04043638, 1.0897666);

// `rgb` balanced by a matrix from `whiteBalance`, hdWhiteBalanceFor or hdWhiteBalanceBy; the identity leaves it as it is, to the bit.
fn hdWhiteBalance(rgb: vec3f, balance: mat3x3f) -> vec3f {
    return balance * rgb;
}

// The matrix that shows `white`, linear sRGB, as D65 of the same luminance: for a white metered on the GPU, such as
// the Moon's light at the observer, without a round trip. A white without light gives the identity.
fn hdWhiteBalanceFor(white: vec3f) -> mat3x3f {
    return hdWhiteBalanceBy(white, 1.0);
}

// The same, as far as `degree` goes, from 0, none, to 1, all the way: an eye adapts less than fully, `adaptationDegree`,
// and each gain is mixed with 1 by it, as CIECAM02 does.
fn hdWhiteBalanceBy(white: vec3f, degree: f32) -> mat3x3f {
    let lms = HD_SRGB_TO_LMS * white;
    let y = dot(white, vec3f(0.212639006, 0.715168679, 0.0721923154));
    if (y <= 0.0 || any(lms <= vec3f(0.0))) {
        return mat3x3f(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.0, 1.0));
    }
    let gain = mix(vec3f(1.0), HD_D65_LMS * y / lms, clamp(degree, 0.0, 1.0));
    return HD_LMS_TO_SRGB * mat3x3f(HD_SRGB_TO_LMS[0] * gain, HD_SRGB_TO_LMS[1] * gain, HD_SRGB_TO_LMS[2] * gain);
}
