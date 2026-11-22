// The sky pass: a compute pass that turns the precomputed tables into pixels, one invocation per pixel of the target,
// with no rasterization. Requires `atmosphere.wgsl`, `common.wgsl`, `lut.wgsl`, `sampling.wgsl`, `raymarch.wgsl`,
// `camera.wgsl`, `cube.wgsl`, `sun.wgsl`, `glare.wgsl`, `whitebalance.wgsl`, `tonemap.wgsl`, `vision.wgsl`, `grid.wgsl`, `frame.wgsl`, `quality.wgsl` and
// `features.wgsl`, plus the output
// at group 1, `dkOutputSize` and `dkOutputStore`, declared by whoever builds the pipeline since its format has to be
// spelled out: `skyOutput(format)` for an image, `skyCubeOutput(format)` for a cube map's six faces.
//
// For an image, it writes every pixel, so the sky goes first, as the background the rest of the frame is drawn over.
// For a cube map, with DK_CUBE, it writes the luminance itself, in cd/m², neither exposed nor tone mapped, or times
// skyViewScale with DK_CUBE_SCALED.

@group(0) @binding(0) var<uniform> dkAtmosphere: DkAtmosphere;
@group(0) @binding(1) var<uniform> dkParams: DkSkyParams;
@group(0) @binding(2) var dkTransmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var dkSkyViewLut: texture_2d<f32>;
@group(0) @binding(4) var dkLutSampler: sampler;
@group(0) @binding(5) var dkMultiScatteringLut: texture_2d<f32>;
@group(0) @binding(6) var<storage, read> dkMetering: DkMetering;
// The Moon's sky-view table, read with DK_MOONLIGHT; the Sun's is bound in its place without.
@group(0) @binding(7) var dkMoonViewLut: texture_2d<f32>;
// helldunkel's blue noise, read with DK_DITHER.
@group(0) @binding(8) var dkBlueNoise: texture_2d<f32>;

// Offsets within a texel, in [-0.5, 0.5), from Roberts' R2 sequence: evenly spread for any count, the first at the
// center.
fn dkR2(i: u32) -> vec2f {
    return fract(vec2f(0.5) + f32(i) * vec2f(0.7548776662466927, 0.5698402909980532)) - 0.5;
}

// The grid in white, over the sky (see grid.wgsl).
fn dkDebugOverlay(color: vec3f, view: vec3f, right: vec3f, below: vec3f, ground: f32) -> vec3f {
    let sun = dkParams.sunDirection;
    return dkGridOverlay(color, view, right, below, vec3f(dkParams.gridInk), sun, dkParams.sunAngularRadius, dkParams.pixelRatio, ground);
}

// The exposure luminance in cd/m² is multiplied by. Metered, it is the light meter's EV100, log2(L * 100 / 12.5) for
// the average luminance L, less the compensation, held within its range.
fn dkExposure() -> f32 {
    if (DK_AUTO_EXPOSURE) {
        let range = dkParams.autoExposureRange;
        let metered = dkMetering.log2Luminance + 3.0 - dkParams.exposureCompensation;
        return 1.0 / (1.2 * exp2(clamp(metered, range.x, range.y)));
    }
    return dkParams.exposure;
}

// The tone curve the pass was made with, from tonemap.wgsl, sRGB encoded, beyond 1 up to the headroom on HDR.
fn dkToneMap(exposed: vec3f) -> vec3f {
    if (DK_TONE_MAP == 2u) {
        return hdToneMapAgx(exposed);
    }
    if (DK_TONE_MAP == 3u) {
        return hdToneMapAces(exposed);
    }
    if (DK_TONE_MAP == 4u) {
        return hdToneMapClipHdr(exposed, DK_HEADROOM);
    }
    return hdToneMapNeutralHdr(exposed, DK_HEADROOM);
}

// What the sky shows along a view ray, in linear sRGB.
struct DkSkySample {
    luminance: vec3f,
    hitsGround: bool,
    // The direction the ray leaves the atmosphere in, bent by the air: where the sun has to be to show in it.
    direction: vec3f,
    // Transmittance along the whole ray at the four wavelengths, raymarched from space; inside the atmosphere it is
    // looked up only where the disc shows, by dkSkySunTransmittance.
    transmittance: vec4f,
}

fn dkInSpace() -> bool {
    return dkParams.observerAltitude > dkAtmosphere.Rt - dkAtmosphere.Rg;
}

// Where a view ray reads a sky-view table built for a light towards `light`, by the azimuth from the light's. Degenerate
// when either vector points straight up, where azimuth is meaningless and any value gives the same lookup. The table's
// upper half is sky, the lower half ground, split exactly at the horizon: kept to its own half, so the linear filter
// does not blend the last row of sky with the first of ground.
fn dkSkyViewUvToward(horizon: vec3f, view: vec3f, light: vec3f, hitsGround: bool, size: vec2f) -> vec2f {
    var cosAzimuth = 1.0;
    if (length(view.xy) > 1e-6 && length(light.xy) > 1e-6) {
        cosAzimuth = clamp(dot(normalize(view.xy), normalize(light.xy)), -1.0, 1.0);
    }
    var uv = dkSkyViewUvAt(horizon, view.z, cosAzimuth, size);
    let half = 0.5 / size.y;
    uv.y = select(min(uv.y, 0.5 - half), max(uv.y, 0.5 + half), hitsGround);
    return uv;
}

// For an observer inside the atmosphere, from the sky-view table, at the altitude it was built for, and the Moon's.
fn dkSkyFromInside(a: DkAtmosphere, view: vec3f) -> DkSkySample {
    var result: DkSkySample;
    // The observer's horizon, written by the light meter whenever the table is rebuilt: of the altitude alone.
    let horizon = dkMetering.horizon.xyz;
    result.hitsGround = dkBelowHorizon(horizon, view.z);

    let size = vec2f(textureDimensions(dkSkyViewLut));
    let uv = dkSkyViewUvToward(horizon, view, dkParams.sunDirection, result.hitsGround, size);
    result.luminance = dkToRgb(a, textureSampleLevel(dkSkyViewLut, dkLutSampler, uv, 0.0)) / dkParams.skyViewScale;
    if (DK_MOONLIGHT && dkParams.moonlight > 0.0) {
        let moonUv = dkSkyViewUvToward(horizon, view, dkParams.moonDirection, result.hitsGround, size);
        let moon = textureSampleLevel(dkMoonViewLut, dkLutSampler, moonUv, 0.0);
        result.luminance = result.luminance + dkToRgb(a, moon) / dkParams.moonViewScale;
    }

    // Turned down within its vertical plane by the bending the table traced, stored per row as its sine, and read
    // between rows as the filter would.
    let horizontal = length(view.xy);
    result.direction = view;
    if (horizontal > 1e-6 && !result.hitsGround) {
        let row = clamp(uv.y * size.y - 0.5, 0.0, size.y - 1.0);
        let first = u32(row);
        let bend = mix(dkMetering.bend[first], dkMetering.bend[min(first + 1u, u32(size.y) - 1u)], fract(row));
        let down = vec3f(view.z * view.xy / horizontal, -horizontal);
        result.direction = view * sqrt(1.0 - bend * bend) + down * bend;
    }
    return result;
}

// For an observer above the atmosphere, raymarched per pixel from where the ray enters it; beyond the table, which
// covers only altitudes inside.
fn dkSkyFromSpace(a: DkAtmosphere, view: vec3f, altitude: f32) -> DkSkySample {
    let ray = dkRaymarchFromSpace(
        a, dkTransmittanceLut, dkMultiScatteringLut, dkLutSampler, altitude, view, dkParams.sunDirection,
        DK_SAMPLES_SKY_VIEW,
    );
    var luminance = dkToRgb(a, ray.luminance);
    if (DK_MOONLIGHT && dkParams.moonlight > 0.0) {
        // The Moon's own light is in no eclipse of the Sun.
        let eclipse = dkEclipse;
        dkEclipse.moonRadius = 0.0;
        let moon = dkRaymarchFromSpace(
            a, dkTransmittanceLut, dkMultiScatteringLut, dkLutSampler, altitude, view, dkParams.moonDirection,
            DK_SAMPLES_SKY_VIEW,
        );
        dkEclipse = eclipse;
        luminance = luminance + dkToRgb(a, moon.luminance) * dkParams.moonlight;
    }
    return DkSkySample(luminance, ray.hitsGround, ray.direction, ray.transmittance);
}

fn dkSkyAt(view: vec3f) -> DkSkySample {
    let altitude = max(dkParams.observerAltitude, 0.0);
    if (dkInSpace()) {
        return dkSkyFromSpace(dkAtmosphere, view, altitude);
    }
    return dkSkyFromInside(dkAtmosphere, view);
}

// Transmittance towards the sun along a sampled ray, zero where the planet is in the way. Per ray rather than for the
// sun's center, so a disc half below the bent horizon still shows its upper half.
fn dkSkySunTransmittance(sky: DkSkySample) -> vec4f {
    if (sky.hitsGround) {
        return vec4f(0.0);
    }
    if (dkInSpace()) {
        return sky.transmittance;
    }
    let h = max(dkParams.observerAltitude, 0.0);
    return dkSampleTransmittanceToTop(dkAtmosphere, dkTransmittanceLut, dkLutSampler, h, sky.direction.z);
}

// How far the Moon's limb stands out or in by its mountains and valleys, as a share of its radius, by the angle around
// its disc: four waves standing in for its true profile, some 2.5 km at their most. Not the Moon's own limb.
fn dkMoonLimb(angle: f32) -> f32 {
    return 6e-4 * (sin(13.0 * angle + 1.3) + 0.7 * sin(29.0 * angle + 4.1) + 0.5 * sin(61.0 * angle + 2.2)
        + 0.35 * sin(127.0 * angle + 5.7));
}

// Lines across a pixel on which the Moon's limb is laid over the Sun's.
const DK_ECLIPSE_LINES: u32 = 12u;

// How much of the Sun's part of a pixel `footprint` radians across, looking along the bent `direction`, the Moon leaves
// uncovered in a solar eclipse: counted on lines from the Moon's center out through the pixel, each from where it
// enters the Sun's disc or the pixel to where it leaves either, with the Moon's limb between. Near totality the sliver
// between the two limbs is far thinner than a pixel, and a ray through the pixel's middle would light all of it or
// none. With the uniforms' `eclipseBeads` the limb is the uneven one of dkMoonLimb, and the Sun shines through its
// valleys, Baily's beads: in the seconds before and after a total eclipse, as a string of points.
fn dkSkySunBehindMoon(direction: vec3f, footprint: f32) -> f32 {
    let moon = dkParams.moonDirection;
    let east = normalize(cross(select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(moon.z) > 0.9), moon));
    let north = cross(moon, east);
    // The pixel and the Sun's center from the Moon's, in radians east and north.
    let pixel = vec2f(dot(direction - moon, east), dot(direction - moon, north));
    let sun = vec2f(dot(dkParams.sunDirection - moon, east), dot(dkParams.sunDirection - moon, north));
    let along = vec2f(-pixel.y, pixel.x) / max(length(pixel), 1e-12);
    // The Moon's radius from its distance: a cosine near 1 holds it too coarsely for a sliver of an arcsecond.
    let radius = dkParams.eclipseMoonRadius / length(vec4f(dkParams.eclipseOffset, dkParams.eclipseAlong));
    // As far out and in as the pixel's corners reach.
    let half = 0.7071 * footprint;
    var lit = 0.0;
    var clear = 0.0;
    for (var i = 0u; i < DK_ECLIPSE_LINES; i = i + 1u) {
        let at = pixel + along * (((f32(i) + 0.5) / f32(DK_ECLIPSE_LINES) - 0.5) * footprint);
        let distance = length(at);
        let out = at / max(distance, 1e-12);
        let b = dot(out, sun);
        let reach = b * b - dot(sun, sun) + dkParams.sunAngularRadius * dkParams.sunAngularRadius;
        if (reach <= 0.0) {
            continue;
        }
        let root = sqrt(reach);
        let low = max(b - root, distance - half);
        let high = min(b + root, distance + half);
        if (high <= low) {
            continue;
        }
        var limb = radius;
        if (dkParams.eclipseBeads > 0.0) {
            limb = radius * (1.0 + dkMoonLimb(atan2(out.y, out.x)));
        }
        lit += high - low;
        clear += max(high - max(low, limb), 0.0);
    }
    if (lit <= 0.0) {
        return 0.0;
    }
    return clear / lit;
}

// The sun disc's luminance along a sampled ray, attenuated by the air between it and the observer, from sun.wgsl. With
// a `footprint`, the pixel's width in radians, the Moon in front takes its share of the pixel, dkSkySunBehindMoon.
fn dkSkySunLuminance(sky: DkSkySample, footprint: f32) -> vec3f {
    // Behind the Moon, a solar eclipse: both true directions, as the ray leaves the air.
    var uncovered = 1.0;
    if (dkParams.eclipseMoonRadius > 0.0 && footprint > 0.0) {
        uncovered = dkSkySunBehindMoon(sky.direction, footprint);
    } else if (dot(sky.direction, dkParams.moonDirection) > dkParams.moonDiscCos) {
        uncovered = 0.0;
    }
    if (uncovered <= 0.0) {
        return vec3f(0.0);
    }
    let illuminance = dkToRgb(dkAtmosphere, dkSkySunTransmittance(sky) * dkAtmosphere.solarIlluminance);
    var luminance = dkSunDiscLuminance(illuminance, dkParams.sunAngularRadius) * uncovered;
    if (DK_LIMB_DARKENING) {
        luminance = luminance * dkSunLimbDarkening(sky.direction, dkParams.sunDirection, dkParams.sunAngularRadius);
    }
    let brightest = max(luminance.r, max(luminance.g, luminance.b));
    if (dkParams.sunDiscCeiling > 0.0 && brightest > dkParams.sunDiscCeiling) {
        return luminance * (dkParams.sunDiscCeiling / brightest);
    }
    return luminance;
}

fn dkSkySunCoverage(sky: DkSkySample, footprint: f32) -> f32 {
    return dkSunDiscCoverage(sky.direction, dkParams.sunDirection, dkParams.sunAngularRadius, footprint);
}

// Within how many degrees of the sun the aureole is marched, and from where it fades out towards that: where its lobe
// falls to a five-thousandth of its peak, lost against the sky the tables already hold, 20° at g 0.98, fading from 60 %
// of it. A sharper lobe is marched over less of the sky, a broader one never over more than 20°.
fn dkAureoleReach() -> vec2f {
    let g = DK_AUREOLE_G;
    let oneMinusCos = (1.0 - g) * (1.0 - g) * (pow(2e-4, -2.0 / 3.0) - 1.0) / (2.0 * g);
    let reach = min(acos(clamp(1.0 - oneMinusCos, -1.0, 1.0)) * 57.29577951308232, 20.0);
    return vec2f(0.6 * reach, reach);
}

// The angle between a view ray and where a light shows, in degrees.
fn dkFromApparent(view: vec3f, apparent: vec3f) -> f32 {
    return 2.0 * asin(min(length(view - apparent) * 0.5, 1.0)) * 57.29577951308232;
}

// The aureole along a view ray, in cd/m²: the narrow lobe's share of the aerosols' scattering, marched along the ray as
// the sky is, dkRaymarchAerosol, times Henyey and Greenstein's lobe. The scattering angle is measured in the view's own
// directions from where the sun shows: the sunlight reaching the aerosols near the observer is bent as the view rays
// are, so the glow sits on the disc, and runs on unbroken across the horizon, where the bent direction a ray leaves the
// atmosphere in gives way to the ground. Nothing from space, where the observer is above the aerosols. The Moon's too,
// the same glow at its share of the Sun's light: what makes a halo-less Moon in haze glow.
fn dkSkyAureole(view: vec3f) -> vec3f {
    if (DK_AUREOLE_SHARE <= 0.0 || dkInSpace()) {
        return vec3f(0.0);
    }
    var glow = dkAureoleOf(view, dkParams.sunDirection, dkParams.apparentSunDirection);
    if (DK_MOONLIGHT && dkParams.moonlight > 0.0) {
        let eclipse = dkEclipse;
        dkEclipse.moonRadius = 0.0;
        glow = glow + dkAureoleOf(view, dkParams.moonDirection, dkParams.apparentMoonDirection) * dkParams.moonlight;
        dkEclipse = eclipse;
    }
    return glow;
}

// The aureole of a light of the Sun's illuminance towards `light`, showing at `apparent`.
fn dkAureoleOf(view: vec3f, light: vec3f, apparent: vec3f) -> vec3f {
    let angle = dkFromApparent(view, apparent);
    let reach = dkAureoleReach();
    if (angle >= reach.y) {
        return vec3f(0.0);
    }
    let a = dkAtmosphere;
    let h = max(dkParams.observerAltitude, 0.0);
    let column = dkRaymarchAerosol(a, dkTransmittanceLut, dkLutSampler, h, view, light);
    let phase = dkPhaseHenyeyGreenstein(DK_AUREOLE_G, dot(view, apparent));
    let fade = 1.0 - smoothstep(reach.x, reach.y, angle);
    return dkToRgb(a, column * a.solarIlluminance) * (DK_AUREOLE_SHARE * phase * fade);
}

// The veil along a view ray, from glare.wgsl, by the illuminance the light meter wrote of the Sun and, with
// DK_MOONLIGHT, of the Moon, so it dims and reddens with each through the air and goes out behind the planet, and the
// Sun's behind the Moon: for an eye of thirty years, blue-green, times DK_VEIL. An effect of the eye or the lens, so
// centered on where each shows, in the view's directions, and only of what is looked at: times the uniforms'
// `sunInFrame` and `moonInFrame`.
fn dkSkyVeil(view: vec3f) -> vec3f {
    if (DK_VEIL <= 0.0) {
        return vec3f(0.0);
    }
    // In a solar eclipse the light is the crescent's, off the Sun's center away from the Moon by the share covered: on
    // the limb as it closes, where the last of the Sun shows.
    var center = dkParams.apparentSunDirection;
    let away = dkParams.sunDirection - dkParams.moonDirection;
    if (dkParams.eclipseMoonRadius > 0.0 && dot(away, away) > 1e-16) {
        let covered = 1.0 - dkEclipseShares(vec3f(0.0)).x;
        center = normalize(center + normalize(away) * (dkParams.sunAngularRadius * covered));
    }
    var veil = hdVeil(view, center, dkMetering.sunIlluminance * dkParams.sunInFrame, 30.0, 1.0);
    if (DK_MOONLIGHT) {
        veil = veil
            + hdVeil(view, dkParams.apparentMoonDirection, dkMetering.moonIlluminance, 30.0, 1.0) * dkParams.moonInFrame;
    }
    return veil * DK_VEIL;
}

// The Sun's corona and chromosphere along a sampled ray, from sun.wgsl, in cd/m²: shares of the disc's luminance, so
// behind the air, the ground and the Moon as the disc is, looked up only within the corona's reach of the Sun.
fn dkSkySunCorona(sky: DkSkySample, ground: f32, footprint: f32) -> vec3f {
    if (!DK_SOLAR_CORONA || !DK_SUN_DISC || ground >= 1.0) {
        return vec3f(0.0);
    }
    let radius = dkParams.sunAngularRadius;
    let near = length(sky.direction - dkParams.sunDirection) < DK_SUN_CORONA_REACH * radius;
    if (!near) {
        return vec3f(0.0);
    }
    // Behind the Moon: in an eclipse by the share of the pixel its limb leaves, so the Moon's outline against the
    // corona is as smooth as the pixels allow; its radius from its distance, as in dkSkySunBehindMoon.
    var uncovered = 1.0;
    if (dkParams.eclipseMoonRadius > 0.0) {
        let moon = dkParams.eclipseMoonRadius / length(vec4f(dkParams.eclipseOffset, dkParams.eclipseAlong));
        let fromMoon = length(sky.direction - dkParams.moonDirection);
        uncovered = clamp((fromMoon - moon) / max(footprint, 1e-9) + 0.5, 0.0, 1.0);
    } else if (dot(sky.direction, dkParams.moonDirection) > dkParams.moonDiscCos) {
        uncovered = 0.0;
    }
    if (uncovered <= 0.0) {
        return vec3f(0.0);
    }
    let illuminance = dkToRgb(dkAtmosphere, dkSkySunTransmittance(sky) * dkAtmosphere.solarIlluminance);
    let share = vec3f(dkSunCorona(sky.direction, dkParams.sunDirection, radius))
        + dkSunChromosphere(sky.direction, dkParams.sunDirection, radius, footprint);
    return share * dkSunDiscLuminance(illuminance, radius) * ((1.0 - ground) * uncovered);
}

// Rays through a pixel the disc's edge or the horizon crosses, with DK_SUPERSAMPLE.
const DK_SUPERSAMPLES: u32 = 16u;

// How much of the pixel the disc covers. The air squeezes the disc near the horizon, from orbit to a fifth of its height,
// so its upper and lower edges are sharper than the pixel's unbent footprint says: near an edge, the share is counted
// over DK_SUPERSAMPLES rays through the pixel instead, each bent on its own way.
fn dkSkySunCoverageOfPixel(sky: DkSkySample, pixel: vec2u, size: vec2u, footprint: f32) -> f32 {
    let edge = abs(length(sky.direction - dkParams.sunDirection) - dkParams.sunAngularRadius);
    if (!DK_SUPERSAMPLE || edge > 8.0 * footprint) {
        return dkSkySunCoverage(sky, footprint);
    }
    var hits = 0.0;
    for (var i = 0u; i < DK_SUPERSAMPLES; i = i + 1u) {
        let ray = dkSkyAt(dkPixelRayAt(vec2f(pixel) + 0.5 + dkR2(i), size));
        hits = hits + dkSkySunCoverage(ray, 0.0);
    }
    return hits / f32(DK_SUPERSAMPLES);
}

// Whether the horizon may cross a pixel looking along `view`: within two pixels of it, and from space up to two degrees
// above the planet's rim, where the air bends grazing rays down onto it.
fn dkNearHorizon(view: vec3f, footprint: f32) -> bool {
    let horizon = dkMetering.horizon.x;
    let above = select(2.0 * footprint, 2.0 * footprint + 0.035, dkInSpace());
    return view.z > horizon - 2.0 * footprint && view.z < horizon + above;
}

// Whether the ground and the sky meet within the pixel: one of its corners on the other side from its center.
fn dkHorizonCrosses(pixel: vec2u, size: vec2u, center: bool) -> bool {
    var crosses = false;
    for (var i = 0u; i < 4u; i = i + 1u) {
        let corner = vec2f(pixel) + vec2f(f32(i & 1u), f32(i >> 1u));
        crosses = crosses || dkSkyAt(dkPixelRayAt(corner, size)).hitsGround != center;
    }
    return crosses;
}

// A pixel the horizon crosses, as the mean of DK_SUPERSAMPLES rays through it: the sky's light, how much of it is
// ground, how much is the disc, and the disc's light where it shows.
struct DkPixel {
    luminance: vec3f,
    ground: f32,
    sun: vec3f,
    disc: f32,
}

fn dkSupersampledPixel(pixel: vec2u, size: vec2u) -> DkPixel {
    var result = DkPixel(vec3f(0.0), 0.0, vec3f(0.0), 0.0);
    for (var i = 0u; i < DK_SUPERSAMPLES; i = i + 1u) {
        let ray = dkSkyAt(dkPixelRayAt(vec2f(pixel) + 0.5 + dkR2(i), size));
        result.luminance = result.luminance + ray.luminance;
        result.ground = result.ground + select(0.0, 1.0, ray.hitsGround);
        if (DK_SUN_DISC && !ray.hitsGround && dkSkySunCoverage(ray, 0.0) > 0.0) {
            result.disc = result.disc + 1.0;
            result.sun = result.sun + dkSkySunLuminance(ray, 0.0);
        }
    }
    if (result.disc > 0.0) {
        result.sun = result.sun / result.disc;
    }
    let n = f32(DK_SUPERSAMPLES);
    return DkPixel(result.luminance / n, result.ground / n, result.sun, result.disc / n);
}

// `view` turned up or down within its vertical plane to the cosine `mu`.
fn dkWithMu(view: vec3f, mu: f32) -> vec3f {
    let horizontal = length(view.xy);
    if (horizontal < 1e-6) {
        return view;
    }
    return vec3f(view.xy / horizontal * sqrt(max(1.0 - mu * mu, 0.0)), mu);
}

// The ray through the center of a pixel, top left first.
fn dkPixelRay(pixel: vec2u, size: vec2u) -> vec3f {
    return dkPixelRayAt(vec2f(pixel) + 0.5, size);
}

// The ray through a point of the target, in pixels from its top left corner.
fn dkPixelRayAt(position: vec2f, size: vec2u) -> vec3f {
    let uv = position / vec2f(size);
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    return dkProjectRay(dkParams.inverseViewProjection, ndc, clamp(dkParams.projectionDistance, 0.0, 1.0));
}

// A texel of a cube map: the mean of DK_SAMPLES_CUBE rays through it, in cd/m², the disc included with DK_SUN_DISC; times
// skyViewScale with DK_CUBE_SCALED.
// One of a texel's rays, standing for its share of the texel: `cell` is how far the cosine of the zenith angle runs
// across that share. Where the visible horizon crosses it, the sky just above and the ground just below, mixed by how
// much of the share lies below, as the sky pass does a pixel. Alone, a ray would take all of one or the other, and the
// few rays of a texel by the horizon would decide it by where they happen to fall: on the same sky, a cube map's faces,
// whose rays fall differently, would disagree along its first row below the horizon by up to a factor of two.
fn dkSkyRayLuminance(view: vec3f, sky: DkSkySample, cell: f32) -> vec3f {
    if (dkInSpace()) {
        return sky.luminance;
    }
    let horizon = dkMetering.horizon.x;
    let footprint = max(cell, 1e-6);
    let below = clamp((horizon - view.z) / footprint + 0.5, 0.0, 1.0);
    if (below <= 0.0 || below >= 1.0) {
        return sky.luminance;
    }
    let above = dkSkyAt(dkWithMu(view, horizon + 0.25 * footprint));
    let under = dkSkyAt(dkWithMu(view, horizon - 0.25 * footprint));
    return mix(above.luminance, under.luminance, below);
}

// The direction through a point of a cube face, through Nowell's mapping in a cubified one.
fn dkCubeRay(face: u32, position: vec2f, size: u32) -> vec3f {
    let point = rbCubePointAt(face, position, size);
    return select(normalize(point), rbSphereFromCube(point), DK_CUBIFY);
}

// How far the cosine of the zenith angle runs across a ray's share of its texel, a square 1 / sqrt(rays) of a texel on a
// side, from the rays through its corners.
fn dkCellOf(view: vec3f, across: vec3f, down: vec3f) -> f32 {
    return abs(across.z - view.z) + abs(down.z - view.z);
}

// Offsets within a cube map's texel for its rays, in [-0.5, 0.5): eight at a time, each a point of
// Roberts' R2 sequence in its eight mirror images, so the rays fall alike however a face is turned or flipped, and
// centered on the texel. A lean of the rays to one side, R2's eight lean 0.11 of a texel, would shift every texel of a
// face along the steep gradient by the horizon, and the faces would disagree by a few percent on a sky the same all
// round. One ray alone takes the center.
fn dkTexelOffset(i: u32) -> vec2f {
    if (DK_SAMPLES_CUBE == 1u) {
        return vec2f(0.0);
    }
    let p = dkR2(i / 8u + 1u);
    let k = i % 8u;
    let q = select(p, p.yx, (k & 4u) != 0u);
    return q * vec2f(select(1.0, -1.0, (k & 1u) != 0u), select(1.0, -1.0, (k & 2u) != 0u));
}

fn dkCubeTexel(face: u32, texel: vec2u, size: u32) -> vec3f {
    var luminance = vec3f(0.0);
    let side = inverseSqrt(f32(DK_SAMPLES_CUBE));
    for (var i = 0u; i < DK_SAMPLES_CUBE; i = i + 1u) {
        let position = vec2f(texel) + 0.5 + dkTexelOffset(i);
        let view = dkCubeRay(face, position, size);
        let sky = dkSkyAt(view);
        let cell = dkCellOf(
            view,
            dkCubeRay(face, position + vec2f(side, 0.0), size),
            dkCubeRay(face, position + vec2f(0.0, side), size),
        );
        luminance = luminance + dkSkyRayLuminance(view, sky, cell) + dkSkyAureole(view);
        if (DK_SUN_DISC && dkSkySunCoverage(sky, 0.0) > 0.0) {
            luminance = luminance + dkSkySunLuminance(sky, 0.0);
        }
    }
    luminance = luminance / f32(DK_SAMPLES_CUBE) * select(1.0, dkParams.skyViewScale, DK_CUBE_SCALED);
    // Without the disc the cube map is half floats, which the aureole's peak at noon can pass: held at their largest.
    return select(min(luminance, vec3f(65504.0)), luminance, DK_SUN_DISC);
}

@compute @workgroup_size(8, 8, 1)
fn dkSky(@builtin(global_invocation_id) id: vec3u) {
    let size = dkOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    // A solar eclipse, for every march from here on.
    dkEclipse = DkEclipse(
        dkParams.eclipseOffset, dkParams.eclipseAlong, dkParams.sunDirection, dkParams.eclipseMoonRadius,
        dkParams.sunAngularRadius, 0.0,
    );
    if (DK_CUBE) {
        dkOutputStore(id.xy, id.z, vec4f(dkCubeTexel(id.z, id.xy, size.x), 1.0));
        return;
    }

    let view = dkPixelRay(id.xy, size);
    let right = dkPixelRay(id.xy + vec2u(1u, 0u), size);
    let footprint = length(right - view);

    // The horizon by how much of the pixel lies below it, like the disc's edge: a pixel it crosses mixes the sky with
    // the ground. Decided per pixel center, it would step a row at a time, and cut the disc resting on it with every
    // step. Supersampled, by rays through the pixel, the disc's share among them; otherwise, inside the atmosphere,
    // by the sky just above and the ground just below.
    var sky = dkSkyAt(view);
    var ground = select(0.0, 1.0, sky.hitsGround);
    var luminance = sky.luminance;
    var disc = -1.0;
    var sunLuminance = vec3f(0.0);
    if (DK_SUPERSAMPLE) {
        if (dkNearHorizon(view, footprint) && dkHorizonCrosses(id.xy, size, sky.hitsGround)) {
            let pixel = dkSupersampledPixel(id.xy, size);
            luminance = pixel.luminance;
            ground = pixel.ground;
            disc = pixel.disc;
            sunLuminance = pixel.sun;
        }
    } else if (!dkInSpace()) {
        let horizon = dkMetering.horizon.x;
        let below = clamp((horizon - view.z) / footprint + 0.5, 0.0, 1.0);
        if (below > 0.0 && below < 1.0) {
            let above = dkSkyAt(dkWithMu(view, horizon + 0.25 * footprint));
            let under = dkSkyAt(dkWithMu(view, horizon - 0.25 * footprint));
            sky = above;
            ground = below;
            luminance = mix(above.luminance, under.luminance, below);
        }
    }

    // The aureole, the veil and the Sun's corona, all smooth enough for the center ray.
    luminance = luminance + dkSkyAureole(view) + dkSkyVeil(view) + dkSkySunCorona(sky, ground, footprint);
    if (DK_DARK_ADAPTED) {
        luminance = hdDarkAdaptedEye(luminance);
    }

    // In cd/m², white balanced and exposed. Without tone mapping, that is what is written: linear, for the caller's own
    // tone mapping.
    let exposure = dkExposure();
    var color = hdWhiteBalance(luminance, dkParams.whiteBalance) * exposure;
    // The disc by how much of the pixel it covers, on the sky's part of it, looked up only there. Tone mapped, sky and
    // disc apart and mixed after, since the disc is far beyond white: mixed before, a pixel it barely touches would
    // turn white, and its edge would step.
    if (!DK_SUN_DISC) {
        disc = 0.0;
    } else if (disc < 0.0) {
        disc = dkSkySunCoverageOfPixel(sky, id.xy, size, footprint) * (1.0 - ground);
        if (disc > 0.0) {
            sunLuminance = dkSkySunLuminance(sky, footprint);
        }
    }
    let sun = hdWhiteBalance(sunLuminance, dkParams.whiteBalance) * exposure;
    if (DK_TONE_MAP != 0u) {
        var mapped = dkToneMap(color);
        if (disc > 0.0) {
            mapped = mix(mapped, dkToneMap(color + sun), disc);
        }
        color = mapped;
    } else {
        color = color + sun * disc;
    }

    if (DK_DEBUG_GRID) {
        let below = dkPixelRay(id.xy + vec2u(0u, 1u), size);
        color = dkDebugOverlay(color, view, right, below, ground);
    }
    if (DK_TONE_MAP != 0u && DK_DITHER) {
        color = clamp(hdDitherBlue(color, id.xy, 255.0, dkBlueNoise), vec3f(0.0), hdEncodeSrgbExtended(vec3f(DK_HEADROOM), DK_HEADROOM));
    }
    dkOutputStore(id.xy, 0u, vec4f(color, select(1.0, disc, DK_TONE_MAP == 0u && DK_DISC_ALPHA)));
}
