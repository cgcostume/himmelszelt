// Geometry, density profiles and phase functions, shared by both variants. Requires `atmosphere.wgsl` for the
// DkAtmosphere struct, which every function takes by value rather than reading from a binding, so that this
// composes into an existing pipeline without dictating group or binding indices.
//
// Everything is in kilometers and measured from the planet's centre, so `r` is a radius, not an altitude, and
// `mu` is the cosine of the angle between a direction and local up.

const DK_PI: f32 = 3.141592653589793;

// Distance from a point at radius r to the top of the atmosphere along a ray with cosine mu, assuming the
// point is inside the atmosphere. The discriminant cannot go negative there, but is clamped anyway: the
// caller is often a fullscreen pass evaluating directions that never made physical sense.
fn dkDistanceToTopAtmosphereBoundary(a: DkAtmosphere, r: f32, mu: f32) -> f32 {
    let discriminant = r * r * (mu * mu - 1.0) + a.Rt * a.Rt;
    return max(-r * mu + sqrt(max(discriminant, 0.0)), 0.0);
}

// The functions near the ground take the altitude h instead of the radius: a radius around 6360 km resolves only
// ~0.5 m in f32, which put a floor under the observer and banded the horizon. With h exact, a millimeter works.

// r^2 - Rg^2, the squared distance to the horizon, from the altitude, where the difference of squares cancels.
fn dkRhoSquared(a: DkAtmosphere, h: f32) -> f32 {
    return max(h, 0.0) * (2.0 * a.Rg + max(h, 0.0));
}

// Distance from altitude h to the ground along a ray with cosine mu. A negative discriminant means the ray misses the
// planet, the common case for anything above the horizon, so callers check dkIntersectsGround first. In the
// conjugate form, which stays exact for the short grazing distances the textbook form cancels to zero.
fn dkDistanceToBottomAtmosphereBoundary(a: DkAtmosphere, h: f32, mu: f32) -> f32 {
    let r = a.Rg + h;
    let discriminant = r * r * mu * mu - dkRhoSquared(a, h);
    return dkRhoSquared(a, h) / max(-r * mu + sqrt(max(discriminant, 0.0)), 1e-12);
}

fn dkIntersectsGround(a: DkAtmosphere, h: f32, mu: f32) -> bool {
    let r = a.Rg + h;
    return mu < 0.0 && r * r * mu * mu >= dkRhoSquared(a, h);
}

// Altitude of the point at distance t along a ray from altitude h with cosine mu, without going through its radius:
// (r_t^2 - Rg^2) / (r_t + Rg), the numerator expanded so the large terms never meet.
fn dkAltitudeAlongRay(a: DkAtmosphere, h: f32, mu: f32, t: f32) -> f32 {
    let r = a.Rg + h;
    let rt = sqrt(max(t * t + 2.0 * r * mu * t + r * r, 0.0));
    return max((t * t + 2.0 * r * mu * t + dkRhoSquared(a, h)) / (rt + a.Rg), 0.0);
}

// Distance from a point at radius r to the horizon, i.e. sqrt(r^2 - Rg^2).
//
// Factored as (r - Rg)(r + Rg) rather than the textbook difference of squares. At f32, Rg^2 is far past the
// 24-bit mantissa, so the textbook form subtracts two nearly equal rounded numbers and the sqrt amplifies
// what is left: near the ground it returns garbage on the order of 1e-4 instead of 0, exactly where the
// sky's gradient is steepest and the LUT mappings spend their resolution. Factoring keeps the small quantity
// (the altitude) exact. Every radius-difference in this package is written this way for the same reason.
fn dkRho(a: DkAtmosphere, r: f32) -> f32 {
    return sqrt(max(r - a.Rg, 0.0) * (r + a.Rg));
}

// Distance from the ground to the top of the atmosphere along a horizontal ray, sqrt(Rt^2 - Rg^2). The
// furthest any ray can travel through the shell, and the normalizing constant of the LUT mappings.
fn dkHorizonDistanceAtTop(a: DkAtmosphere) -> f32 {
    return sqrt(max(a.Rt - a.Rg, 0.0) * (a.Rt + a.Rg));
}

// Cosine of the horizon direction as seen from altitude h. Everything below this looks at ground rather than
// sky, and the sky's gradient is steepest right at it, which is why the LUT mappings bias resolution here.
fn dkHorizonMu(a: DkAtmosphere, h: f32) -> f32 {
    return -sqrt(dkRhoSquared(a, h)) / (a.Rg + h);
}

// Air and aerosols both thin out exponentially, with very different scale heights.
fn dkDensityRayleigh(a: DkAtmosphere, altitudeKm: f32) -> f32 { return exp(-max(altitudeKm, 0.0) / a.HR); }
fn dkDensityMie(a: DkAtmosphere, altitudeKm: f32) -> f32 { return exp(-max(altitudeKm, 0.0) / a.HM); }

// Ozone does not: it is produced by UV in the stratosphere rather than settling out of the air, so it forms a
// layer peaking around 25 km. A linear tent is the standard cheap stand-in for its actual profile.
fn dkDensityOzone(a: DkAtmosphere, altitudeKm: f32) -> f32 {
    return max(0.0, 1.0 - abs(altitudeKm - a.ozoneCenter) / a.ozoneHalfWidth);
}

// Total extinction at an altitude: everything that removes light from a beam. Rayleigh scattering doubles as
// its own extinction (air molecules do not absorb visible light), Mie has a separate extinction coefficient,
// and ozone contributes absorption only.
fn dkExtinction(a: DkAtmosphere, altitudeKm: f32) -> vec3f {
    return a.betaR * dkDensityRayleigh(a, altitudeKm)
         + a.betaMEx * dkDensityMie(a, altitudeKm)
         + a.betaOAbs * dkDensityOzone(a, altitudeKm);
}

// Rayleigh phase function: gentle, symmetric, slightly favouring forward and backward over sideways.
fn dkPhaseRayleigh(nu: f32) -> f32 {
    return 3.0 / (16.0 * DK_PI) * (1.0 + nu * nu);
}

// Mie phase function, Cornette-Shanks rather than plain Henyey-Greenstein, matching the original's
// phaseFunctionM. Strongly forward-biased, which is what puts the bright glow around the sun.
fn dkPhaseMie(a: DkAtmosphere, nu: f32) -> f32 {
    let g2 = a.mieG * a.mieG;
    return 1.5 / (4.0 * DK_PI) * (1.0 - g2) * pow(1.0 + g2 - 2.0 * a.mieG * nu, -1.5)
         * (1.0 + nu * nu) / (2.0 + g2);
}

// Recovers the Mie inscatter from the packed RGB-plus-Mie-red representation Bruneton stores, exploiting that
// Mie scattering is very nearly wavelength-independent. The original's getMie.
fn dkGetMie(a: DkAtmosphere, rayMie: vec4f) -> vec3f {
    return rayMie.rgb * rayMie.w / max(rayMie.r, 1e-4) * (a.betaR.r / a.betaR);
}
