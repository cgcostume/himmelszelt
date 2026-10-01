// The sun disc, drawn wherever the sky is shown rather than stored in it: in the sky pass, and over a sky cube map, which
// holds the sky without it (see `SkyPass.createCubePass`). Binding-free.
//
// Kept out of the cube map on purpose. At some 2e9 cd/m², the disc is far beyond what rgba16float holds, and at 0.53° it
// is smaller than a texel of any cube map but a very large one: stored, it would be a blocky texel, smeared by the mip
// levels, and a point so bright that the spherical harmonics projected from the cube map would ring with it. Drawn here,
// it is exact at any resolution, antialiased by the pixel, for a dot product per pixel.

// How much of a pixel `footprint` radians across the disc covers, the pixel's ray bent to `direction`; with no footprint,
// whether the ray hits it. Measured by the chord between the two unit vectors, which equals the angle this close: a test
// against cos(radius) would need cos to 1e-5, and WGSL promises it only to 2^-11.
fn dkSunDiscCoverage(direction: vec3f, sunDirection: vec3f, angularRadius: f32, footprint: f32) -> f32 {
    let distance = length(direction - sunDirection);
    if (footprint <= 0.0) {
        return select(0.0, 1.0, distance < angularRadius);
    }
    return clamp((angularRadius - distance) / footprint + 0.5, 0.0, 1.0);
}

// The disc's luminance in cd/m², from the sun's illuminance where it is seen, in lux, spread over the disc's solid angle:
// some 15000 times brighter than the sky around it.
fn dkSunDiscLuminance(illuminance: vec3f, angularRadius: f32) -> vec3f {
    return illuminance / (3.141592653589793 * angularRadius * angularRadius);
}

// The disc's luminance along a ray, by how much of its pixel it covers: add it to what a sky cube map gives for the ray.
// `illuminance` is `SkyPass.sunIlluminance()`, zero once the planet hides the sun.
fn dkSunDisc(direction: vec3f, sunDirection: vec3f, angularRadius: f32, illuminance: vec3f, footprint: f32) -> vec3f {
    return dkSunDiscLuminance(illuminance, angularRadius) * dkSunDiscCoverage(direction, sunDirection, angularRadius, footprint);
}
