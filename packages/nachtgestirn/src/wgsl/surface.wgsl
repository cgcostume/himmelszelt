// The Moon's surface, binding-free: where a point of the disc is on the Moon, how it reflects sunlight, and how much of
// one disc another covers, as Earth covers the Sun's. Requires `params.wgsl`.

const NB_PI: f32 = 3.141592653589793;

// A ray's footprint on the Moon's unit sphere, in its own frame: two axes along the surface, in radians, the short one
// across the line of sight and the long one along it, stretched where the surface is seen at a slant.
struct NbFootprint {
    across: vec3f,
    along: vec3f,
}

// A point on the unit sphere in the Moon's own frame as selenographic longitude, east positive, and latitude, radians.
fn nbSelenographic(body: vec3f) -> vec2f {
    return vec2f(atan2(body.y, body.x), asin(clamp(body.z, -1.0, 1.0)));
}

// Where that longitude and latitude are in an equirectangular map centered on 0° longitude, east to the right and
// north up, as NASA's CGI Moon Kit lays the Moon out.
fn nbMapUv(lonLat: vec2f) -> vec2f {
    return vec2f(lonLat.x / (2.0 * NB_PI) + 0.5, 0.5 - lonLat.y / NB_PI);
}

fn nbLinearToSrgb(c: vec3f) -> vec3f {
    let low = c * 12.92;
    let high = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
    return select(high, low, c <= vec3f(0.0031308));
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

// The laws below take the cosines of the angles of incidence and emission, mu0 and mu, and of the phase angle, cosG.

// Hapke's lunar law as Jensen et al. 2001 give it, as a reflectance: luminance over the illuminance arriving along the
// light's direction, for normal albedo 1. Lommel-Seeliger's mu0 / (mu0 + mu), a surface of particles lit and seen
// through the same layer, with the phase angle's two factors, scaled so a point seen straight on at opposition
// reflects like a Lambert surface of that albedo: 1 / pi. The full Moon is as bright at its edge as in its middle.
fn nbHapke(mu0: f32, mu: f32, cosG: f32) -> f32 {
    let g = acos(cosG);
    let phase = nbRetrodirective(g) * nbScattering(g) / (2.0 * nbScattering(0.0));
    return 2.0 * mu0 / max(mu0 + mu, 1e-4) * phase / NB_PI;
}

// A Lambert surface, the law a renderer reaches for first, and the wrong one: the Moon's limb would darken.
fn nbLambert(mu0: f32) -> f32 {
    return mu0 / NB_PI;
}

// Oren and Nayar's rough diffuse surface, the law a renderer reaches for when Lambert's limb looks wrong, with a
// roughness of 0.5 rad: it brightens the limb towards full Moon, but has no surge and lets a half Moon fade into its
// terminator. The azimuth between the light and the viewer about the normal from the three angles alone.
fn nbOrenNayar(mu0: f32, mu: f32, cosG: f32) -> f32 {
    const sigma2 = 0.25;
    let a = 1.0 - 0.5 * sigma2 / (sigma2 + 0.33);
    let b = 0.45 * sigma2 / (sigma2 + 0.09);
    let sin0 = sqrt(max(1.0 - mu0 * mu0, 0.0));
    let sinV = sqrt(max(1.0 - mu * mu, 0.0));
    let cosAzimuth = max((cosG - mu0 * mu) / max(sin0 * sinV, 1e-4), 0.0);
    let alpha = max(sin0, sinV);
    let tanBeta = min(sin0 / max(mu0, 1e-4), sinV / max(mu, 1e-4));
    return mu0 * (a + b * cosAzimuth * alpha * tanBeta) / NB_PI;
}

// Hapke's model as his 2012 book has it, with Sato et al.'s 2014 parameters for the Moon from LRO's wide angle camera,
// the near side's medians at 566 nm: the single scattering albedo w, a two-lobed Henyey-Greenstein phase function
// (b, c), the shadow hiding surge (amplitude BS0, width HS), multiple scattering through Chandrasekhar's H function in
// Hapke's 2002 approximation, and the shadows of a surface rough by a mean slope of 23.657° (Hapke 1984). Coherent
// backscatter and porosity are held off, as in the fit. Everything that depends on the parameters alone is folded into
// constants; a call costs five exp, two log and an acos.
const NB_H12_W = 0.3231;
const NB_H12_B = 0.2366;
const NB_H12_C = 0.3344;
const NB_H12_BS0 = 1.75;
const NB_H12_HS = 0.05309;
const NB_H12_TAN = 0.43807450;
// chi = 1 / sqrt(1 + pi tan^2), and the factors of E1 = exp(-2 / (pi tan) cot y) and E2 = exp(-1 / (pi tan^2) cot^2 y).
const NB_H12_CHI = 0.78985375;
const NB_H12_E1 = 1.45322263;
const NB_H12_E2 = 1.65864783;
// r0 = (1 - gamma) / (1 + gamma), gamma = sqrt(1 - w).
const NB_H12_R0 = 0.09724960;
// One over the radiance factor at normal incidence and emission, so that point reflects like a Lambert surface.
const NB_H12_NORM = 5.35742953;

fn nbH12H(x: f32) -> f32 {
    let y = max(x, 1e-4);
    return 1.0 / (1.0 - NB_H12_W * y * (NB_H12_R0 + (1.0 - 2.0 * NB_H12_R0 * y) * 0.5 * log((1.0 + y) / y)));
}

// E1 and E2 of an angle from its cosine and sine; both 0 straight on.
fn nbH12E(cosY: f32, sinY: f32) -> vec2f {
    if (sinY < 1e-4) {
        return vec2f(0.0);
    }
    let cotY = cosY / sinY;
    return vec2f(exp(-NB_H12_E1 * cotY), exp(-NB_H12_E2 * cotY * cotY));
}

fn nbHapke2012(mu0: f32, mu: f32, cosG: f32) -> f32 {
    if (mu <= 0.0) {
        return 0.0;
    }
    let sinI = sqrt(max(1.0 - mu0 * mu0, 0.0));
    let sinE = sqrt(max(1.0 - mu * mu, 0.0));
    let ei = nbH12E(mu0, sinI);
    let ee = nbH12E(mu, sinE);
    // The azimuth between the planes of incidence and emission, psi, and what the shadows make of it.
    let cosPsi = select(1.0, clamp((cosG - mu0 * mu) / max(sinI * sinE, 1e-6), -1.0, 1.0), sinI * sinE > 1e-6);
    let psi = acos(cosPsi) / NB_PI;
    let half2 = 0.5 - 0.5 * cosPsi;
    let f = exp(-2.0 * sqrt(half2 / max(1.0 - half2, 1e-6)));
    let etaI = NB_H12_CHI * (mu0 + sinI * NB_H12_TAN * ei.y / (2.0 - ei.x));
    let etaE = NB_H12_CHI * (mu + sinE * NB_H12_TAN * ee.y / (2.0 - ee.x));
    // The rough surface's effective cosines, and its shadows, S, from whichever of the two angles is larger.
    var mu0e: f32;
    var mue: f32;
    var shadow: f32;
    if (mu0 >= mu) {
        let d = 2.0 - ee.x - psi * ei.x;
        mu0e = NB_H12_CHI * (mu0 + sinI * NB_H12_TAN * (cosPsi * ee.y + half2 * ei.y) / d);
        mue = NB_H12_CHI * (mu + sinE * NB_H12_TAN * (ee.y - half2 * ei.y) / d);
        shadow = mue / etaE * mu0 / etaI * NB_H12_CHI / (1.0 - f + f * NB_H12_CHI * mu0 / etaI);
    } else {
        let d = 2.0 - ei.x - psi * ee.x;
        mu0e = NB_H12_CHI * (mu0 + sinI * NB_H12_TAN * (ei.y - half2 * ee.y) / d);
        mue = NB_H12_CHI * (mu + sinE * NB_H12_TAN * (cosPsi * ei.y + half2 * ee.y) / d);
        shadow = mue / etaE * mu0 / etaI * NB_H12_CHI / (1.0 - f + f * NB_H12_CHI * mu / etaE);
    }
    let b2 = NB_H12_B * NB_H12_B;
    let back = 1.0 - 2.0 * NB_H12_B * cosG + b2;
    let forth = 1.0 + 2.0 * NB_H12_B * cosG + b2;
    let p = (1.0 - b2) * (0.5 * (1.0 + NB_H12_C) / (back * sqrt(back)) + 0.5 * (1.0 - NB_H12_C) / (forth * sqrt(forth)));
    // tan(g / 2) from the cosine.
    let tanHalf = sqrt(max(1.0 - cosG, 0.0) / max(1.0 + cosG, 1e-6));
    let surge = 1.0 / (1.0 + tanHalf / NB_H12_HS);
    let multiple = nbH12H(mu0e) * nbH12H(mue) - 1.0;
    let radiance = NB_H12_W * 0.25 * mu0e / max(mu0e + mue, 1e-6) * (p * (1.0 + NB_H12_BS0 * surge) + multiple) * shadow;
    return max(radiance, 0.0) * NB_H12_NORM / NB_PI;
}

fn nbReflectance(law: u32, mu0: f32, mu: f32, cosG: f32) -> f32 {
    if (mu0 <= 0.0) {
        return 0.0;
    }
    if (law == 1u) {
        return nbLambert(mu0);
    }
    if (law == 2u) {
        return nbOrenNayar(mu0, max(mu, 0.0), cosG);
    }
    if (law == 3u) {
        return nbHapke2012(mu0, max(mu, 0.0), cosG);
    }
    return nbHapke(mu0, max(mu, 0.0), cosG);
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
