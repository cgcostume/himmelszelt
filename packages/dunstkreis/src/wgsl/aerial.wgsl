// The air in front of geometry, looked up in the aerial perspective volume (after Hillaire 2020): the light the air adds
// between the camera and a point, and what it lets through of the point's own. Requires nothing: no other snippet and no
// uniform of dunstkreis', so it drops into a renderer's own shader as it is, a fragment shader as well as a compute one.
// Binding-free: the volume's two textures and a linear, clamping sampler come in as arguments.
//
// The volume describes itself. Froxels: x and y follow the screen, top left first, z the distance from the camera, at
// the square of the slice, so near slices are thin where the camera looks at most. Slice k holds the air up to its
// center, reach * ((k + 0.5) / slices)^2 km away. The luminance texture holds linear sRGB with a shared exponent, as
// Radiance's files do: rgb * 2^a is cd/m², a the same in every froxel, so half floats hold noon and a moonlit night
// alike. The transmittance texture holds the share that passes per channel in rgb, and the reach in km in a.

// The distance to the center of slice k of `slices`, in km.
fn dkAerialPerspectiveSliceDistance(slice: u32, slices: u32, reach: f32) -> f32 {
    let w = (f32(slice) + 0.5) / f32(slices);
    return reach * w * w;
}

struct DkAerialPerspective {
    // The light the air adds in front of the point, linear sRGB in cd/m².
    luminance: vec3f,
    // What reaches the camera of the point's own light, per channel.
    transmittance: vec3f,
}

// How far the volume reaches, in km: its `maxDistanceKm`, as the volume itself holds it.
fn dkAerialPerspectiveReach(transmittanceVolume: texture_3d<f32>) -> f32 {
    return textureLoad(transmittanceVolume, vec3i(0), 0).a;
}

// dkAerialPerspective for a caller that has the volume's reach at hand, a constant or a uniform of its own, or reads it
// once with dkAerialPerspectiveReach for many lookups.
fn dkAerialPerspectiveWithin(
    luminanceVolume: texture_3d<f32>,
    transmittanceVolume: texture_3d<f32>,
    volumeSampler: sampler,
    uv: vec2f,
    distance: f32,
    reach: f32,
) -> DkAerialPerspective {
    let slices = f32(textureDimensions(luminanceVolume).z);
    let first = 0.5 / slices;
    let p = vec3f(uv, max(sqrt(max(distance, 0.0) / reach), first));
    // Both grow linearly with the distance at first, so a point short of the first slice takes its share of it.
    let near = min(max(distance, 0.0) / (reach * first * first), 1.0);
    let luminance = textureSampleLevel(luminanceVolume, volumeSampler, p, 0.0);
    let transmittance = textureSampleLevel(transmittanceVolume, volumeSampler, p, 0.0).rgb;
    return DkAerialPerspective(luminance.rgb * exp2(luminance.a) * near, mix(vec3f(1.0), transmittance, near));
}

// The air in front of a point at screen coordinates `uv`, in [0, 1] from the top left of the view the volume was built
// for, `distance` km from the camera. A color in cd/m² seen through it is color * transmittance + luminance. Between
// the camera and the first slice's center the air fades to nothing in the way; beyond the reach it stays the last
// slice's, so make the volume reach as far as the geometry does. The air's light between two distances is the
// difference of two lookups, for a stretch the caller knows to lie in shadow.
fn dkAerialPerspective(
    luminanceVolume: texture_3d<f32>,
    transmittanceVolume: texture_3d<f32>,
    volumeSampler: sampler,
    uv: vec2f,
    distance: f32,
) -> DkAerialPerspective {
    let reach = dkAerialPerspectiveReach(transmittanceVolume);
    return dkAerialPerspectiveWithin(luminanceVolume, transmittanceVolume, volumeSampler, uv, distance, reach);
}
