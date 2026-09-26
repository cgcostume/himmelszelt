// Raymarching the sky along one view ray. Requires `atmosphere.wgsl`, `common.wgsl`, `lut.wgsl` and `sampling.wgsl`.
// Binding-free like those: the tables come in as arguments. The sky-view pass fills its table with it, and the render
// pass calls it per pixel for an observer above the atmosphere, where the table does not reach.

// Scattered light reaching `origin` along `direction`: single scattering with its phase functions, plus the
// precomputed multiple-scattering term. `h` is the origin's altitude, passed exactly (see common.wgsl). With `ground`,
// a ray that ends on the planet adds the sunlight the ground reflects, which is what shows the planet from space.
fn dkRaymarchSky(
    a: DkAtmosphere,
    transmittanceLut: texture_2d<f32>,
    multiScatteringLut: texture_2d<f32>,
    lutSampler: sampler,
    origin: vec3f,
    h: f32,
    direction: vec3f,
    sunDirection: vec3f,
    steps: u32,
    ground: bool,
) -> vec3f {
    let r = a.Rg + h;
    let mu = dot(origin, direction) / length(origin);
    let nu = dot(direction, sunDirection);

    let hitsGround = dkIntersectsGround(a, h, mu);
    var tMax = dkDistanceToTopAtmosphereBoundary(a, r, mu);
    if (hitsGround) {
        tMax = dkDistanceToBottomAtmosphereBoundary(a, h, mu);
    }

    let phaseR = dkPhaseRayleigh(nu);
    let phaseM = dkPhaseMie(a, nu);

    var luminance = vec3f(0.0);
    var throughput = vec3f(1.0);
    let dt = tMax / f32(steps);

    for (var i = 0u; i < steps; i = i + 1u) {
        let t = (f32(i) + 0.5) * dt;
        let altitude = dkAltitudeAlongRay(a, h, mu, t);
        let ri = a.Rg + altitude;
        let muS = clamp(dot(origin + direction * t, sunDirection) / ri, -1.0, 1.0);

        let densityR = dkDensityRayleigh(a, altitude);
        let densityM = dkDensityMie(a, altitude);
        let scattering = a.betaR * densityR + a.betaMSca * densityM;
        let extinction = max(dkExtinction(a, altitude), vec3f(1e-9));
        let stepTransmittance = exp(-extinction * dt);

        var sunTransmittance = vec3f(0.0);
        if (!dkIntersectsGround(a, altitude, muS)) {
            sunTransmittance = dkSampleTransmittanceToTop(a, transmittanceLut, lutSampler, ri, muS);
        }

        // Single scattering carries the phase functions, which is what puts the glow around the sun and the
        // blue overhead. The multiple-scattering term does not: it was built isotropically on purpose.
        let single = sunTransmittance * (a.betaR * densityR * phaseR + a.betaMSca * densityM * phaseM);
        let multiple = dkSampleMultiScattering(a, multiScatteringLut, lutSampler, ri, muS) * scattering;

        let inScatter = a.solarIrradiance * (single + multiple);
        luminance = luminance + throughput * (inScatter - inScatter * stepTransmittance) / extinction;
        throughput = throughput * stepTransmittance;
    }

    // Sunlight the ground reflects diffusely, with the average ground reflectance, as in Hillaire's own renderer.
    if (ground && hitsGround) {
        let up = normalize(origin + direction * tMax);
        let muS = dot(up, sunDirection);
        if (muS > 0.0) {
            let toSun = dkSampleTransmittanceToTop(a, transmittanceLut, lutSampler, a.Rg, muS);
            luminance = luminance + throughput * a.solarIrradiance * toSun * muS * a.avgGroundReflectance / DK_PI;
        }
    }

    return luminance;
}
