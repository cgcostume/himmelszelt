// The sky pass: a compute pass that turns the precomputed tables into pixels, one invocation per pixel of the target,
// with no rasterization. Requires `atmosphere.wgsl`, `common.wgsl`, `lut.wgsl`, `sampling.wgsl`, `raymarch.wgsl`,
// `cube.wgsl`, `sun.wgsl`, `tonemap.wgsl`, `frame.wgsl`, `quality.wgsl` and `features.wgsl`, plus the output at group 1,
// `dkOutputSize` and `dkOutputStore`, declared by whoever builds the pipeline since its format has to be spelled out:
// `skyOutput(format)` for an image, `skyCubeOutput(format)` for the six faces of a cube map.
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

// Noise of one 8-bit step, added before the output is quantized: it trades the sky's smooth gradients' bands for grain
// too fine to see. Jimenez's interleaved gradient noise, which spreads neighboring values apart like blue noise, from
// the pixel alone, so it is stable from frame to frame and needs no texture; remapped to a triangular distribution,
// whose error does not depend on the signal.
fn dkDither(color: vec3f, p: vec2u) -> vec3f {
    let noise = fract(52.9829189 * fract(dot(vec2f(p), vec2f(0.06711056, 0.00583715)))) * 2.0 - 1.0;
    return color + sign(noise) * (1.0 - sqrt(1.0 - abs(noise))) / 255.0;
}

// Offsets within a texel, in [-0.5, 0.5), from Roberts' R2 sequence: evenly spread for any count, the first at the
// center.
fn dkR2(i: u32) -> vec2f {
    return fract(vec2f(0.5) + f32(i) * vec2f(0.7548776662466927, 0.5698402909980532)) - 0.5;
}

const DK_DEG_TO_RAD: f32 = 0.01745329251994330;

// Debug overlay, in the apparent (camera) frame: lines of altitude every 10 degrees with the horizon stronger, the
// eight compass directions up to 80 degrees, and a ring around the sun disc that shows where it is at any exposure.
fn dkLine(distance: f32, width: f32) -> f32 {
    return 1.0 - smoothstep(0.5 * width, 1.5 * width, distance);
}

fn dkAltitudeDeg(v: vec3f) -> f32 {
    return asin(clamp(v.z, -1.0, 1.0)) / DK_DEG_TO_RAD;
}

fn dkAzimuthDeg(v: vec3f) -> f32 {
    return atan2(v.x, v.y) / DK_DEG_TO_RAD;
}

// An azimuth difference, wrapped into [-180, 180]: the azimuth jumps by 360 degrees due south.
fn dkAzimuthStep(first: f32, second: f32) -> f32 {
    return abs(fract((second - first) / 360.0 + 0.5) - 0.5) * 360.0;
}

// `right` and `below` are the rays of the neighboring pixels: a compute pass has no fwidth, so the lines' widths come
// from how much the angles change from one pixel to the next. `sunAngle` is the bent ray's angle from the sun, so the
// ring goes where the disc shows, flattened by the air as it is.
fn dkDebugOverlay(color: vec3f, view: vec3f, right: vec3f, below: vec3f, sunAngle: f32, sunRadius: f32) -> vec3f {
    let altitude = dkAltitudeDeg(view);
    let azimuth = dkAzimuthDeg(view);
    let altitudeWidth = abs(dkAltitudeDeg(right) - altitude) + abs(dkAltitudeDeg(below) - altitude);
    let azimuthWidth = dkAzimuthStep(azimuth, dkAzimuthDeg(right)) + dkAzimuthStep(azimuth, dkAzimuthDeg(below));
    let pixel = length(abs(right - view) + abs(below - view));

    let altitudeLine = dkLine(abs(fract(altitude / 10.0 + 0.5) - 0.5) * 10.0, altitudeWidth);
    let horizonLine = dkLine(abs(altitude), 1.5 * altitudeWidth);
    // Measured along the circle of altitude, so the lines keep their width as they converge towards the zenith.
    let compassDistance = abs(fract(azimuth / 45.0 + 0.5) - 0.5) * 45.0 * cos(altitude * DK_DEG_TO_RAD);
    let compassLine = dkLine(compassDistance, azimuthWidth * cos(altitude * DK_DEG_TO_RAD))
        * (1.0 - smoothstep(70.0, 80.0, abs(altitude)));
    // At least a few pixels wide, so it still finds the Sun in a wide view, where its disc is a dot.
    let ring = dkLine(abs(sunAngle - max(sunRadius * 1.5, 6.0 * pixel)), pixel);

    // The ring as strong as the compass lines: part of the same grid.
    let grid = max(max(0.1 * altitudeLine, 0.3 * horizonLine), 0.15 * max(compassLine, ring));
    return mix(color, vec3f(1.0), grid);
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
        return dkToneMapAgx(exposed);
    }
    if (DK_TONE_MAP == 3u) {
        return dkToneMapAces(exposed);
    }
    if (DK_TONE_MAP == 4u) {
        return dkToneMapClipHdr(exposed, DK_HEADROOM);
    }
    return dkToneMapNeutralHdr(exposed, DK_HEADROOM);
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

// For an observer inside the atmosphere, from the sky-view table.
fn dkSkyFromInside(a: DkAtmosphere, view: vec3f, h: f32) -> DkSkySample {
    var result: DkSkySample;
    result.hitsGround = dkIntersectsGround(a, h, view.z);

    // Azimuth measured from the sun, the frame the sky-view table is indexed in. Degenerate when either vector points
    // straight up, where azimuth is meaningless and any value gives the same lookup.
    let sunH = dkParams.sunDirection.xy;
    var cosAzimuth = 1.0;
    if (length(view.xy) > 1e-6 && length(sunH) > 1e-6) {
        cosAzimuth = clamp(dot(normalize(view.xy), normalize(sunH)), -1.0, 1.0);
    }

    let size = vec2f(textureDimensions(dkSkyViewLut));
    var uv = dkSkyViewUv(a, h, view.z, cosAzimuth, size);
    // The table's upper half is sky, the lower half ground, split exactly at the horizon. Kept to its own half, so the
    // linear filter does not blend the last row of sky with the first of ground.
    let half = 0.5 / size.y;
    uv.y = select(min(uv.y, 0.5 - half), max(uv.y, 0.5 + half), result.hitsGround);
    result.luminance = dkToRgb(a, textureSampleLevel(dkSkyViewLut, dkLutSampler, uv, 0.0)) / dkParams.skyViewScale;

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
    return DkSkySample(dkToRgb(a, ray.luminance), ray.hitsGround, ray.direction, ray.transmittance);
}

fn dkSkyAt(view: vec3f) -> DkSkySample {
    let altitude = max(dkParams.observerAltitude, 0.0);
    if (dkInSpace()) {
        return dkSkyFromSpace(dkAtmosphere, view, altitude);
    }
    return dkSkyFromInside(dkAtmosphere, view, altitude);
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

// The sun disc's luminance along a sampled ray, attenuated by the air between it and the observer, from sun.wgsl.
fn dkSkySunLuminance(sky: DkSkySample) -> vec3f {
    let illuminance = dkToRgb(dkAtmosphere, dkSkySunTransmittance(sky) * dkAtmosphere.solarIlluminance);
    return dkSunDiscLuminance(illuminance, dkParams.sunAngularRadius);
}

fn dkSkySunCoverage(sky: DkSkySample, footprint: f32) -> f32 {
    return dkSunDiscCoverage(sky.direction, dkParams.sunDirection, dkParams.sunAngularRadius, footprint);
}

// `view` turned up or down within its vertical plane to the cosine `mu`.
fn dkWithMu(view: vec3f, mu: f32) -> vec3f {
    let horizontal = length(view.xy);
    if (horizontal < 1e-6) {
        return view;
    }
    return vec3f(view.xy / horizontal * sqrt(max(1.0 - mu * mu, 0.0)), mu);
}

// The direction through a clip-space point: from the eye, which a perspective projection maps to (0, 0, c, 0), to the
// point halfway into the depth range. So any perspective works: depth in [0, 1] or [-1, 1], reversed, with an infinite
// far plane. A view with translation works too, but costs f32 precision, so leave it out, as for a skybox.
fn dkUnproject(inverseViewProjection: mat4x4f, ndc: vec2f) -> vec3f {
    let eye = inverseViewProjection[2];
    let point = inverseViewProjection * vec4f(ndc, 0.5, 1.0);
    return normalize(point.xyz / point.w - eye.xyz / eye.w);
}

// The camera ray through a clip-space point. The matrix gives the camera's axis and its image plane; the image plane's
// radius rho then maps to the angle theta from the axis by a general perspective: the sphere of directions projected
// from a point d behind the eye, rho = (d + 1) sin(theta) / (d + cos(theta)). d = 0 is the matrix's own rectilinear
// projection, theta = atan(rho); d = 1 is stereographic, theta = 2 atan(rho / 2), which shows the whole sky as a disc
// looking up and a small planet looking down.
fn dkProjectRay(inverseViewProjection: mat4x4f, ndc: vec2f, d: f32) -> vec3f {
    let view = dkUnproject(inverseViewProjection, ndc);
    if (d <= 0.0) {
        return view;
    }
    let center = dkUnproject(inverseViewProjection, vec2f(0.0));
    let along = dot(view, center);
    let offset = view - center * along;
    let rho = length(offset) / along;
    if (rho < 1e-7) {
        return center;
    }
    let k = rho / (d + 1.0);
    let cosTheta = (sqrt(1.0 + k * k * (1.0 - d * d)) - k * k * d) / (1.0 + k * k);
    let sinTheta = sqrt(max(1.0 - cosTheta * cosTheta, 0.0));
    return center * cosTheta + normalize(offset) * sinTheta;
}

// The ray through the center of a pixel, top left first.
fn dkPixelRay(pixel: vec2u, size: vec2u) -> vec3f {
    let uv = (vec2f(pixel) + 0.5) / vec2f(size);
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    return dkProjectRay(dkParams.inverseViewProjection, ndc, clamp(dkParams.projectionDistance, 0.0, 1.0));
}

// A texel of a cube map: the mean of DK_SAMPLES_CUBE rays through it, in cd/m², the disc included with DK_SUN_DISC; times
// skyViewScale with DK_CUBE_SCALED.
fn dkCubeTexel(face: u32, texel: vec2u, size: u32) -> vec3f {
    var luminance = vec3f(0.0);
    for (var i = 0u; i < DK_SAMPLES_CUBE; i = i + 1u) {
        let point = dkCubePointAt(face, vec2f(texel) + 0.5 + dkR2(i), size);
        let sky = dkSkyAt(select(normalize(point), dkSphereFromCube(point), DK_CUBIFY));
        luminance = luminance + sky.luminance;
        if (DK_SUN_DISC && dkSkySunCoverage(sky, 0.0) > 0.0) {
            luminance = luminance + dkSkySunLuminance(sky);
        }
    }
    return luminance / f32(DK_SAMPLES_CUBE) * select(1.0, dkParams.skyViewScale, DK_CUBE_SCALED);
}

@compute @workgroup_size(8, 8, 1)
fn dkSky(@builtin(global_invocation_id) id: vec3u) {
    let size = dkOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    if (DK_CUBE) {
        dkOutputStore(id.xy, id.z, vec4f(dkCubeTexel(id.z, id.xy, size.x), 1.0));
        return;
    }

    let view = dkPixelRay(id.xy, size);
    let right = dkPixelRay(id.xy + vec2u(1u, 0u), size);
    let footprint = length(right - view);

    // The horizon by how much of the pixel lies below it, like the disc's edge: a pixel it crosses mixes the sky just
    // above it with the ground just below. Decided per pixel center, it would step a row at a time, and cut the disc
    // resting on it with every step.
    var sky = dkSkyAt(view);
    var ground = select(0.0, 1.0, sky.hitsGround);
    var luminance = sky.luminance;
    if (!dkInSpace()) {
        let horizon = dkHorizonMu(dkAtmosphere, max(dkParams.observerAltitude, 0.0));
        let below = clamp((horizon - view.z) / footprint + 0.5, 0.0, 1.0);
        if (below > 0.0 && below < 1.0) {
            let above = dkSkyAt(dkWithMu(view, horizon + 0.25 * footprint));
            let under = dkSkyAt(dkWithMu(view, horizon - 0.25 * footprint));
            sky = above;
            ground = below;
            luminance = mix(above.luminance, under.luminance, below);
        }
    }

    // In cd/m², exposed. Without tone mapping, that is what is written: linear, for the caller's own tone mapping.
    let exposure = dkExposure();
    var color = luminance * exposure;
    // The disc by how much of the pixel it covers, on the sky's part of it, looked up only there. Tone mapped, sky and
    // disc apart and mixed after, since the disc is far beyond white: mixed before, a pixel it barely touches would
    // turn white, and its edge would step.
    var disc = 0.0;
    var sun = vec3f(0.0);
    if (DK_SUN_DISC) {
        disc = dkSkySunCoverage(sky, footprint) * (1.0 - ground);
        if (disc > 0.0) {
            sun = dkSkySunLuminance(sky) * exposure;
        }
    }
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
        let sunAngle = length(sky.direction - dkParams.sunDirection);
        color = dkDebugOverlay(color, view, right, below, sunAngle, dkParams.sunAngularRadius);
    }
    if (DK_TONE_MAP != 0u && DK_DITHER) {
        color = clamp(dkDither(color, id.xy), vec3f(0.0), dkEncodeSrgbExtended(vec3f(DK_HEADROOM), DK_HEADROOM));
    }
    dkOutputStore(id.xy, 0u, vec4f(color, 1.0));
}
