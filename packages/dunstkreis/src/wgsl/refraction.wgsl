// Atmospheric refraction, the GPU twin of `src/refraction.ts`. Self-contained: it depends on nothing else in
// this package, not even the atmosphere uniform block, so the moon, star and cloud modules can paste it in on
// its own and warp their rays with exactly the same function the sky uses.
//
// One model for every ray: refraction comes from the air along it, mostly from around its lowest point, so it falls off
// with that point's height like the air pressure does. B(a) is Bennett's fit at sea level, p(h) the pressure ratio:
// - a ray going up bends by B(a) p(h_observer), its lowest point being the observer;
// - a ray from space grazing the planet crosses the air twice, in and out, and bends by 2 B(0) p(h_lowest);
// - a ray going down from an elevated observer, past the ground, bends by 2 B(0) p(h_lowest) - B(|a|) p(h_observer),
//   all the way out once and back up from its lowest point to the observer.

const DK_DEG_TO_RAD: f32 = 0.01745329251994330;
const DK_PRESSURE_SCALE_HEIGHT_M: f32 = 8434.5;
// Bennett's fit is Earth's, so the planet it takes the lowest point of a ray over is Earth's too.
const DK_REFRACTION_EARTH_RADIUS_M: f32 = 6371000.0;

// Air pressure at a height above sea level, relative to sea level. Refraction scales with it, so it falls off
// with the observer's height and vanishes at the top of the atmosphere.
fn dkAirPressureRatio(observerHeightM: f32) -> f32 {
    return exp(-observerHeightM / DK_PRESSURE_SCALE_HEIGHT_M);
}

// Bennett's fit, in degrees, at sea level and 10 degrees Celsius: Meeus 16.3 from Bennett 1982, with the trailing
// constant zeroing it at the zenith. It has a pole at -4.4 degrees, so the input is clamped at 0.
fn dkBennett(apparentAltitude: f32) -> f32 {
    let h = max(apparentAltitude, 0.0);
    return (1.0 / tan((h + 7.31 / (h + 4.4)) * DK_DEG_TO_RAD) + 0.0013515216737563) / 60.0;
}

// Meeus' 283/(273+T) temperature scaling (ch. 16), exactly 1 at the fit's own conditions.
fn dkTemperatureScale(temperatureC: f32) -> f32 {
    return 283.0 / (273.0 + temperatureC);
}

// Refraction, in degrees, of a ray going up at the apparent altitude (degrees) it arrives at.
fn dkAtmosphericRefractionFromApparent(apparentAltitude: f32, observerHeightM: f32, temperatureC: f32) -> f32 {
    return dkBennett(apparentAltitude) * dkAirPressureRatio(observerHeightM) * dkTemperatureScale(temperatureC);
}

// Refraction, in degrees, along the whole ray an observer looks along, up or down; see above. Takes the sine and cosine
// of its apparent altitude, from the direction vector: the ray's lowest point, h cos(a) - R (1 - cos(a)), would lose
// kilometers to WGSL's cos, and 1 - cos(a) = sin(a)^2 / (1 + cos(a)) loses nothing.
fn dkRefractionAlongRay(sinAltitude: f32, cosAltitude: f32, observerHeightM: f32, temperatureC: f32) -> f32 {
    let apparentAltitude = atan2(sinAltitude, cosAltitude) / DK_DEG_TO_RAD;
    if (sinAltitude >= 0.0) {
        return dkAtmosphericRefractionFromApparent(apparentAltitude, observerHeightM, temperatureC);
    }
    let lowest = observerHeightM * cosAltitude
        - DK_REFRACTION_EARTH_RADIUS_M * sinAltitude * sinAltitude / (1.0 + cosAltitude);
    let twice = 2.0 * dkBennett(0.0) * dkAirPressureRatio(max(lowest, 0.0));
    let back = dkBennett(-apparentAltitude) * dkAirPressureRatio(observerHeightM);
    return (twice - back) * dkTemperatureScale(temperatureC);
}

// Refraction, in degrees, of a ray from space through the atmosphere, whose lowest point is that high over the ground.
fn dkRefractionThroughAtmosphere(lowestHeightM: f32, temperatureC: f32) -> f32 {
    return 2.0 * dkBennett(0.0) * dkAirPressureRatio(max(lowestHeightM, 0.0)) * dkTemperatureScale(temperatureC);
}

// Bends a ray by `delta` radians towards `down`, a unit vector perpendicular to it: a rotation by at most 1.2 degrees,
// its sine and cosine as polynomials. WGSL promises sin and cos only to 2^-11, fifty times the sun disc test's margin.
fn dkBendRay(direction: vec3f, down: vec3f, delta: f32) -> vec3f {
    return normalize(direction * (1.0 - 0.5 * delta * delta) + down * (delta - delta * delta * delta / 6.0));
}

// Warps an apparent (camera) view direction to the true direction to sample the sky at. `z` is local up.
// Lowering every ray by its own refraction yields, from this one function: bodies staying visible while
// geometrically below the horizon, the sky compressing slightly near the horizon, and the vertical flattening
// of the sun and moon there, which follows from the steep dR/da rather than special-casing the disc.
fn dkRefractViewDirection(direction: vec3f, observerHeightM: f32, temperatureC: f32) -> vec3f {
    let horizontal = length(direction.xy);
    if (horizontal < 1e-9) {
        return vec3f(direction.xy, select(1.0, sign(direction.z), direction.z != 0.0));
    }

    let delta = dkRefractionAlongRay(direction.z, horizontal, observerHeightM, temperatureC) * DK_DEG_TO_RAD;

    // Lowered by delta within its vertical plane.
    return dkBendRay(direction, vec3f(direction.z * direction.xy / horizontal, -horizontal), delta);
}
