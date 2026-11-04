// The eye at night, binding-free: below some 4 cd/m² the rods take over from the cones, colors fade and shift towards
// blue, and in moonlight the world is blue. Jensen et al.'s blue shift (Night Rendering, 2000, §3.1), with
// Larson et al.'s scotopic luminance from XYZ (1997). Per pixel, on its luminance in cd/m², before the exposure.

const HD_SRGB_TO_XYZ: mat3x3f = mat3x3f(
    vec3f(0.4124, 0.2126, 0.0193),
    vec3f(0.3576, 0.7152, 0.1192),
    vec3f(0.1805, 0.0722, 0.9505),
);
const HD_XYZ_TO_SRGB: mat3x3f = mat3x3f(
    vec3f(3.2406, -0.9689, 0.0557),
    vec3f(-1.5372, 1.8758, -0.2040),
    vec3f(-0.4986, 0.0415, 1.0570),
);
// The chromaticity the rods' light is shifted towards, where the bluest night paintings lie.
const HD_NIGHT_BLUE: vec2f = vec2f(0.25, 0.25);

// How much the cones see of a luminance in cd/m²: 0 below 0.01, the rods alone, 1 above 4, the cones alone, between
// by a smoothstep over the decades.
fn hdConeShare(luminance: f32) -> f32 {
    let t = clamp((log2(max(luminance, 1e-30)) * 0.30103 + 2.0) / 2.6, 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

// Linear sRGB in cd/m² as the eye sees it at that level: the rods' share shifted to `HD_NIGHT_BLUE` and carried by
// their own luminance, 0.4468 of it, Y over V for a white field.
fn hdNightVision(rgb: vec3f) -> vec3f {
    let xyz = HD_SRGB_TO_XYZ * max(rgb, vec3f(0.0));
    let sum = xyz.x + xyz.y + xyz.z;
    if (sum <= 0.0 || xyz.x <= 0.0) {
        return vec3f(0.0);
    }
    let scotopic = xyz.y * (1.33 * (1.0 + (xyz.y + xyz.z) / xyz.x) - 1.68);
    let s = hdConeShare(xyz.y);
    let xy = mix(HD_NIGHT_BLUE, xyz.xy / sum, s);
    let y = mix(0.4468 * max(scotopic, 0.0), xyz.y, s);
    let shifted = vec3f(xy.x * y / xy.y, y, (1.0 - xy.x - xy.y) * y / xy.y);
    return max(HD_XYZ_TO_SRGB * shifted, vec3f(0.0));
}
