// Shared by the star passes: where a catalog star stands in the sky and on the target, what the air does to its light,
// and how it twinkles. Requires `params.wgsl` and `camera.wgsl` (dunstkreis'), and the bindings `shParams` and
// `shCatalog` from the pass.

// A catalog star's J2000 equatorial vector moved by its proper motion, then turned into the observer's frame: ENU.
fn shStarDirection(i: u32) -> vec3f {
    let at = i * SH_STAR_FIELDS;
    let declination = radians(shCatalog[at + 2u] + shCatalog[at + 4u] * shParams.years / 3600.0);
    let cosDeclination = cos(radians(shCatalog[at + 2u]));
    let rightAscension = radians(shCatalog[at + 1u] + shCatalog[at + 3u] * shParams.years / 3600.0 / max(cosDeclination, 1e-6));
    let equatorial = vec3f(cos(declination) * cos(rightAscension), cos(declination) * sin(rightAscension), sin(declination));
    return normalize(shParams.skyRotation * equatorial);
}

fn shStarMagnitude(i: u32) -> f32 {
    return shCatalog[i * SH_STAR_FIELDS];
}

fn shStarColor(i: u32) -> vec3f {
    let at = i * SH_STAR_FIELDS;
    return max(vec3f(shCatalog[at + 5u], shCatalog[at + 6u], shCatalog[at + 7u]), vec3f(0.0));
}

// The illuminance at the eye of a star of apparent magnitude `magnitude`, in lux, above the air.
fn shIlluminance(magnitude: f32) -> f32 {
    return SH_MAGNITUDE_ZERO_LUX * pow(10.0, -0.4 * magnitude);
}

// Where a ray seen at `altitude` radians falls in the air table: the entry below it and the share of the next.
fn shAirAt(altitude: f32) -> vec2f {
    let horizon = shParams.airHorizon;
    let t = sqrt(max(altitude - horizon, 0.0) / max(0.5 * SH_PI - horizon, 1e-6));
    let x = min(t * f32(SH_AIR_SAMPLES - 1u), f32(SH_AIR_SAMPLES - 1u));
    let i = min(floor(x), f32(SH_AIR_SAMPLES - 2u));
    return vec2f(i, x - i);
}

// How far the air bends a ray seen at `altitude` radians down, in radians.
fn shBend(altitude: f32) -> f32 {
    let at = shAirAt(altitude);
    let i = u32(at.x);
    let a = shParams.airBends[i / 4u][i % 4u];
    let b = shParams.airBends[(i + 1u) / 4u][(i + 1u) % 4u];
    return mix(a, b, at.y);
}

// What the air lets through along a ray seen at `altitude` radians, per channel.
fn shTransmittance(altitude: f32) -> vec3f {
    let at = shAirAt(altitude);
    let i = u32(at.x);
    return mix(shParams.airTransmittance[i].rgb, shParams.airTransmittance[i + 1u].rgb, at.y);
}

fn shAltitude(direction: vec3f) -> f32 {
    return atan2(direction.z, max(length(direction.xy), 1e-9));
}

// Where a star in the true `direction` shows, lifted by the air: the apparent altitude from iterating
// `apparent = true + bend(apparent)`, which converges fast, the bend changing slowly with the altitude.
fn shLift(direction: vec3f) -> vec3f {
    let horizontal = length(direction.xy);
    if (horizontal < 1e-6) {
        return direction;
    }
    let trueAltitude = atan2(direction.z, horizontal);
    var apparent = trueAltitude;
    for (var k = 0u; k < 6u; k = k + 1u) {
        apparent = trueAltitude + shBend(apparent);
    }
    return vec3f(direction.xy / horizontal * cos(apparent), sin(apparent));
}

// The ray as it left the atmosphere: turned down by the bend the air gave it, for looking the Milky Way up.
fn shUnbend(view: vec3f) -> vec3f {
    let horizontal = length(view.xy);
    if (horizontal < 1e-6) {
        return view;
    }
    let apparent = atan2(view.z, horizontal);
    let altitude = apparent - shBend(apparent);
    return vec3f(view.xy / horizontal * cos(altitude), sin(altitude));
}

// The ray through a point of the target, in pixels from its top left corner, on dunstkreis' camera.
fn shPixelRay(position: vec2f) -> vec3f {
    let uv = position / vec2f(f32(shParams.width), f32(shParams.height));
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    return dkProjectRay(shParams.inverseViewProjection, ndc, clamp(shParams.projectionDistance, 0.0, 1.0));
}

// A point of the image plane, by clip-space coordinates, from the eye: the plane halfway into the depth range.
fn shPlanePoint(ndc: vec2f) -> vec3f {
    let p = shParams.inverseViewProjection;
    let eye = p[2].xyz / p[2].w;
    let point = p * vec4f(ndc, 0.5, 1.0);
    return point.xyz / point.w - eye;
}

// Where a direction shows on the target, in pixels, and how far along the camera's axis it lies: behind the camera
// for a value of 0 or less. The inverse of `dkProjectRay`: the angle from the axis to the image plane's radius.
fn shProject(direction: vec3f) -> vec3f {
    let center = shPlanePoint(vec2f(0.0));
    let right = shPlanePoint(vec2f(1.0, 0.0)) - center;
    let up = shPlanePoint(vec2f(0.0, 1.0)) - center;
    let forward = normalize(center);
    let along = dot(direction, forward);
    let d = clamp(shParams.projectionDistance, 0.0, 1.0);
    // Behind the camera: past 90° from the axis for a rectilinear view, past where the bent projection runs out.
    if (d + along <= 1e-6) {
        return vec3f(0.0, 0.0, -1.0);
    }
    let offset = direction - forward * along;
    let sinTheta = length(offset);
    let rho = (d + 1.0) * sinTheta / (d + along);
    var point = center;
    if (sinTheta > 1e-9) {
        point = center + offset / sinTheta * (rho * length(center));
    }
    let a = dot(point - center, right) / dot(right, right);
    let b = dot(point - center, up) / dot(up, up);
    return vec3f((a + 1.0) * 0.5 * f32(shParams.width), (1.0 - b) * 0.5 * f32(shParams.height), along);
}

// How many pixels a radian of sky spans at a direction: the image of a direction turned a little.
fn shPixelsPerRadian(direction: vec3f, pixel: vec2f) -> f32 {
    let center = normalize(shPlanePoint(vec2f(0.0)));
    var across = cross(direction, center);
    if (length(across) < 1e-4) {
        across = cross(direction, vec3f(0.0, 0.0, 1.0));
    }
    if (length(across) < 1e-4) {
        across = cross(direction, vec3f(1.0, 0.0, 0.0));
    }
    let turned = normalize(direction + normalize(across) * 1e-3);
    return length(shProject(turned).xy - pixel) / 1e-3;
}

fn shHash(x: u32) -> u32 {
    var h = x * 747796405u + 2891336453u;
    h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
    return (h >> 22u) ^ h;
}

fn shUniform(seed: u32) -> f32 {
    return (f32(shHash(seed) & 0xffffffu) + 0.5) / 16777216.0;
}

// A standard normal variate from two seeds, by Box and Muller.
fn shNormal(seed: u32) -> f32 {
    let u = shUniform(seed);
    let v = shUniform(seed ^ 0x9e3779b9u);
    return sqrt(-2.0 * log(max(u, 1e-7))) * cos(2.0 * SH_PI * v);
}

// A normal variate that drifts smoothly with the time: between two drawn at the whole steps of `t`.
fn shNoise(seed: u32, t: f32) -> f32 {
    let k = u32(floor(t));
    let f = fract(t);
    let s = f * f * (3.0 - 2.0 * f);
    return mix(shNormal(seed + k * 7919u), shNormal(seed + (k + 1u) * 7919u), s);
}

// How a star's light flickers right now, per channel: the air's turbulence makes it fluctuate by a standard deviation
// of its logarithm that grows with the airmass to the power 1.75, Young's scaling as Dravins et al. give it, for the
// pupil and the eye's tenth of a second, saturating towards the horizon, and the channels drift apart as the air's
// dispersion separates the star's colors near the horizon, into the flashes of color a low Sirius throws.
fn shTwinkle(i: u32, apparentAltitude: f32) -> vec3f {
    if (shParams.scintillation <= 0.0) {
        return vec3f(1.0);
    }
    let airmass = 1.0 / max(sin(apparentAltitude), 0.05);
    let index = min(0.09 * pow(shParams.pupilCm, -2.0 / 3.0) * pow(airmass, 1.75) * exp(-shParams.heightM / 8000.0) / sqrt(0.4), 0.6);
    let sigma = index * shParams.scintillation;
    let chroma = clamp((airmass - 1.0) / 3.0, 0.0, 1.0);
    let t = shParams.time * 8.0;
    let seed = i * 2654435761u;
    let whole = shNoise(seed, t);
    var factor = vec3f(0.0);
    for (var c = 0u; c < 3u; c = c + 1u) {
        let own = shNoise(seed + (c + 1u) * 104729u, t);
        let n = mix(whole, own, chroma);
        factor[c] = exp(sigma * n - 0.5 * sigma * sigma);
    }
    return factor;
}
