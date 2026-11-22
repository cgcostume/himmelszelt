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

// A solar eclipse along a march: the Moon stands before the Sun for some of the air and not for the rest, its shadow. No
// binding: whoever marches sets `dkEclipse` first, and left alone it is no eclipse at all.
struct DkEclipse {
    // Where the Moon's center stands off the line from the march's start towards the Sun, in km, across that line.
    offset: vec3f,
    // How far along that line the Moon is, in km.
    along: f32,
    // Unit vector towards the Sun, the true direction, in the march's frame.
    sunDirection: vec3f,
    // The Moon's radius in km; 0 for no eclipse.
    moonRadius: f32,
    // The Sun's angular radius, in radians.
    sunRadius: f32,
    // 1 where the march's frame holds both sides of the Sun's meridian as one, as the sky-view table does: the shadow is
    // then the mean of itself and its mirror image, and the sky stays alike on both sides.
    mirrored: f32,
}

var<private> dkEclipse: DkEclipse;

// The share of a disc of angular radius `sun` that one of radius `moon` leaves uncovered, their centers `apart`: 1 with
// nothing in front and 0 in a total eclipse, what two discs overlap by, the Sun's taken as evenly bright.
fn dkDiscUncovered(sun: f32, moon: f32, apart: f32) -> f32 {
    if (apart >= sun + moon) {
        return 1.0;
    }
    if (apart <= abs(moon - sun)) {
        return 1.0 - min(moon * moon / (sun * sun), 1.0);
    }
    let towardsSun = clamp((apart * apart + sun * sun - moon * moon) / (2.0 * apart * sun), -1.0, 1.0);
    let towardsMoon = clamp((apart * apart + moon * moon - sun * sun) / (2.0 * apart * moon), -1.0, 1.0);
    let kite = max((sun + moon - apart) * (apart + sun - moon) * (apart - sun + moon) * (apart + sun + moon), 0.0);
    let lens = sun * sun * acos(towardsSun) + moon * moon * acos(towardsMoon) - 0.5 * sqrt(kite);
    return clamp(1.0 - lens / (DK_PI * sun * sun), 0.0, 1.0);
}

// How far light scattered more than once reaches sideways, in km, and its shares by where it comes from: three quarters
// from the air close by, the rest from rings 60, 150 and 300 km out. The air is a thin slab, so little crosses far.
const DK_ECLIPSE_RINGS = vec3f(60.0, 150.0, 300.0);
const DK_ECLIPSE_WEIGHTS = vec4f(0.77, 0.174, 0.046, 0.01);

// The shares of the Sun's light a point `x` km from the march's start gets with the Moon `offset` km off its line to the
// Sun: x of the sunlight itself, the Sun's disc as that point sees it uncovered, and y of the light scattered more than
// once, which reaches it from the air around. In the Moon's shadow that is all there is: the shadow is some 200 km
// wide, the air's light crosses it from the sunlit air outside, and the sky at totality is the deep blue of dusk.
fn dkEclipseSharesOff(offset: vec3f, x: vec3f) -> vec2f {
    let sun = dkEclipse.sunDirection;
    let forward = dot(x, sun);
    let along = dkEclipse.along - forward;
    if (along <= 0.0) {
        return vec2f(1.0);
    }
    let across = offset - (x - sun * forward);
    let moon = dkEclipse.moonRadius / along;
    let direct = dkDiscUncovered(dkEclipse.sunRadius, moon, length(across) / along);
    // Out in the half shadow the light around is as the light here.
    if (direct >= 0.15) {
        return vec2f(direct);
    }
    let first = normalize(cross(sun, select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(sun.z) > 0.9)));
    let second = cross(sun, first);
    var around = DK_ECLIPSE_WEIGHTS.x * direct;
    for (var ring = 0u; ring < 3u; ring = ring + 1u) {
        var sum = 0.0;
        for (var side = 0u; side < 4u; side = side + 1u) {
            let turn = (f32(side) + 0.33 * f32(ring)) * 1.5707963267948966;
            let out = across + DK_ECLIPSE_RINGS[ring] * (cos(turn) * first + sin(turn) * second);
            sum += dkDiscUncovered(dkEclipse.sunRadius, moon, length(out) / along);
        }
        around += DK_ECLIPSE_WEIGHTS[ring + 1u] * 0.25 * sum;
    }
    return vec2f(direct, mix(around, direct, smoothstep(0.05, 0.15, direct)));
}

fn dkEclipseShares(x: vec3f) -> vec2f {
    if (dkEclipse.moonRadius <= 0.0) {
        return vec2f(1.0);
    }
    let shares = dkEclipseSharesOff(dkEclipse.offset, x);
    if (dkEclipse.mirrored < 0.5) {
        return shares;
    }
    return 0.5 * (shares + dkEclipseSharesOff(dkEclipse.offset * vec3f(1.0, -1.0, 1.0), x));
}

// The eclipse as a march sees it that starts `x` km from where `dkEclipse` was set for.
fn dkEclipseFrom(x: vec3f) -> DkEclipse {
    var moved = dkEclipse;
    let forward = dot(x, moved.sunDirection);
    moved.offset = moved.offset - (x - moved.sunDirection * forward);
    moved.along = moved.along - forward;
    return moved;
}

// One step of a march along `path` from altitude h, local up `up`, ds km long: adds the light scattered into the ray over
// it to `ray`, single scattering with its phase functions plus the precomputed multiple-scattering term, each by its
// share in a solar eclipse, and dims what lies beyond by the step's transmittance. Returns the path after the step.
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
    // blue overhead. The multiple-scattering term does not: it was built isotropically on purpose. The aureole's
    // share of the aerosols' lobe is left out here and added per pixel by the sky pass, where a table cannot hold it.
    let phases = a.betaR * densityR * dkPhaseRayleigh(nu)
        + a.betaMSca * densityM * dkPhaseMie(a, nu) * (1.0 - DK_AUREOLE_SHARE);
    let eclipse = dkEclipseShares(dkPathToWorld(step.middle.position, up, horizontal));
    var inScatter = vec4f(0.0);
    if (DK_SINGLE_SCATTERING) {
        inScatter += sunTransmittance * phases * eclipse.x;
    }
    if (DK_MULTIPLE_SCATTERING) {
        inScatter += dkSampleMultiScattering(a, multiScatteringLut, lutSampler, altitude, muS) * scattering * eclipse.y;
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

// Steps of the aureole's march: its integrand is smooth, the phase function is not in it.
const DK_AUREOLE_SAMPLES: u32 = 24u;

// The aureole's march: the sunlight the aerosols along a ray scatter, without the phase function, at the four
// wavelengths, ∫ βM ρM(t) T(0, t) T☉(t) dt, from an observer at altitude h, z up, to where the ray leaves the atmosphere
// or meets the ground. Along the same bent path as the sky's own march, so the ground, the bent horizon and the
// observer's height are the sky's; dimmed by the air in front, as the sky is, which keeps a ray along the horizon, with
// some hundred times the aerosols overhead, from glowing white. Times solarIlluminance and the narrow lobe's phase and
// share, it is the aureole: that close to the sun, the scattering angle hardly changes along the ray.
fn dkRaymarchAerosol(
    a: DkAtmosphere,
    transmittanceLut: texture_2d<f32>,
    lutSampler: sampler,
    h: f32,
    direction: vec3f,
    sunDirection: vec3f,
) -> vec4f {
    let up = vec3f(0.0, 0.0, 1.0);
    let horizontal = dkPathHorizontal(up, direction);
    let mu = clamp(direction.z, -1.0, 1.0);
    let hitsGround = dkIntersectsGround(a, h, mu);
    let quadratic = mu >= 0.0;
    let n = f32(DK_AUREOLE_SAMPLES);
    var path = dkPathStart(mu);
    let total = dkPathRemainingStart(a, h, path, hitsGround);
    var transmittance = vec4f(1.0);
    var column = vec4f(0.0);
    for (var i = 0u; i < DK_AUREOLE_SAMPLES; i = i + 1u) {
        let k = f32(i);
        let share = select(1.0 / (n - k), (2.0 * k + 1.0) / (n * n - k * k), quadratic);
        var remaining = total * select((n - k) / n, (n * n - k * k) / (n * n), quadratic);
        if (DK_REFRACTION) {
            remaining = dkPathRemaining(a, h, path, hitsGround);
        }
        let ds = remaining * share;
        let step = dkPathAdvance(a, h, path, ds);
        let pointUp = dkPathToWorld(dkPathUp(a, h, step.middle.position), up, horizontal);
        let muS = clamp(dot(pointUp, sunDirection), -1.0, 1.0);
        let extinction = max(dkExtinction(a, step.altitude), vec4f(1e-9));
        let stepTransmittance = exp(-extinction * ds);
        let toSun = dkSampleTransmittanceToTop(a, transmittanceLut, lutSampler, step.altitude, muS);
        let scattering = a.betaMSca * dkDensityMie(a, step.altitude);
        let eclipse = dkEclipseShares(dkPathToWorld(step.middle.position, up, horizontal)).x;
        column += transmittance * toSun * scattering * (eclipse * (1.0 - stepTransmittance)) / extinction;
        transmittance *= stepTransmittance;
        path = step.next;
    }
    return column;
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
            // Where the ray meets the ground, from its start: the Moon's shadow lies on the ground too.
            let eclipse = dkEclipseShares(a.Rg * result.endUp - (a.Rg + h) * up).x;
            result.luminance = result.luminance
                + result.transmittance * a.solarIlluminance * toSun * (eclipse * muS) * a.groundAlbedo / DK_PI;
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
    // The march starts where the ray enters the air, and so does its eclipse.
    let here = dkEclipse;
    dkEclipse = dkEclipseFrom(direction * entry.w);
    result = dkRaymarchSky(
        a, transmittanceLut, multiScatteringLut, lutSampler, entry.xyz, a.Rt - a.Rg, direction, sunDirection, samples,
        true,
    );
    dkEclipse = here;
    return result;
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
    let here = dkEclipse;
    dkEclipse = dkEclipseFrom(direction * entry.w);
    let segment = dkRaymarchSegment(
        a, transmittanceLut, multiScatteringLut, lutSampler, entry.xyz, top, direction, sunDirection,
        distance - entry.w, samples,
    );
    dkEclipse = here;
    return segment;
}
