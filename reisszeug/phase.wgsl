// Phase functions, binding-free: how much of the light a particle scatters goes off at an angle, per steradian, 1 over
// the sphere. reisszeug: every identifier is prefixed `rz`, which the package inlining it renames.

// Henyey and Greenstein's, one lobe: forward for `g` above 0, backward below; `cosTheta` the cosine of the angle the
// light is turned through.
fn rzHenyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    return 0.07957747154594767 * (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-7), 1.5);
}
