// Raymarching the sky along one view ray, bent by the air. Requires `atmosphere.wgsl`, `common.wgsl`, `lut.wgsl` and
// `sampling.wgsl`. Binding-free like those: the tables come in as arguments. The sky-view pass fills its table with it,
// and the sky pass and the light meter call it for an observer above the atmosphere, where the table does not reach. A
// segment of it is the aerial perspective, the air in front of geometry, which the aerial perspective volume holds.

struct DkSkyRay {
    // Scattered light reaching the start of the ray.
    luminance: vec4f,
    // Transmittance along the whole ray: what reaches its start of the light from where it ends.
    transmittance: vec4f,
    // The direction it leaves the atmosphere in, or where a segment ends, bent; unused where it ends on the ground.
    direction: vec3f,
    hitsGround: bool,
    // Local up where it ends.
    endUp: vec3f,
}

// One step of a march along `path` from altitude h, local up `up`, ds km long: adds the light scattered into the ray over
// it to `ray`, single scattering with its phase functions plus the precomputed multiple-scattering term, and dims
// what lies beyond by the step's transmittance. Returns the path after the step.
fn dkRaymarchStep(
    a: DkAtmosphere,
    transmittanceLut: texture_2d<f32>,
    multiScatteringLut: texture_2d<f32>,
    lutSampler: sampler,
    up: vec3f,
    horizontal: vec3f,
    h: f32,
    sunDirection: vec3f,
    path: DkPath,
    ds: f32,
    ray: ptr<function, DkSkyRay>,
) -> DkPath {
    let step = dkPathAdvance(a, h, path, ds);
    let altitude = step.altitude;
    let pointUp = dkPathToWorld(dkPathUp(a, h, step.middle.position), up, horizontal);
    let muS = clamp(dot(pointUp, sunDirection), -1.0, 1.0);
    let nu = dot(dkPathToWorld(step.middle.direction, up, horizontal), sunDirection);

    let densityR = dkDensityRayleigh(a, altitude);
    let densityM = dkDensityMie(a, altitude);
    let scattering = a.betaR * densityR + a.betaMSca * densityM;
    let extinction = max(dkExtinction(a, altitude), vec4f(1e-9));
    let stepTransmittance = exp(-extinction * ds);
    let sunTransmittance = dkSampleTransmittanceToTop(a, transmittanceLut, lutSampler, altitude, muS);

    // Single scattering carries the phase functions, which is what puts the glow around the sun and the
    // blue overhead. The multiple-scattering term does not: it was built isotropically on purpose.
    let phases = a.betaR * densityR * dkPhaseRayleigh(nu) + a.betaMSca * densityM * dkPhaseMie(a, nu);
    var inScatter = vec4f(0.0);
    if (DK_SINGLE_SCATTERING) {
        inScatter += sunTransmittance * phases;
    }
    if (DK_MULTIPLE_SCATTERING) {
        inScatter += dkSampleMultiScattering(a, multiScatteringLut, lutSampler, altitude, muS) * scattering;
    }
    inScatter *= a.solarIlluminance;
    (*ray).luminance += (*ray).transmittance * (inScatter - inScatter * stepTransmittance) / extinction;
    (*ray).transmittance *= stepTransmittance;
    return step.next;
}

// Scattered light reaching a point at altitude h, with local up `up`, along `direction`, from at most `distance` km
// away: the air between an observer and an opaque point that far, which adds this light and lets `transmittance` of
// the point's own through, the aerial perspective. A ray that leaves the atmosphere or meets the ground first ends
// there. The point's own light is the caller's: nothing is added for the ground. Inside the atmosphere only.
fn dkRaymarchSegment(
    a: DkAtmosphere,
    transmittanceLut: texture_2d<f32>,
    multiScatteringLut: texture_2d<f32>,
    lutSampler: sampler,
    up: vec3f,
    h: f32,
    direction: vec3f,
    sunDirection: vec3f,
    distance: f32,
    samples: u32,
) -> DkSkyRay {
    let horizontal = dkPathHorizontal(up, direction);
    let mu = clamp(dot(direction, up), -1.0, 1.0);

    var result: DkSkyRay;
    result.hitsGround = dkIntersectsGround(a, h, mu);
    result.luminance = vec4f(0.0);
    result.transmittance = vec4f(1.0);

    // A ray going up meets its densest air first, the aerosols within a km or two: its steps grow with the square of
    // the distance, t_k = T (k / N)^2, dense where it starts. Uniform for the rest, whose densest air lies along it.
    let quadratic = mu >= 0.0;
    let n = f32(samples);
    var path = dkPathStart(mu);
    let total = min(dkPathRemainingStart(a, h, path, result.hitsGround), distance);
    var traveled = 0.0;
    for (var i = 0u; i < samples; i = i + 1u) {
        let k = f32(i);
        let share = select(1.0 / (n - k), (2.0 * k + 1.0) / (n * n - k * k), quadratic);
        // What is left before this step: the straight ray's share of its whole, or aimed anew along the bent tangent.
        var remaining = total * select((n - k) / n, (n * n - k * k) / (n * n), quadratic);
        if (DK_REFRACTION) {
            remaining = min(dkPathRemaining(a, h, path, result.hitsGround), distance - traveled);
        }
        let ds = remaining * share;
        traveled += ds;
        path = dkRaymarchStep(
            a, transmittanceLut, multiScatteringLut, lutSampler, up, horizontal, h, sunDirection, path, ds, &result,
        );
    }
    result.direction = dkPathToWorld(path.direction, up, horizontal);
    result.endUp = dkPathToWorld(dkPathUp(a, h, path.position), up, horizontal);
    return result;
}

// A distance longer than any ray through the atmosphere: a segment that long is the whole ray.
const DK_WHOLE_RAY: f32 = 1e9;

// Scattered light reaching a point at altitude h, with local up `up`, along `direction`, all the way out: the sky.
// With `ground`, a ray that ends on the planet adds the sunlight the ground reflects, by its albedo: the ground itself,
// below the horizon or seen from space. Only the sun's: the sky's light on the ground is left out, so the ground goes
// dark once the sun is down.
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
    var result = dkRaymarchSegment(
        a, transmittanceLut, multiScatteringLut, lutSampler, up, h, direction, sunDirection, DK_WHOLE_RAY, samples,
    );
    // Sunlight the ground reflects diffusely, with the average ground reflectance, as in Hillaire's own renderer.
    if (ground && result.hitsGround) {
        let muS = dot(result.endUp, sunDirection);
        if (muS > 0.0) {
            let toSun = dkSampleTransmittanceToTop(a, transmittanceLut, lutSampler, 0.0, muS);
            result.luminance = result.luminance
                + result.transmittance * a.solarIlluminance * toSun * muS * a.groundAlbedo / DK_PI;
        }
    }
    return result;
}

// Where a ray from an observer at an altitude above the atmosphere, ENU with z up, enters it: the local up there in xyz
// and the distance to it in w, negative where the ray misses the atmosphere.
fn dkAtmosphereEntry(a: DkAtmosphere, altitude: f32, direction: vec3f) -> vec4f {
    let top = a.Rt - a.Rg;
    let rc = a.Rg + altitude;
    let b = rc * direction.z;
    // The discriminant of the ray and the atmosphere's sphere, rc^2 - Rt^2 factored as for dkRhoSquared.
    let discriminant = b * b - (altitude - top) * (rc + a.Rt);
    if (discriminant < 0.0 || b >= 0.0) {
        return vec4f(0.0, 0.0, 1.0, -1.0);
    }
    let t = -b - sqrt(discriminant);
    return vec4f(normalize(vec3f(0.0, 0.0, rc) + direction * t), t);
}

// The same as dkRaymarchSky for an observer at an altitude above the atmosphere, from where `direction` enters it, with
// the planet lit. Black, with nothing in the way, where the ray misses the atmosphere.
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
    result.luminance = vec4f(0.0);
    result.transmittance = vec4f(1.0);
    result.direction = direction;
    result.hitsGround = false;
    result.endUp = vec3f(0.0, 0.0, 1.0);

    let entry = dkAtmosphereEntry(a, altitude, direction);
    if (entry.w < 0.0) {
        return result;
    }
    return dkRaymarchSky(
        a, transmittanceLut, multiScatteringLut, lutSampler, entry.xyz, a.Rt - a.Rg, direction, sunDirection, samples,
        true,
    );
}

// The aerial perspective of a point `distance` km from an observer at any altitude, ENU with z up, along `direction`:
// dkRaymarchSegment inside the atmosphere, and from where the ray enters it above. Nothing in the way of a point
// short of it.
fn dkRaymarchAerialPerspective(
    a: DkAtmosphere,
    transmittanceLut: texture_2d<f32>,
    multiScatteringLut: texture_2d<f32>,
    lutSampler: sampler,
    altitude: f32,
    direction: vec3f,
    sunDirection: vec3f,
    distance: f32,
    samples: u32,
) -> DkSkyRay {
    let top = a.Rt - a.Rg;
    if (altitude <= top) {
        return dkRaymarchSegment(
            a, transmittanceLut, multiScatteringLut, lutSampler, vec3f(0.0, 0.0, 1.0), max(altitude, 0.0), direction,
            sunDirection, distance, samples,
        );
    }
    let entry = dkAtmosphereEntry(a, altitude, direction);
    if (entry.w < 0.0 || entry.w >= distance) {
        return DkSkyRay(vec4f(0.0), vec4f(1.0), direction, false, vec3f(0.0, 0.0, 1.0));
    }
    return dkRaymarchSegment(
        a, transmittanceLut, multiScatteringLut, lutSampler, entry.xyz, top, direction, sunDirection,
        distance - entry.w, samples,
    );
}
