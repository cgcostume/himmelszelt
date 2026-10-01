// Sampling the precomputed tables. Requires `atmosphere.wgsl`, `common.wgsl` and `lut.wgsl`.
//
// Split out from the passes that write the tables so that the render path, the multiple-scattering pass and
// a consumer's own shader can all read them the same way. Both take the altitude h in km, not the radius.

// Transmittance of light arriving at altitude h from the true direction with cosine mu, the sun's, by lookup rather
// than integration. Zero where the planet hides that direction, below the horizon lowered by refraction.
fn dkSampleTransmittanceToTop(
    a: DkAtmosphere,
    lut: texture_2d<f32>,
    lutSampler: sampler,
    h: f32,
    mu: f32,
) -> vec4f {
    // Below the table's lowest direction no light arrives: without refraction that is the horizon itself, where the
    // lookup would otherwise clamp to the edge column's grazing light.
    if (mu < dkTransmittanceMuMin(a, h)) {
        return vec4f(0.0);
    }
    let size = vec2f(textureDimensions(lut));
    return textureSampleLevel(lut, lutSampler, dkTransmittanceUv(a, h, mu, size), 0.0);
}

// Hillaire's multiple-scattering term: the light that reached this point after more than one bounce, summed
// over every order at once. Stored isotropically, so it needs no phase function on lookup.
fn dkSampleMultiScattering(
    a: DkAtmosphere,
    lut: texture_2d<f32>,
    lutSampler: sampler,
    h: f32,
    muS: f32,
) -> vec4f {
    let size = vec2f(textureDimensions(lut));
    return dkMultiScatteringDecode(textureSampleLevel(lut, lutSampler, dkMultiScatteringUv(a, h, muS, size), 0.0));
}
