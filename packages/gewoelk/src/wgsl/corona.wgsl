// A corona: the glow and the colored rings a thin cloud lays around the Sun or the Moon. Its droplets diffract light as
// small discs do, into a lobe a degree or two wide, as wide as the wavelength is to the droplet: bluish white inside,
// red at the rim, and rings beyond it where the droplets are all of one size. Half of what a droplet takes out of a beam
// goes this way, so nearly straight on that a cloud renderer, this one too, counts it as light passed through: its
// optical depth is of the other half alone. Here that half is spread around the source again. Binding-free.

// Bessel's J1 for x of 0 or more, after Abramowitz and Stegun 9.4.4 and 9.4.6: to a ten-millionth.
fn gwBesselJ1(x: f32) -> f32 {
    if (x <= 3.0) {
        let t = x * x / 9.0;
        return x * (0.5 + t * (-0.56249985 + t * (0.21093573 + t * (-0.03954289 + t * (0.00443319 + t * (-0.00031761 + t * 0.00001109))))));
    }
    let t = 3.0 / x;
    let amplitude = 0.79788456 + t * (0.00000156 + t * (0.01659667 + t * (0.00017105 + t * (-0.00249511 + t * (0.00113653 - t * 0.00020033)))));
    let phase = x - 2.35619449 + t * (0.12499612 + t * (0.0000565 + t * (-0.00637879 + t * (0.00074348 + t * (0.00079824 - t * 0.00029166)))));
    return amplitude * cos(phase) / sqrt(x);
}

// The lobe droplets of `radius` micrometers diffract light of `wavelength` micrometers into, per steradian and 1 over
// the sphere, at `angle` degrees from the source: Airy's pattern of a disc as wide as the droplet. `spread` is how far
// the droplets' sizes vary, their standard deviation as a share of the radius: every size draws its rings elsewhere, so
// they fade into their mean with the angle, the sooner the larger the spread, and the glow inside the first stays, a
// little brighter for the larger droplets among them. Fitted to the mean over the sizes: the light within 1 %, the
// lobe within an eighth out to its fifth ring, for a spread up to 0.3.
fn gwDiffractionLobe(angle: f32, radius: f32, spread: f32, wavelength: f32) -> f32 {
    let size = 6.283185307179586 * radius / wavelength;
    let u = size * angle * 0.017453292519943295;
    var airy = 1.0;
    if (u > 1e-3) {
        let amplitude = 2.0 * gwBesselJ1(u) / u;
        airy = amplitude * amplitude;
    }
    let mean = 4.0 / (3.141592653589793 * (u * u * u + 4.0));
    let rings = exp(-2.0 * spread * spread * u * u);
    return size * size / 12.566370614359172 * mix(mean, airy * (1.0 + 3.0 * spread * spread), rings);
}

// The lobe for red, green and blue, at 610, 550 and 465 nm, fading out where green has passed its tenth ring: far below
// the cloud's own forward lobe by then.
fn gwCoronaLobe(angle: f32, radius: f32, spread: f32) -> vec3f {
    let reach = 32.0 * 0.55 / (6.283185307179586 * radius) * 57.29577951308232;
    if (angle >= reach) {
        return vec3f(0.0);
    }
    let lobe = vec3f(
        gwDiffractionLobe(angle, radius, spread, 0.61),
        gwDiffractionLobe(angle, radius, spread, 0.55),
        gwDiffractionLobe(angle, radius, spread, 0.465),
    );
    return lobe * (1.0 - smoothstep(0.6 * reach, reach, angle));
}

// How much of a source's light comes through cloud of `transmittance` diffracted once and not scattered otherwise: the
// renderer's optical depth is half the droplets' whole, so of its depth tau that is tau exp(-2 tau). None through
// clear air, none through thick cloud, most, 18 %, where the cloud lets three fifths through.
fn gwCoronaShare(transmittance: f32) -> f32 {
    let through = clamp(transmittance, 1e-6, 1.0);
    return log(1.0 / through) * through * through;
}

// The corona of a source at `sourceDirection` whose illuminance at the observer under a clear sky is `illuminance`, lux
// per channel, over a pixel looking along `direction`, both unit vectors, through cloud of `transmittance`: in cd/m², to
// add to the pixel's light before it is exposed.
fn gwCorona(direction: vec3f, sourceDirection: vec3f, illuminance: vec3f, transmittance: f32, radius: f32, spread: f32) -> vec3f {
    let angle = 2.0 * asin(min(length(direction - sourceDirection) * 0.5, 1.0)) * 57.29577951308232;
    return illuminance * gwCoronaLobe(angle, radius, spread) * gwCoronaShare(transmittance);
}
