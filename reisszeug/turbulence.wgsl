// Turbulence, binding-free: what wanders an image seen through the air and blurs what the pixels cannot follow.
// reisszeug: every identifier is prefixed `rz`, which the package inlining it renames.

// Kolmogorov's turbulence as eight octaves of waves, each half the size, from `cell` up to the outer scale, some 128
// lens widths, its tilt as the sixth root of the size, blown across the sky by the wind and changing as it goes;
// `rms` the tilt along each axis, in radians on the sky. A camera resolves only waves of `resolved` and longer, and
// no wave moving the image by more than RZ_TURBULENCE_FOLD of its own wavelength: an octave's three waves together
// steeper than one would fold the image over itself into hairs and noise. What the pixels cannot follow, the finer
// waves and the steep ones' excess, they average into a blur instead, as each pixel gathers light moved about within
// it: its variance, in square radians, the third returned. `parts` weighs the three largest octaves and the five
// smaller; its third the wind's drift across the sky, in radians a second.
const RZ_TURBULENCE_FOLD: f32 = 0.04;
const RZ_TURBULENCE_OCTAVES: u32 = 8u;
// sqrt(2 / sum of the octaves' squared weights): three waves of each, 2^((7 - octave) / 6).
const RZ_TURBULENCE_NORM: f32 = 0.18;
fn rzTurbulence(onSky: vec2f, time: f32, cell: f32, resolved: f32, rms: f32, parts: vec3f) -> vec3f {
    var moved = vec2f(0.0);
    var blur = 0.0;
    let blown = onSky - vec2f(0.8, 0.6) * parts.z * time;
    for (var i = 0u; i < 3u * RZ_TURBULENCE_OCTAVES; i = i + 1u) {
        let octave = f32(i / 3u);
        let size = cell * exp2(f32(RZ_TURBULENCE_OCTAVES - 1u) - octave);
        let weight = select(parts.y, parts.x, octave < 3.0);
        let full = rms * RZ_TURBULENCE_NORM * pow(size / cell, 1.0 / 6.0) * weight;
        let amplitude = select(0.0, min(full, size * RZ_TURBULENCE_FOLD * weight), size >= resolved);
        // Never below none: fused into one multiply-add, the difference of the equal squares can come out a hair under
        // zero, and its root at the end a NaN that sends every pixel's taps to the same texel.
        blur = blur + 0.5 * max(full * full - amplitude * amplitude, 0.0);
        if (amplitude > 0.0) {
            let angle = f32(i) * 2.399963 + 0.4;
            let across = vec2f(cos(angle), sin(angle));
            let drift = time * (3.0 + 1.25 * octave + 0.37 * f32(i));
            // In turns, wrapped before the sine: a GPU's is accurate only near zero, and a wave here is thousands in.
            let turns = dot(blown, across) / size + (f32(i) * 1.7 + drift) / 6.2831853;
            moved = moved + amplitude * vec2f(
                sin(6.2831853 * fract(turns)),
                cos(6.2831853 * fract(turns * 0.93 + f32(i) / 6.2831853)),
            );
        }
    }
    return vec3f(moved, blur);
}
