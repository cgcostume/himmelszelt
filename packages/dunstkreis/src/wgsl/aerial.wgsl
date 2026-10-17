// Looking up and applying the aerial perspective volume, after Hillaire 2020: the light the air adds in front of
// geometry and the transmittance of the geometry's own, over the camera's frustum. Requires `atmosphere.wgsl`.
// Binding-free: the volume's two textures come in as arguments.
//
// Froxels: x and y follow the screen, top left first, z the distance from the camera, at the square of the slice, so
// near slices are thin where the camera looks at most. Slice k holds the air up to its center, maxDistance times
// ((k + 0.5) / slices)^2 km away.

// The distance to the center of slice k of `slices`, in km.
fn dkAerialPerspectiveSliceDistance(slice: u32, slices: u32, maxDistance: f32) -> f32 {
    let w = (f32(slice) + 0.5) / f32(slices);
    return maxDistance * w * w;
}

struct DkAerialPerspective {
    // Light the air adds at the four wavelengths, in the units dkToRgb turns into cd/m².
    luminance: vec4f,
    // Transmittance at the four wavelengths: what reaches the camera of the point's own light.
    transmittance: vec4f,
}

// The aerial perspective of a point at screen coordinates `uv`, in [0, 1] from the top left, `distance` km from the
// camera: the volume's luminance divided by `scale`, the sky pass' skyViewScale it was built with. Between the camera
// and the first slice's center it fades to nothing in the way; beyond maxDistance it stays the last slice's.
fn dkSampleAerialPerspective(
    luminanceVolume: texture_3d<f32>,
    transmittanceVolume: texture_3d<f32>,
    volumeSampler: sampler,
    uv: vec2f,
    distance: f32,
    maxDistance: f32,
    scale: f32,
) -> DkAerialPerspective {
    let slices = f32(textureDimensions(luminanceVolume).z);
    let w = sqrt(max(distance, 0.0) / maxDistance);
    let first = 0.5 / slices;
    let p = vec3f(uv, max(w, first));
    // Both grow linearly with the distance at first, so a point short of the first slice takes its share of it.
    let near = min(distance / dkAerialPerspectiveSliceDistance(0u, u32(slices), maxDistance), 1.0);
    let luminance = textureSampleLevel(luminanceVolume, volumeSampler, p, 0.0) / scale;
    let transmittance = textureSampleLevel(transmittanceVolume, volumeSampler, p, 0.0);
    return DkAerialPerspective(luminance * near, mix(vec4f(1.0), transmittance, near));
}

// A transmittance at the four wavelengths as linear sRGB factors, weighted by the sun's spectrum: a white surface
// lit by sunlight takes the tint the air gives sunlight.
fn dkTransmittanceRgb(a: DkAtmosphere, transmittance: vec4f) -> vec3f {
    let white = a.toRgb * a.solarIlluminance;
    return clamp(a.toRgb * (transmittance * a.solarIlluminance) / max(white, vec3f(1e-9)), vec3f(0.0), vec3f(1.0));
}

// A point's linear sRGB luminance in cd/m², `color`, as seen through the air in front of it.
fn dkApplyAerialPerspective(a: DkAtmosphere, color: vec3f, perspective: DkAerialPerspective) -> vec3f {
    return color * dkTransmittanceRgb(a, perspective.transmittance) + dkToRgb(a, perspective.luminance);
}
