// Geometry, density profiles and phase functions. Requires `atmosphere.wgsl` for the
// DkAtmosphere struct, which every function takes by value rather than reading from a binding, so that this
// composes into an existing pipeline without dictating group or binding indices.
//
// Everything is in kilometers and measured from the planet's centre, so `r` is a radius, not an altitude, and
// `mu` is the cosine of the angle between a direction and local up.

const DK_PI: f32 = 3.141592653589793;

// Whether rays bend in the air. Off, they run straight and the model's refractivity is taken as 0, whatever it holds:
// the cheaper march, for a model without refraction. On by default, which is right for either.
override DK_REFRACTION: bool = true;

// The model's refractivity on the ground, or 0 with DK_REFRACTION off.
fn dkGroundRefractivity(a: DkAtmosphere) -> f32 {
    return select(0.0, a.refractivity, DK_REFRACTION);
}

// The functions near the ground take the altitude h instead of the radius: a radius around 6360 km resolves only
// ~0.5 m in f32, which put a floor under the observer, banded the horizon and jittered the sun's cutoff at it. With h
// exact, a millimeter works.

// Distance from altitude h to the top of the atmosphere along a ray with cosine mu, from inside it. Rt^2 - r^2 factored
// from the altitude, as for dkRhoSquared. Clamped anyway: the caller is often a pass evaluating directions that never
// made physical sense.
fn dkDistanceToTopAtmosphereBoundary(a: DkAtmosphere, h: f32, mu: f32) -> f32 {
    let r = a.Rg + h;
    let discriminant = r * r * mu * mu + (a.Rt - a.Rg - h) * (a.Rt + r);
    return max(-r * mu + sqrt(max(discriminant, 0.0)), 0.0);
}

// r^2 - Rg^2, the squared distance to the horizon, from the altitude, where the difference of squares cancels.
fn dkRhoSquared(a: DkAtmosphere, h: f32) -> f32 {
    return max(h, 0.0) * (2.0 * a.Rg + max(h, 0.0));
}

// Distance from altitude h to the ground along a straight ray with cosine mu. A negative discriminant means the ray
// misses the planet, so callers check dkLineIntersectsGround first. In the conjugate form, which stays exact for the
// short grazing distances the textbook form cancels to zero.
fn dkDistanceToBottomAtmosphereBoundary(a: DkAtmosphere, h: f32, mu: f32) -> f32 {
    let r = a.Rg + h;
    let discriminant = r * r * mu * mu - dkRhoSquared(a, h);
    return dkRhoSquared(a, h) / max(-r * mu + sqrt(max(discriminant, 0.0)), 1e-12);
}

fn dkLineIntersectsGround(a: DkAtmosphere, h: f32, mu: f32) -> bool {
    let r = a.Rg + h;
    return mu < 0.0 && r * r * mu * mu >= dkRhoSquared(a, h);
}

// Air's refractivity n - 1 at an altitude, proportional to its density, which the Rayleigh layer describes.
fn dkRefractivity(a: DkAtmosphere, altitudeKm: f32) -> f32 {
    return dkGroundRefractivity(a) * dkDensityRayleigh(a, altitudeKm);
}

// Along a ray bent by the air, n r sin(z) stays constant (Bouguer's invariant, from the spherical symmetry). A ray from
// altitude h reaches the ground if that constant is below its value there, n0 Rg. This is (n r)^2 - (n0 Rg)^2, the
// refracting twin of dkRhoSquared and equal to it without refraction, from the altitude, where the large terms never
// meet.
fn dkHorizonSquared(a: DkAtmosphere, h: f32) -> f32 {
    let x = max(h, 0.0) / a.HR;
    // exp(-x) - 1, by its series where exp would lose it.
    let decay = select(exp(-x) - 1.0, x * (x * (0.5 - x / 6.0) - 1.0), x < 1e-3);
    let k = dkGroundRefractivity(a);
    let n = 1.0 + k * (1.0 + decay);
    let difference = max(h, 0.0) * n + a.Rg * k * decay;
    return max(difference, 0.0) * (n * (a.Rg + h) + (1.0 + k) * a.Rg);
}

// Whether a ray from altitude h with cosine mu, bent by the air, ends on the ground.
fn dkIntersectsGround(a: DkAtmosphere, h: f32, mu: f32) -> bool {
    let nr = (1.0 + dkRefractivity(a, h)) * (a.Rg + h);
    return mu < 0.0 && nr * nr * mu * mu >= dkHorizonSquared(a, h);
}

// Distance from the ground to the top of the atmosphere along a horizontal ray, sqrt(Rt^2 - Rg^2). The
// furthest any ray can travel through the shell, and the normalizing constant of the LUT mappings.
fn dkHorizonDistanceAtTop(a: DkAtmosphere) -> f32 {
    return sqrt(max(a.Rt - a.Rg, 0.0) * (a.Rt + a.Rg));
}

// Cosine of the visible horizon as seen from altitude h, lifted by the air's bending. Everything below this looks at
// ground rather than sky, and the sky's gradient is steepest right at it, which is why the LUT mappings bias
// resolution here.
fn dkHorizonMu(a: DkAtmosphere, h: f32) -> f32 {
    return -sqrt(dkHorizonSquared(a, h)) / ((1.0 + dkRefractivity(a, h)) * (a.Rg + h));
}

// A ray bent by the air, followed through its vertical plane, which it never leaves: the atmosphere is spherically
// symmetric. x runs along the horizontal it starts in, y up from its start at altitude h0, both in km.
struct DkPath {
    position: vec2f,
    direction: vec2f,
}

fn dkPathStart(mu: f32) -> DkPath {
    return DkPath(vec2f(0.0), vec2f(sqrt(max(1.0 - mu * mu, 0.0)), mu));
}

// Altitude along the path, again without going through the radius.
fn dkPathAltitude(a: DkAtmosphere, h0: f32, p: vec2f) -> f32 {
    let r0 = a.Rg + h0;
    let r = length(vec2f(p.x, r0 + p.y));
    return max((p.x * p.x + p.y * (2.0 * r0 + p.y) + dkRhoSquared(a, h0)) / (r + a.Rg), 0.0);
}

fn dkPathUp(a: DkAtmosphere, h0: f32, p: vec2f) -> vec2f {
    return normalize(vec2f(p.x, a.Rg + h0 + p.y));
}

// How the direction turns per km, the ray equation: towards denser air, by the part of grad(n) / n across the ray.
fn dkPathTurn(a: DkAtmosphere, h0: f32, p: vec2f, direction: vec2f) -> vec2f {
    let refractivity = dkRefractivity(a, dkPathAltitude(a, h0, p));
    let gradient = -refractivity / (a.HR * (1.0 + refractivity)) * dkPathUp(a, h0, p);
    return gradient - dot(gradient, direction) * direction;
}

// One step of ds km by the midpoint rule. The middle is where the integrators sample.
struct DkPathStep {
    middle: DkPath,
    next: DkPath,
}

fn dkPathAdvance(a: DkAtmosphere, h0: f32, path: DkPath, ds: f32) -> DkPathStep {
    var step: DkPathStep;
    if (!DK_REFRACTION) {
        step.middle = DkPath(path.position + path.direction * (0.5 * ds), path.direction);
        step.next = DkPath(path.position + path.direction * ds, path.direction);
        return step;
    }
    let turn = dkPathTurn(a, h0, path.position, path.direction);
    let direction = normalize(path.direction + turn * (0.5 * ds));
    step.middle = DkPath(path.position + direction * (0.5 * ds), direction);
    let middleTurn = dkPathTurn(a, h0, step.middle.position, direction);
    step.next = DkPath(path.position + direction * ds, normalize(path.direction + middleTurn * ds));
    return step;
}

// Distance left to the path's end, on the ground or at the top, along its current tangent. The steps aim at it anew
// each time, so the last one ends there although the path bends. A path bound for the ground whose tangent still
// misses it aims at the tangent's lowest point instead.
fn dkPathRemaining(a: DkAtmosphere, h0: f32, path: DkPath, hitsGround: bool) -> f32 {
    let h = dkPathAltitude(a, h0, path.position);
    let mu = dot(path.direction, dkPathUp(a, h0, path.position));
    let r = a.Rg + h;
    if (!hitsGround) {
        return dkDistanceToTopAtmosphereBoundary(a, h, mu);
    }
    if (dkLineIntersectsGround(a, h, mu)) {
        return dkDistanceToBottomAtmosphereBoundary(a, h, mu);
    }
    return max(-r * mu, 0.0);
}

// A path's 2D vectors in the world, from its start's up and the horizontal it starts in.
fn dkPathToWorld(v: vec2f, up: vec3f, horizontal: vec3f) -> vec3f {
    return v.x * horizontal + v.y * up;
}

// The horizontal a direction starts in at a point with that up; any one for a ray straight up or down.
fn dkPathHorizontal(up: vec3f, direction: vec3f) -> vec3f {
    let horizontal = direction - up * dot(direction, up);
    if (length(horizontal) > 1e-6) {
        return normalize(horizontal);
    }
    return normalize(cross(up, select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(up.x) > 0.9)));
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

// Mie phase function, Cornette-Shanks rather than plain Henyey-Greenstein, as Hillaire's. Strongly forward-biased,
// which is what puts the bright glow around the sun.
fn dkPhaseMie(a: DkAtmosphere, nu: f32) -> f32 {
    let g2 = a.mieG * a.mieG;
    return 1.5 / (4.0 * DK_PI) * (1.0 - g2) * pow(1.0 + g2 - 2.0 * a.mieG * nu, -1.5)
         * (1.0 + nu * nu) / (2.0 + g2);
}
