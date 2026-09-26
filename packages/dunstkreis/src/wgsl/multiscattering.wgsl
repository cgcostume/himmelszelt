// Hillaire's multiple-scattering LUT precompute. Requires `atmosphere.wgsl`, `common.wgsl`, `lut.wgsl`,
// `sampling.wgsl` and `quality.wgsl`. A pass, so it declares its bindings.
//
// This is what replaces Bruneton's 4D inscatter table and its ping-pong over scattering orders. The trick is
// to assume multiply scattered light is isotropic, which makes each order a fixed fraction of the one before
// it, so the whole infinite series collapses into a geometric sum: L2 / (1 - f). A 32x32 texture then holds
// every order at once, and there is nothing to iterate.

@group(0) @binding(0) var<uniform> dkAtmosphere: DkAtmosphere;
@group(0) @binding(1) var dkTransmittanceLut: texture_2d<f32>;
@group(0) @binding(2) var dkLutSampler: sampler;
@group(0) @binding(3) var dkMultiScatteringOut: texture_storage_2d<rgba16float, write>;

// Directions sampled per axis, so 64 in total. Hillaire's own value. Quadratic, and this pass is the whole
// precompute cost in the fast variant, so it is not an override: 64 is cheap and there is little to gain.
const DK_MS_DIRECTIONS: u32 = 8u;

struct DkMultiScatterSample {
    // Second-order scattered light: what arrives after exactly one further bounce.
    luminance: vec3f,
    // The fraction of light a bounce hands on to the next order, the ratio of the geometric series.
    transfer: vec3f,
}

// Raymarches one direction, accumulating both terms. Isotropic throughout: no phase function appears, which
// is precisely the assumption that makes the series summable.
fn dkIntegrateMultiScattering(a: DkAtmosphere, h: f32, direction: vec3f, sunDirection: vec3f)
    -> DkMultiScatterSample {
    let isotropicPhase = 1.0 / (4.0 * DK_PI);

    let r = a.Rg + h;
    let origin = vec3f(0.0, 0.0, r);
    let mu = direction.z;

    let hitsGround = dkIntersectsGround(a, h, mu);
    var tMax = dkDistanceToTopAtmosphereBoundary(a, r, mu);
    if (hitsGround) {
        tMax = dkDistanceToBottomAtmosphereBoundary(a, h, mu);
    }

    var result: DkMultiScatterSample;
    result.luminance = vec3f(0.0);
    result.transfer = vec3f(0.0);

    var throughput = vec3f(1.0);
    let dt = tMax / f32(DK_SAMPLES_MULTI_SCATTERING);

    for (var i = 0u; i < DK_SAMPLES_MULTI_SCATTERING; i = i + 1u) {
        let t = (f32(i) + 0.5) * dt;
        let altitude = dkAltitudeAlongRay(a, h, mu, t);
        let ri = a.Rg + altitude;
        let muS = clamp(dot(origin + direction * t, sunDirection) / ri, -1.0, 1.0);

        let scattering = a.betaR * dkDensityRayleigh(a, altitude) + a.betaMSca * dkDensityMie(a, altitude);
        let extinction = max(dkExtinction(a, altitude), vec3f(1e-9));
        let stepTransmittance = exp(-extinction * dt);

        // The planet itself shadows the sample when the sun is below its local horizon.
        var sunTransmittance = vec3f(0.0);
        if (!dkIntersectsGround(a, altitude, muS)) {
            sunTransmittance = dkSampleTransmittanceToTop(a, dkTransmittanceLut, dkLutSampler, ri, muS);
        }

        // Integrated across the step analytically rather than as a point sample, so few steps suffice. The
        // sunlight scatters towards the ray with the isotropic phase; the transfer term is light scattered
        // from unit incoming radiance over the whole sphere, whose phase integrates to 1 (Hillaire eq. 7).
        let inScatter = sunTransmittance * scattering * isotropicPhase;
        result.luminance = result.luminance + throughput * (inScatter - inScatter * stepTransmittance) / extinction;
        result.transfer = result.transfer + throughput * (scattering - scattering * stepTransmittance) / extinction;

        throughput = throughput * stepTransmittance;
    }

    // Light that reached the ground bounces back up, diffusely and with the ground's albedo.
    if (hitsGround) {
        let groundPosition = origin + direction * tMax;
        let muSGround = clamp(dot(normalize(groundPosition), sunDirection), -1.0, 1.0);
        if (muSGround > 0.0) {
            let toSun = dkSampleTransmittanceToTop(a, dkTransmittanceLut, dkLutSampler, a.Rg, muSGround);
            result.luminance = result.luminance
                + throughput * toSun * muSGround * a.avgGroundReflectance / DK_PI;
        }
    }

    return result;
}

@compute @workgroup_size(8, 8)
fn dkPrecomputeMultiScattering(@builtin(global_invocation_id) id: vec3u) {
    let size = vec2f(textureDimensions(dkMultiScatteringOut));
    if (f32(id.x) >= size.x || f32(id.y) >= size.y) {
        return;
    }

    let a = dkAtmosphere;
    let uv = (vec2f(f32(id.x), f32(id.y)) + 0.5) / size;
    let rMuS = dkMultiScatteringRMuS(a, uv, size);

    let h = rMuS.x - a.Rg;
    let muS = rMuS.y;
    let sunDirection = vec3f(sqrt(max(1.0 - muS * muS, 0.0)), 0.0, muS);

    var luminance = vec3f(0.0);
    var transfer = vec3f(0.0);

    for (var i = 0u; i < DK_MS_DIRECTIONS; i = i + 1u) {
        for (var j = 0u; j < DK_MS_DIRECTIONS; j = j + 1u) {
            // Uniform over the sphere: azimuth linear, polar angle inverted through the cosine, so that
            // equal-area patches get equal numbers of samples rather than clustering at the poles.
            let azimuth = 2.0 * DK_PI * (f32(i) + 0.5) / f32(DK_MS_DIRECTIONS);
            let polar = acos(1.0 - 2.0 * (f32(j) + 0.5) / f32(DK_MS_DIRECTIONS));
            let direction = vec3f(sin(polar) * cos(azimuth), sin(polar) * sin(azimuth), cos(polar));

            let sample = dkIntegrateMultiScattering(a, h, direction, sunDirection);
            luminance = luminance + sample.luminance;
            transfer = transfer + sample.transfer;
        }
    }

    // Both are integrals over the sphere with the isotropic phase, 4 pi / N per direction times 1 / (4 pi):
    // plain averages over the directions (Hillaire eqs. 5 and 7).
    let directions = f32(DK_MS_DIRECTIONS * DK_MS_DIRECTIONS);
    luminance = luminance / directions;
    transfer = transfer / directions;

    // The geometric series over all remaining orders. Clamped below 1 because a transfer of 1 would mean a
    // perfectly conserving atmosphere and an infinite sum.
    let series = 1.0 / (1.0 - min(transfer, vec3f(0.999)));

    textureStore(dkMultiScatteringOut, vec2i(id.xy), vec4f(luminance * series, 1.0));
}
