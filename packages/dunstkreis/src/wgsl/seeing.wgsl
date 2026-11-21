// The air's turbulence on a point of light: how a star, a planet or a satellite flickers, per channel. Requires
// `air.wgsl`, whose table holds the turbulence along each ray. Binding-free: the seeing comes in by value, filled by
// `seeingUniformData`.

// The seeing's wavelength in meters, green, and the wave number there.
const DK_SEEING_WAVELENGTH: f32 = 550e-9;
const DK_SEEING_WAVE_NUMBER: f32 = 1.1424e7;

struct DkSeeing {
    // How far the image moves straight up from sea level: the standard deviation along each axis, in radians.
    tilt: f32,
    // How much a star flickers there, to a small lens and unaveraged: its light's variance over its mean's square.
    variance: f32,
    // The lens' width in meters, how long the light is gathered in seconds, and the wind up high in m/s.
    aperture: f32,
    exposure: f32,
    wind: f32,
    // The observer's own speed across the line of sight in m/s: 7700 in orbit.
    speed: f32,
    reserved0: f32,
    reserved1: f32,
}

// How fast the turbulence crosses a ray in m/s, for its wind as a share of the seeing's: the wind and the observer's
// own speed, at right angles on average.
fn dkSeeingSpeed(seeing: DkSeeing, wind: f32) -> f32 {
    return max(length(vec2f(seeing.wind * wind, seeing.speed)), 1e-6);
}

fn dkHash(x: u32) -> u32 {
    var h = x * 747796405u + 2891336453u;
    h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
    return (h >> 22u) ^ h;
}

fn dkHashUniform(seed: u32) -> f32 {
    return (f32(dkHash(seed) & 0xffffffu) + 0.5) / 16777216.0;
}

// A standard normal variate from a seed, by Box and Muller.
fn dkHashNormal(seed: u32) -> f32 {
    let u = dkHashUniform(seed);
    let v = dkHashUniform(seed ^ 0x9e3779b9u);
    return sqrt(-2.0 * log(max(u, 1e-7))) * cos(6.2831853 * v);
}

// A standard normal variate that drifts smoothly with the time: between two drawn at the whole steps of `t`, their
// mix scaled back to a variance of 1.
fn dkHashNoise(seed: u32, t: f32) -> f32 {
    let k = u32(floor(t));
    let f = fract(t);
    let s = f * f * (3.0 - 2.0 * f);
    let mixed = mix(dkHashNormal(seed + k * 7919u), dkHashNormal(seed + (k + 1u) * 7919u), s);
    return mixed / sqrt(s * s + (1.0 - s) * (1.0 - s));
}

// A point's flicker through the turbulence along a ray, `DkAir.scintillation`: its light's variance over its mean's
// square as the lens and the exposure leave it (x), and how long the flicker stays alike, in seconds (y). Unaveraged
// it grows with the turbulence and saturates at 1. A lens wider than the pattern the flicker casts, the Fresnel scale
// sqrt(wavelength distance), averages over it, by Andrews and Phillips' aperture averaging factor; an exposure of many
// times the pattern's crossing time over those, which leaves the variance of an exponentially correlated signal's
// mean. The twin of `scintillation` in seeing.ts.
fn dkScintillationOf(seeing: DkSeeing, turbulence: vec3f) -> vec2f {
    let distance = max(turbulence.y, 1.0);
    let instant = min(seeing.variance * max(turbulence.x, 0.0), 1.0);
    let fresnel = DK_SEEING_WAVE_NUMBER * seeing.aperture * seeing.aperture / (4.0 * distance);
    let lens = pow(1.0 + 1.062 * fresnel, -7.0 / 6.0);
    let time = max(sqrt(DK_SEEING_WAVELENGTH * distance), seeing.aperture) / dkSeeingSpeed(seeing, turbulence.z);
    let x = max(seeing.exposure / time, 1e-3);
    return vec2f(instant * lens * 2.0 * (x - 1.0 + exp(-x)) / (x * x), time);
}

// What a point's light is multiplied by right now, per channel, its mean 1: lognormal, with the variance of
// dkScintillationOf, drawn anew about once an exposure, or as often as the flicker changes where that is slower.
// `seed` tells the points apart, a star's index; `time` is the clock in seconds. The air's dispersion parts the colors'
// paths, by a hundredth of the bend and the dilution at the turbulence's distance: once they lie a Fresnel scale apart
// the channels flicker each on its own, the flashes of color a low Sirius throws.
fn dkScintillation(seeing: DkSeeing, air: DkAir, seed: u32, time: f32) -> vec3f {
    let flicker = dkScintillationOf(seeing, air.scintillation);
    if (flicker.x <= 0.0) {
        return vec3f(1.0);
    }
    let sigma = sqrt(log(1.0 + flicker.x));
    let distance = max(air.scintillation.y, 1.0);
    let spread = (DK_AIR_DISPERSION.b - DK_AIR_DISPERSION.r) * air.bend * air.dilution;
    let apart = spread * sqrt(distance / DK_SEEING_WAVELENGTH);
    let chroma = 1.0 - exp(-apart * apart);
    let t = time / max(seeing.exposure, flicker.y);
    let hashed = seed * 2654435761u;
    let whole = dkHashNoise(hashed, t);
    var factor = vec3f(0.0);
    for (var c = 0u; c < 3u; c = c + 1u) {
        let own = dkHashNoise(hashed + (c + 1u) * 104729u, t);
        let n = sqrt(1.0 - chroma) * whole + sqrt(chroma) * own;
        factor[c] = exp(sigma * n - 0.5 * sigma * sigma);
    }
    return factor;
}
