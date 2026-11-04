// The Moon's surface, binding-free: where a point of the disc is on the Moon, how it reflects sunlight, and what
// Earth's shadow leaves of that light. Requires `params.wgsl`.

const NB_PI: f32 = 3.141592653589793;

// A point on the unit sphere in the Moon's own frame as selenographic longitude, east positive, and latitude, radians.
fn nbSelenographic(body: vec3f) -> vec2f {
    return vec2f(atan2(body.y, body.x), asin(clamp(body.z, -1.0, 1.0)));
}

// Where that longitude and latitude are in an equirectangular map centered on 0° longitude, east to the right and
// north up, as NASA's CGI Moon Kit lays the Moon out.
fn nbMapUv(lonLat: vec2f) -> vec2f {
    return vec2f(lonLat.x / (2.0 * NB_PI) + 0.5, 0.5 - lonLat.y / NB_PI);
}

// A normal, east, north and up in the surface's own tangent frame, turned into the Moon's frame at `lonLat`.
fn nbBodyNormal(lonLat: vec2f, tangent: vec3f) -> vec3f {
    let sinLon = sin(lonLat.x);
    let cosLon = cos(lonLat.x);
    let sinLat = sin(lonLat.y);
    let cosLat = cos(lonLat.y);
    let east = vec3f(-sinLon, cosLon, 0.0);
    let north = vec3f(-sinLat * cosLon, -sinLat * sinLon, cosLat);
    let up = vec3f(cosLat * cosLon, cosLat * sinLon, sinLat);
    return normalize(tangent.x * east + tangent.y * north + tangent.z * up);
}

fn nbSrgbToLinear(c: vec3f) -> vec3f {
    let low = c / 12.92;
    let high = pow((c + 0.055) / 1.055, vec3f(2.4));
    return select(high, low, c <= vec3f(0.04045));
}

// The opposition surge, Hapke's retrodirective function B(g, h) with the lunar h of 0.6, as Jensen et al. 2001 use
// it: 2 at opposition, 1 from 90° on. The phase angle g in radians.
fn nbRetrodirective(g: f32) -> f32 {
    const h = 0.6;
    if (g < 1e-4) {
        return 2.0;
    }
    if (g >= NB_PI / 2.0) {
        return 1.0;
    }
    let t = tan(g);
    let e = exp(-h / t);
    return 2.0 - t / (2.0 * h) * (1.0 - e) * (3.0 - e);
}

// Hapke's single particle scattering, S(g): a Lambert sphere's phase function and a little forward scattering, which
// lets a crescent keep a thin rim towards the Sun.
fn nbScattering(g: f32) -> f32 {
    const t = 0.1;
    let c = cos(g);
    return (sin(g) + (NB_PI - g) * c) / NB_PI + t * (1.0 - c * 0.5) * (1.0 - c * 0.5);
}

// Hapke's lunar law as Jensen et al. 2001 give it, as a reflectance: luminance over the illuminance arriving along the
// light's direction, for normal albedo 1. Lommel-Seeliger's mu0 / (mu0 + mu), a surface of particles lit and seen
// through the same layer, with the phase angle's two factors, scaled so a point seen straight on at opposition
// reflects like a Lambert surface of that albedo: 1 / pi. The full Moon is as bright at its edge as in its middle.
fn nbHapke(mu0: f32, mu: f32, g: f32) -> f32 {
    let phase = nbRetrodirective(g) * nbScattering(g) / (2.0 * nbScattering(0.0));
    return 2.0 * mu0 / max(mu0 + mu, 1e-4) * phase / NB_PI;
}

// A Lambert surface, the law a renderer reaches for first, and the wrong one: the Moon's limb would darken.
fn nbLambert(mu0: f32) -> f32 {
    return mu0 / NB_PI;
}

fn nbReflectance(law: u32, mu0: f32, mu: f32, g: f32) -> f32 {
    if (mu0 <= 0.0) {
        return 0.0;
    }
    if (law == 1u) {
        return nbLambert(mu0);
    }
    return nbHapke(mu0, max(mu, 0.0), g);
}

// The area two discs of radii a and b share, their centers d apart.
fn nbLens(a: f32, b: f32, d: f32) -> f32 {
    if (d >= a + b) {
        return 0.0;
    }
    let small = min(a, b);
    if (d <= abs(a - b)) {
        return NB_PI * small * small;
    }
    let x = (d * d + a * a - b * b) / (2.0 * d);
    let y = sqrt(max(a * a - x * x, 0.0));
    return a * a * acos(clamp(x / a, -1.0, 1.0)) + b * b * acos(clamp((d - x) / b, -1.0, 1.0)) - d * y;
}

// What of the sunlight reaches a point of the Moon through Earth's shadow, per channel: the share of the Sun's disc
// Earth leaves uncovered, seen from that point, plus the sunlight Earth's atmosphere bends into the umbra, red in the
// middle, with the turquoise rim ozone leaves where the light passed the stratosphere. `pointKm` from Earth's center.
fn nbShadow(params: NbParams, pointKm: vec3f) -> vec3f {
    let distanceKm = length(pointKm);
    let toEarth = -pointKm / distanceKm;
    // The Sun's and Earth's discs as that point sees them, and the angle between their centers.
    let earthRadius = asin(min(params.earthRadiusKm / distanceKm, 1.0));
    let sunRadius = params.sunAngularRadius;
    let separation = acos(clamp(dot(toEarth, -params.shadowAxis), -1.0, 1.0));
    let covered = nbLens(earthRadius, sunRadius, separation) / (NB_PI * sunRadius * sunRadius);
    let direct = vec3f(1.0 - covered);
    // How far into the umbra, 0 at its axis and 1 at its edge, from the point's distance from the shadow's axis.
    let axisKm = length(pointKm - dot(pointKm, params.shadowAxis) * params.shadowAxis);
    let depth = axisKm / max(params.umbraKm, 1.0);
    if (depth > 1.5) {
        return direct;
    }
    // The umbra's light: some 10^-5 of the sunlight at its axis, thirty times that at its edge, fading out beyond.
    let amount = 1e-5 * pow(10.0, 1.5 * min(depth, 1.0) * min(depth, 1.0)) * (1.0 - smoothstep(1.0, 1.5, depth));
    let copper = vec3f(1.0, 0.32, 0.1);
    let rim = vec3f(0.55, 0.8, 1.0);
    let refracted = mix(copper, rim, smoothstep(0.8, 1.05, depth)) * amount * params.umbraLight;
    return direct + refracted;
}
