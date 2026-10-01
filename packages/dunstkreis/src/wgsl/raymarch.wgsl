// Raymarching the sky along one view ray, bent by the air. Requires `atmosphere.wgsl`, `common.wgsl`, `lut.wgsl` and
// `sampling.wgsl`. Binding-free like those: the tables come in as arguments. The sky-view pass fills its table with it,
// and the sky pass and the light meter call it for an observer above the atmosphere, where the table does not reach.

struct DkSkyRay {
    // Scattered light reaching the start of the ray.
    luminance: vec3f,
    // Transmittance along the whole ray: what reaches its start of the light from where it ends.
    transmittance: vec3f,
    // The direction it leaves the atmosphere in, bent; unused where it ends on the ground.
    direction: vec3f,
    hitsGround: bool,
}

// Scattered light reaching a point at altitude h, with local up `up`, along `direction`: single scattering with its
// phase functions, plus the precomputed multiple-scattering term. With `ground`, a ray that ends on the planet adds the
// sunlight the ground reflects, by its albedo: the ground itself, below the horizon or seen from space. Only the
// sun's: the sky's light on the ground is left out, so the ground goes dark once the sun is down.
fn dkRaymarchSky(
    a: DkAtmosphere,
    transmittanceLut: texture_2d<f32>,
    multiScatteringLut: texture_2d<f32>,
    lutSampler: sampler,
    up: vec3f,
    h: f32,
    direction: vec3f,
    sunDirection: vec3f,
    samples: u32,
    ground: bool,
) -> DkSkyRay {
    let horizontal = dkPathHorizontal(up, direction);
    let mu = clamp(dot(direction, up), -1.0, 1.0);

    var result: DkSkyRay;
    result.hitsGround = dkIntersectsGround(a, h, mu);
    result.luminance = vec3f(0.0);
    result.transmittance = vec3f(1.0);

    // A ray going up meets its densest air first, the aerosols within a km or two: its steps grow with the square of
    // the distance, t_k = T (k / N)^2, dense where it starts. Uniform for the rest, whose densest air lies along it.
    let quadratic = mu >= 0.0;
    let n = f32(samples);
    var path = dkPathStart(mu);
    for (var i = 0u; i < samples; i = i + 1u) {
        let k = f32(i);
        let share = select(1.0 / (n - k), (2.0 * k + 1.0) / (n * n - k * k), quadratic);
        let ds = dkPathRemaining(a, h, path, result.hitsGround) * share;
        let step = dkPathAdvance(a, h, path, ds);
        path = step.next;

        let altitude = dkPathAltitude(a, h, step.middle.position);
        let pointUp = dkPathToWorld(dkPathUp(a, h, step.middle.position), up, horizontal);
        let muS = clamp(dot(pointUp, sunDirection), -1.0, 1.0);
        let nu = dot(dkPathToWorld(step.middle.direction, up, horizontal), sunDirection);

        let densityR = dkDensityRayleigh(a, altitude);
        let densityM = dkDensityMie(a, altitude);
        let scattering = a.betaR * densityR + a.betaMSca * densityM;
        let extinction = max(dkExtinction(a, altitude), vec3f(1e-9));
        let stepTransmittance = exp(-extinction * ds);
        let sunTransmittance = dkSampleTransmittanceToTop(a, transmittanceLut, lutSampler, altitude, muS);

        // Single scattering carries the phase functions, which is what puts the glow around the sun and the
        // blue overhead. The multiple-scattering term does not: it was built isotropically on purpose.
        let phases = a.betaR * densityR * dkPhaseRayleigh(nu) + a.betaMSca * densityM * dkPhaseMie(a, nu);
        let multiple = dkSampleMultiScattering(a, multiScatteringLut, lutSampler, altitude, muS) * scattering;

        let inScatter = a.solarIlluminance * (sunTransmittance * phases + multiple);
        result.luminance = result.luminance
            + result.transmittance * (inScatter - inScatter * stepTransmittance) / extinction;
        result.transmittance = result.transmittance * stepTransmittance;
    }
    result.direction = dkPathToWorld(path.direction, up, horizontal);

    // Sunlight the ground reflects diffusely, with the average ground reflectance, as in Hillaire's own renderer.
    if (ground && result.hitsGround) {
        let muS = dot(dkPathToWorld(dkPathUp(a, h, path.position), up, horizontal), sunDirection);
        if (muS > 0.0) {
            let toSun = dkSampleTransmittanceToTop(a, transmittanceLut, lutSampler, 0.0, muS);
            result.luminance = result.luminance
                + result.transmittance * a.solarIlluminance * toSun * muS * a.groundAlbedo / DK_PI;
        }
    }
    return result;
}

// The same for an observer at an altitude above the atmosphere, from where `direction` enters it, with the planet lit.
// Black, with nothing in the way, where the ray misses the atmosphere.
fn dkRaymarchFromSpace(
    a: DkAtmosphere,
    transmittanceLut: texture_2d<f32>,
    multiScatteringLut: texture_2d<f32>,
    lutSampler: sampler,
    altitude: f32,
    direction: vec3f,
    sunDirection: vec3f,
    samples: u32,
) -> DkSkyRay {
    var result: DkSkyRay;
    result.luminance = vec3f(0.0);
    result.transmittance = vec3f(1.0);
    result.direction = direction;
    result.hitsGround = false;

    let top = a.Rt - a.Rg;
    let rc = a.Rg + altitude;
    let b = rc * direction.z;
    // The discriminant of the ray and the atmosphere's sphere, rc^2 - Rt^2 factored as for dkRhoSquared.
    let discriminant = b * b - (altitude - top) * (rc + a.Rt);
    if (discriminant < 0.0 || b >= 0.0) {
        return result;
    }
    let entry = vec3f(0.0, 0.0, rc) + direction * (-b - sqrt(discriminant));
    return dkRaymarchSky(
        a, transmittanceLut, multiScatteringLut, lutSampler, normalize(entry), top, direction, sunDirection, samples, true,
    );
}
