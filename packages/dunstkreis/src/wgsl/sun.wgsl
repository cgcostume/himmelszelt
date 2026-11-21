// The sun disc, drawn wherever the sky is shown rather than stored in it: in the sky pass, and over a sky cube map, which
// holds the sky without it (see `SkyPass.createCubePass`). And what else is the Sun's own: its limb darkening, its
// chromosphere and its corona. Binding-free.
//
// Kept out of the cube map on purpose. At some 2e9 cd/m², the disc is far beyond what rgba16float holds, and at 0.53° it
// is smaller than a texel of any cube map but a very large one: stored, it would be a blocky texel, smeared by the mip
// levels, and a point so bright that the spherical harmonics projected from the cube map would ring with it. Drawn here,
// it is exact at any resolution, antialiased by the pixel, for a dot product per pixel.

// How much of a pixel `footprint` radians across the disc covers, the pixel's ray bent to `direction`; with no footprint,
// whether the ray hits it. Measured by the chord between the two unit vectors, which equals the angle this close: a test
// against cos(radius) would need cos to 1e-5, and WGSL promises it only to 2^-11.
fn dkSunDiscCoverage(direction: vec3f, sunDirection: vec3f, angularRadius: f32, footprint: f32) -> f32 {
    let distance = length(direction - sunDirection);
    if (footprint <= 0.0) {
        return select(0.0, 1.0, distance < angularRadius);
    }
    return clamp((angularRadius - distance) / footprint + 0.5, 0.0, 1.0);
}

// The disc's luminance in cd/m², from the sun's illuminance where it is seen, in lux, spread over the disc's solid angle:
// some 15000 times brighter than the sky around it.
fn dkSunDiscLuminance(illuminance: vec3f, angularRadius: f32) -> vec3f {
    return illuminance / (3.141592653589793 * angularRadius * angularRadius);
}

// Rays a pixel by the disc's rim is supersampled with, spread over it by Roberts' R2 sequence, the first at its center.
const DK_SUN_DISC_RAYS: u32 = 16u;

fn dkSunDiscOffset(i: u32) -> vec2f {
    return fract(vec2f(0.5) + f32(i) * vec2f(0.7548776662466927, 0.5698402909980532)) - 0.5;
}

// How much of a pixel the disc covers, supersampled where its rim crosses the pixel: DK_SUN_DISC_RAYS rays spread over
// it, from its own ray `view` and those of the pixels right of and below it, each hitting the disc or not, as the sky
// pass takes the disc's edge. Off the rim, 0 or 1 from the one ray. Exact at any zoom, from a disc a fraction of a
// pixel to one filling the view, where a coverage from the distance to the rim alone would blur or step.
fn dkSunDiscPixelCoverage(view: vec3f, right: vec3f, below: vec3f, sunDirection: vec3f, angularRadius: f32) -> f32 {
    let across = right - view;
    let down = below - view;
    let reach = length(across) + length(down);
    let distance = length(view - sunDirection);
    if (distance > angularRadius + reach) {
        return 0.0;
    }
    if (distance < angularRadius - reach) {
        return 1.0;
    }
    var hits = 0u;
    for (var i = 0u; i < DK_SUN_DISC_RAYS; i = i + 1u) {
        let offset = dkSunDiscOffset(i);
        let ray = normalize(view + offset.x * across + offset.y * down);
        hits = hits + select(0u, 1u, length(ray - sunDirection) < angularRadius);
    }
    return f32(hits) / f32(DK_SUN_DISC_RAYS);
}

// The disc's luminance over a pixel, supersampled as dkSunDiscPixelCoverage covers it: add it to what a sky cube map
// gives for the pixel's ray.
fn dkSunDiscPixel(
    view: vec3f,
    right: vec3f,
    below: vec3f,
    sunDirection: vec3f,
    angularRadius: f32,
    illuminance: vec3f,
) -> vec3f {
    let coverage = dkSunDiscPixelCoverage(view, right, below, sunDirection, angularRadius);
    return dkSunDiscLuminance(illuminance, angularRadius) * coverage;
}

// The disc's luminance along a ray, by how much of its pixel it covers: add it to what a sky cube map gives for the ray.
// `illuminance` is `SkyPass.sunIlluminance()`, zero once the planet hides the sun.
fn dkSunDisc(direction: vec3f, sunDirection: vec3f, angularRadius: f32, illuminance: vec3f, footprint: f32) -> vec3f {
    return dkSunDiscLuminance(illuminance, angularRadius) * dkSunDiscCoverage(direction, sunDirection, angularRadius, footprint);
}

// Limb darkening: what the disc's mean luminance is multiplied by along `direction`, per channel, darker and redder
// towards the limb. Hestroffer and Magnan's power law (1998), mu^alpha with alpha = -0.023 + 0.292 / wavelength in
// micrometers, mu the cosine of the angle between the line of sight and the Sun's surface normal, at 610, 550 and 465 nm
// for red, green and blue, over its mean 2 / (alpha + 2) across the disc: the disc's light stays what it was. At 550 nm
// within a hundredth of Allen's 0.3 + 0.93 mu - 0.23 mu². Held at mu 0.1, the last hundredth of the radius, where the
// law's fit ends and the limb shows a third of the center: a pixel on the rim keeps its light.
fn dkSunLimbDarkening(direction: vec3f, sunDirection: vec3f, angularRadius: f32) -> vec3f {
    let s = min(length(direction - sunDirection) / angularRadius, 1.0);
    let mu = max(sqrt(1.0 - s * s), 0.1);
    let alpha = vec3f(0.4557, 0.5079, 0.6050);
    return pow(vec3f(mu), alpha) * (alpha + 2.0) * 0.5;
}

// How many solar radii from the Sun's center its corona is drawn to, fading out over the last quarter: beyond lies the
// zodiacal light, which is not drawn.
const DK_SUN_CORONA_REACH: f32 = 40.0;

// The corona as a share of the disc's mean luminance along `direction`, 0 on the disc: Baumbach's fit to the eclipses of
// 1905 to 1929 (1937), 0.0532 / r^2.5 + 1.425 / r^7 + 2.565 / r^17 millionths of the disc's center, r in solar radii,
// averaged around the Sun, so without its streamers; the center is 1.24 times the mean. 5e-6 at the limb, some
// 9,000 cd/m², and less than a thousandth of that four radii out: for a long exposure or a view close in, with
// nothing brighter spread over it.
fn dkSunCorona(direction: vec3f, sunDirection: vec3f, angularRadius: f32) -> f32 {
    let r = length(direction - sunDirection) / angularRadius;
    if (r < 1.0 || r >= DK_SUN_CORONA_REACH) {
        return 0.0;
    }
    let x = 1.0 / r;
    let x2 = x * x;
    let x4 = x2 * x2;
    let x16 = x4 * x4 * x4 * x4;
    let share = 1.24e-6 * (0.0532 * x2 * sqrt(x) + 1.425 * x4 * x2 * x + 2.565 * x16 * x);
    return share * (1.0 - smoothstep(0.75 * DK_SUN_CORONA_REACH, DK_SUN_CORONA_REACH, r));
}

// The chromosphere as a share of the disc's mean luminance over a pixel `footprint` radians across: a shell 2,500 km
// deep, 0.36 % of the radius, in the pink of hydrogen's lines, taken at 3e-4 of the disc, a rough figure. Thinner
// than a pixel unless zoomed far in, so by how much of the pixel it covers, as the disc's edge is.
fn dkSunChromosphere(direction: vec3f, sunDirection: vec3f, angularRadius: f32, footprint: f32) -> vec3f {
    let distance = length(direction - sunDirection);
    let outer = clamp((1.0036 * angularRadius - distance) / footprint + 0.5, 0.0, 1.0);
    let inner = clamp((angularRadius - distance) / footprint + 0.5, 0.0, 1.0);
    return vec3f(1.0, 0.2, 0.3) * (3e-4 * (outer - inner));
}
