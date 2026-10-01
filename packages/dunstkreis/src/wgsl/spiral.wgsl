// Golden-angle spirals, Vogel's on a disc and Fibonacci's on a sphere, for spreading samples evenly. Binding-free.

// The azimuth of the i-th point, i times the golden angle, wrapped into [-pi, pi). Wrapped exactly, in integers:
// 1640531527 is the golden angle's share of a turn, (3 - sqrt(5)) / 2, times 2^32. WGSL's cos and sin are accurate only
// within [-pi, pi], and i times 2.4 radians leaves that from the second point on: a thousand points in, the GPU's cosine
// had drifted far enough to spoil the sky's light on the ground.
fn dkGoldenAzimuth(i: u32) -> f32 {
    return f32(i * 1640531527u) * (6.283185307179586 / 4294967296.0) - 3.141592653589793;
}
