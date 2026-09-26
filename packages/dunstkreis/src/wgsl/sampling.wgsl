// Sampling the precomputed tables. Requires `atmosphere.wgsl`, `common.wgsl` and `lut.wgsl`.
//
// Split out from the passes that write the tables so that the render path, the multiple-scattering pass and
// a consumer's own shader can all read them the same way.

// Transmittance of light arriving at radius r from the true direction with cosine mu, the sun's, by lookup rather than
// integration. Zero where the planet hides that direction, below the horizon lowered by refraction.
fn dkSampleTransmittanceToTop(
    a: DkAtmosphere,
    lut: texture_2d<f32>,
    lutSampler: sampler,
    r: f32,
    mu: f32,
) -> vec3f {
    let size = vec2f(textureDimensions(lut));
    return textureSampleLevel(lut, lutSampler, dkTransmittanceUv(a, r, mu, size), 0.0).rgb;
}

// Hillaire's multiple-scattering term: the light that reached this point after more than one bounce, summed
// over every order at once. Stored isotropically, so it needs no phase function on lookup.
fn dkSampleMultiScattering(
    a: DkAtmosphere,
    lut: texture_2d<f32>,
    lutSampler: sampler,
    r: f32,
    muS: f32,
) -> vec3f {
    let size = vec2f(textureDimensions(lut));
    return textureSampleLevel(lut, lutSampler, dkMultiScatteringUv(a, r, muS, size), 0.0).rgb;
}
