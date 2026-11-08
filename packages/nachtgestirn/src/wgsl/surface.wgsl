// The Moon's surface, binding-free: where a point of the disc is on the Moon, how it reflects sunlight, and what
// Earth's shadow leaves of that light. Requires `params.wgsl`.

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

// Oren and Nayar's rough diffuse surface, the law a renderer reaches for when Lambert's limb looks wrong, with a
// roughness of 0.5 rad: it brightens the limb towards full Moon, but has no surge and lets a half Moon fade into its
// terminator. The azimuth between the light and the viewer about the normal from the three angles alone.
fn nbOrenNayar(mu0: f32, mu: f32, g: f32) -> f32 {
    const sigma2 = 0.25;
    let a = 1.0 - 0.5 * sigma2 / (sigma2 + 0.33);
    let b = 0.45 * sigma2 / (sigma2 + 0.09);
    let sin0 = sqrt(max(1.0 - mu0 * mu0, 0.0));
    let sinV = sqrt(max(1.0 - mu * mu, 0.0));
    let cosAzimuth = max((cos(g) - mu0 * mu) / max(sin0 * sinV, 1e-4), 0.0);
    let alpha = max(sin0, sinV);
    let tanBeta = min(sin0 / max(mu0, 1e-4), sinV / max(mu, 1e-4));
    return mu0 * (a + b * cosAzimuth * alpha * tanBeta) / NB_PI;
}

// The metallic-roughness surface of a PBR renderer at its best for the Moon: a dielectric of roughness 1, Burley's
// diffuse, as Disney's and Unreal's materials have it, which lifts a rough surface towards its rim, under a GGX lobe
// with Smith's shadowing and Schlick's Fresnel. The half vector's cosines from the three angles alone: the Sun and
// the viewer are the phase angle apart. It still has no backscatter, which no metallic-roughness material can.
fn nbMetallicRoughness(mu0: f32, mu: f32, g: f32) -> f32 {
    const roughness = 1.0;
    const f0 = 0.04;
    let alpha = roughness * roughness;
    let cosG = cos(g);
    let nh = (mu0 + mu) / max(sqrt(2.0 + 2.0 * cosG), 1e-4);
    let vh = sqrt(max((1.0 + cosG) / 2.0, 0.0));
    let a2 = alpha * alpha;
    let dd = nh * nh * (a2 - 1.0) + 1.0;
    let d = a2 / (NB_PI * dd * dd);
    let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
    let gs = (mu0 / (mu0 * (1.0 - k) + k)) * (mu / max(mu * (1.0 - k) + k, 1e-4));
    let fresnel = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);
    let specular = d * gs * fresnel / max(4.0 * mu0 * mu, 1e-4);
    let f90 = 0.5 + 2.0 * roughness * vh * vh;
    let diffuse = (1.0 + (f90 - 1.0) * pow(1.0 - mu0, 5.0)) * (1.0 + (f90 - 1.0) * pow(1.0 - mu, 5.0)) / NB_PI;
    return mu0 * (diffuse + specular);
}

fn nbReflectance(law: u32, mu0: f32, mu: f32, g: f32) -> f32 {
    if (mu0 <= 0.0) {
        return 0.0;
    }
    if (law == 1u) {
        return nbLambert(mu0);
    }
    if (law == 2u) {
        return nbOrenNayar(mu0, max(mu, 0.0), g);
    }
    if (law == 3u) {
        return nbMetallicRoughness(mu0, max(mu, 0.0), g);
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
// Earth leaves uncovered, seen from that point, plus what its atmosphere bends into the umbra, red in the middle, with
// the turquoise rim ozone leaves where the light passed the stratosphere. `pointKm` from Earth's center.
fn nbShadow(params: NbParams, pointKm: vec3f) -> vec3f {
    let distanceKm = length(pointKm);
    let toEarth = -pointKm / distanceKm;
    // The Sun's and Earth's discs as that point sees them, and the angle between their centers.
    let earthRadius = asin(min(params.earthRadiusKm / distanceKm, 1.0));
    let sunRadius = params.sunAngularRadius;
    let separation = acos(clamp(dot(toEarth, -params.shadowAxis), -1.0, 1.0));
    let covered = nbLens(earthRadius, sunRadius, separation) / (NB_PI * sunRadius * sunRadius);
    let direct = vec3f(1.0 - covered);
    // What the air adds, from the table over the distance from the axis, the axis to the penumbra's edge.
    let axisKm = length(pointKm - dot(pointKm, params.shadowAxis) * params.shadowAxis);
    let x = axisKm / max(params.penumbraKm, 1.0) * f32(NB_UMBRA_SAMPLES - 1u);
    if (x >= f32(NB_UMBRA_SAMPLES - 1u)) {
        return direct;
    }
    let i = u32(floor(x));
    let refracted = mix(params.umbraTable[i].rgb, params.umbraTable[i + 1u].rgb, fract(x));
    return direct + refracted * params.umbraLight;
}
