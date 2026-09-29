// The sky pass: a compute pass that turns the precomputed tables into pixels, one invocation per pixel of the target,
// with no rasterization. Requires `atmosphere.wgsl`, `common.wgsl`, `lut.wgsl`, `sampling.wgsl`, `raymarch.wgsl`,
// `cube.wgsl`, `goldenset.wgsl`, `sun.wgsl` and `quality.wgsl`, plus the output at group 1, `dkOutputSize` and `dkOutputStore`, declared by whoever
// builds the pipeline since its format has to be spelled out: `skyOutput(format)` for an image, `skyCubeOutput(format)`
// for the six faces of a cube map.
//
// For an image, it writes every pixel, so the sky goes first, as the background the rest of the frame is drawn over.
// For a cube map, with DK_CUBE, it writes the luminance itself, in cd/m², neither exposed nor tone mapped.

struct DkSkyParams {
    inverseViewProjection: mat4x4f,
    // Unit vector towards the sun in the observer's local frame, z up. The true direction: the view rays are bent
    // by the air, and an already refracted sun would move twice.
    sunDirection: vec3f,
    // Observer altitude above the ground, in km. Not the radius, which f32 resolves to only ~0.5 m. Above the top of
    // the atmosphere, every pixel is raymarched from where its ray enters it.
    observerAltitude: f32,
    // osgHimmel's artistic blue-hour tint, on top of the physical model. Intensity 0 skips it.
    lHeureBleueColor: vec3f,
    lHeureBleueIntensity: f32,
    // What luminance in cd/m² is multiplied by, 1 / (1.2 * 2^EV100), unless it is metered.
    exposure: f32,
    // The Sun's apparent angular radius, in radians.
    sunAngularRadius: f32,
    // The lowest EV100 metering may expose with: night stays dark instead of being lifted to day.
    autoExposureMin: f32,
    // Added to the metered exposure, in EV: positive brightens. The keys' ramp over the day included.
    exposureCompensation: f32,
    // Where the sun disc shows, lifted by refraction: the debug overlay's ring goes there.
    apparentSunDirection: vec3f,
    // The projection's d, from 0 (the matrix's own perspective) to 1 (stereographic), see dkProjectRay.
    projectionDistance: f32,
    // Nonzero to expose by the light meter's reading instead of `exposure`.
    autoExposure: u32,
    // The highest EV100 metering may expose with.
    autoExposureMax: f32,
}

// The light meter's reading, written by exposure.comp.wgsl.
struct DkMetering {
    log2Luminance: f32,
    sunIlluminance: vec3f,
}

@group(0) @binding(0) var<uniform> dkAtmosphere: DkAtmosphere;
@group(0) @binding(1) var<uniform> dkParams: DkSkyParams;
@group(0) @binding(2) var dkTransmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var dkSkyViewLut: texture_2d<f32>;
@group(0) @binding(4) var dkLutSampler: sampler;
@group(0) @binding(5) var dkMultiScatteringLut: texture_2d<f32>;
@group(0) @binding(6) var<storage, read> dkMetering: DkMetering;

// Triangular noise of one 8-bit step, added before the output is quantized: it trades the sky's smooth gradients'
// bands for grain too fine to see. A PCG hash of the pixel, so it is stable from frame to frame.
fn dkHash(p: vec2u) -> f32 {
    var v = p.x * 747796405u + p.y * 2891336453u;
    v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
    return f32((v >> 22u) ^ v) / 4294967295.0;
}

fn dkDither(color: vec3f, p: vec2u) -> vec3f {
    return color + (dkHash(p) - dkHash(p + vec2u(7919u, 104729u))) / 255.0;
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
// from how much the angles change from one pixel to the next.
fn dkDebugOverlay(color: vec3f, view: vec3f, right: vec3f, below: vec3f, apparentSun: vec3f, sunRadius: f32) -> vec3f {
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
    let sunAngle = length(view - apparentSun);
    let ring = dkLine(abs(sunAngle - max(sunRadius * 1.5, 6.0 * pixel)), pixel);

    // The ring as strong as the compass lines: part of the same grid.
    let grid = max(max(0.1 * altitudeLine, 0.3 * horizonLine), 0.15 * max(compassLine, ring));
    return mix(color, vec3f(1.0), grid);
}

// The exposure luminance in cd/m² is multiplied by. Metered, it is the light meter's EV100, log2(L * 100 / 12.5) for
// the average luminance L, less the compensation, held within its range.
fn dkExposure() -> f32 {
    if (dkParams.autoExposure != 0u) {
        let metered = dkMetering.log2Luminance + 3.0 - dkParams.exposureCompensation;
        return 1.0 / (1.2 * exp2(clamp(metered, dkParams.autoExposureMin, dkParams.autoExposureMax)));
    }
    return dkParams.exposure;
}

// Narkowicz's fit of the ACES filmic curve: a toe, a straight middle and a shoulder rolling off towards white, so the
// bright sky around the sun keeps its gradient. Then encoded for sRGB, which an 8-bit canvas expects. osgHimmel used
// Bruneton's curve, which had the encoding built in and was tuned for its own arbitrary units.
fn dkToneMap(exposed: vec3f) -> vec3f {
    let x = max(exposed, vec3f(0.0));
    let mapped = clamp(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
    return select(1.055 * pow(mapped, vec3f(1.0 / 2.4)) - 0.055, mapped * 12.92, mapped <= vec3f(0.0031308));
}

// Sky and sun disc transmittance for an observer inside the atmosphere, from the sky-view table.
struct DkSkySample {
    luminance: vec3f,
    // Transmittance along the ray towards the sun disc, zero where the planet is in the way.
    sunTransmittance: vec3f,
    hitsGround: bool,
    // The direction the ray leaves the atmosphere in, bent by the air: where the sun has to be to show in it.
    direction: vec3f,
}

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
    let texel = textureSampleLevel(dkSkyViewLut, dkLutSampler, uv, 0.0);
    result.luminance = texel.rgb;

    // Turned down within its vertical plane by the bending the table traced, stored as its sine.
    let horizontal = length(view.xy);
    result.direction = view;
    if (horizontal > 1e-6 && !result.hitsGround) {
        let down = vec3f(view.z * view.xy / horizontal, -horizontal);
        result.direction = view * sqrt(1.0 - texel.a * texel.a) + down * texel.a;
    }

    // Per ray rather than for the sun's center, so a disc half below the bent horizon still shows its upper half.
    let sunMu = result.direction.z;
    let sunTransmittance = dkSampleTransmittanceToTop(a, dkTransmittanceLut, dkLutSampler, a.Rg + h, sunMu);
    result.sunTransmittance = select(sunTransmittance, vec3f(0.0), result.hitsGround);
    return result;
}

// The same for an observer above the atmosphere, raymarched per pixel from where the ray enters it; beyond the table,
// which covers only altitudes inside.
fn dkSkyFromSpace(a: DkAtmosphere, view: vec3f, altitude: f32) -> DkSkySample {
    let ray = dkRaymarchFromSpace(
        a, dkTransmittanceLut, dkMultiScatteringLut, dkLutSampler, altitude, view, dkParams.sunDirection,
        DK_SAMPLES_SKY_VIEW,
    );
    var result: DkSkySample;
    result.luminance = ray.luminance;
    result.hitsGround = ray.hitsGround;
    result.direction = ray.direction;
    result.sunTransmittance = select(ray.transmittance, vec3f(0.0), ray.hitsGround);
    return result;
}

// The camera ray through a clip-space point, from the inverse view-projection. The matrix gives the camera's axis and
// its image plane; the image plane's radius rho then maps to the angle theta from the axis by a general perspective:
// the sphere of directions projected from a point d behind the eye, rho = (d + 1) sin(theta) / (d + cos(theta)).
// d = 0 is the matrix's own rectilinear projection, theta = atan(rho); d = 1 is stereographic, theta = 2 atan(rho / 2),
// which shows the whole sky as a disc looking up and a small planet looking down.
fn dkProjectRay(inverseViewProjection: mat4x4f, ndc: vec2f, d: f32) -> vec3f {
    let far = inverseViewProjection * vec4f(ndc, 1.0, 1.0);
    let point = far.xyz / far.w;
    if (d <= 0.0) {
        return normalize(point);
    }
    let centerFar = inverseViewProjection * vec4f(0.0, 0.0, 1.0, 1.0);
    let center = centerFar.xyz / centerFar.w;
    let offset = point - center;
    let rho = length(offset) / length(center);
    if (rho < 1e-7) {
        return normalize(center);
    }
    let k = rho / (d + 1.0);
    let cosTheta = (sqrt(1.0 + k * k * (1.0 - d * d)) - k * k * d) / (1.0 + k * k);
    let sinTheta = sqrt(max(1.0 - cosTheta * cosTheta, 0.0));
    return normalize(center) * cosTheta + normalize(offset) * sinTheta;
}

// The ray through the center of a pixel, top left first. The observer sits at the origin of this frame, so the point on
// the far plane is the direction.
fn dkPixelRay(pixel: vec2u, size: vec2u) -> vec3f {
    let uv = (vec2f(pixel) + 0.5) / vec2f(size);
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    return dkProjectRay(dkParams.inverseViewProjection, ndc, clamp(dkParams.projectionDistance, 0.0, 1.0));
}

// What the sky shows along a view ray, from the table inside the atmosphere or raymarched from above it.
fn dkSkyAt(view: vec3f) -> DkSkySample {
    let a = dkAtmosphere;
    let altitude = max(dkParams.observerAltitude, 0.0);
    if (altitude > a.Rt - a.Rg) {
        return dkSkyFromSpace(a, view, altitude);
    }
    return dkSkyFromInside(a, view, altitude);
}

// The sun disc along a sampled ray, attenuated by the air between it and the observer, from sun.wgsl.
fn dkSkySunLuminance(sky: DkSkySample) -> vec3f {
    return dkSunDiscLuminance(sky.sunTransmittance * dkAtmosphere.solarIrradiance, dkParams.sunAngularRadius);
}

fn dkSkySunCoverage(sky: DkSkySample, footprint: f32) -> f32 {
    return dkSunDiscCoverage(sky.direction, dkParams.sunDirection, dkParams.sunAngularRadius, footprint);
}

@compute @workgroup_size(8, 8, 1)
fn dkSky(@builtin(global_invocation_id) id: vec3u) {
    let size = dkOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    if (DK_CUBE) {
        var luminance = vec3f(0.0);
        for (var i = 0u; i < DK_CUBE_SAMPLES; i = i + 1u) {
            var offset = vec2f(0.0);
            if (DK_CUBE_SAMPLES == 8u) {
                offset = dkGoldenSet8[i];
            } else if (DK_CUBE_SAMPLES == 64u) {
                offset = dkGoldenSet64[i];
            }
            let point = dkCubePointAt(id.z, vec2f(id.xy) + 0.5 + offset, size.x);
            let sky = dkSkyAt(select(normalize(point), dkSphereFromCube(point), DK_CUBIFY));
            luminance = luminance + sky.luminance;
            if (DK_SUN_DISC) {
                luminance = luminance + dkSkySunLuminance(sky) * dkSkySunCoverage(sky, 0.0);
            }
        }
        dkOutputStore(id.xy, id.z, vec4f(luminance / f32(DK_CUBE_SAMPLES), 1.0));
        return;
    }

    let view = dkPixelRay(id.xy, size);
    let sunDirection = dkParams.sunDirection;
    let inSpace = dkParams.observerAltitude > dkAtmosphere.Rt - dkAtmosphere.Rg;
    let sky = dkSkyAt(view);
    let direction = sky.direction;
    let sunRadius = dkParams.sunAngularRadius;
    let right = dkPixelRay(id.xy + vec2u(1u, 0u), size);

    // In cd/m², exposed. Without tone mapping, that is what is written: linear, for the caller's own tone mapping.
    var color = sky.luminance * dkExposure();
    // The disc by how much of the pixel it covers. Tone mapped, sky and disc apart and mixed after, since the disc is
    // far beyond white: mixed before, a pixel it barely touches would turn white, and its edge would step.
    var disc = 0.0;
    if (DK_SUN_DISC) {
        disc = dkSkySunCoverage(sky, length(right - view));
    }
    if (DK_TONE_MAP) {
        let withDisc = dkToneMap(color + dkSkySunLuminance(sky) * dkExposure());
        color = mix(dkToneMap(color), withDisc, disc);
    } else {
        color = color + dkSkySunLuminance(sky) * dkExposure() * disc;
    }

    // The blue hour, an artistic term rather than a physical one, strongest when the sun sits just below the
    // horizon. The +0.03 keeps a faint blue cast through the night, as in the original.
    if (DK_TONE_MAP && dkParams.lHeureBleueIntensity > 0.0 && !sky.hitsGround && !inSpace) {
        let falloff = exp(-sunDirection.z * sunDirection.z * 166.0) + 0.03;
        color = color
            + dkParams.lHeureBleueIntensity * dkParams.lHeureBleueColor
            * (dot(direction, sunDirection) + 1.5) * falloff;
    }

    if (DK_DEBUG_GRID) {
        let below = dkPixelRay(id.xy + vec2u(0u, 1u), size);
        color = dkDebugOverlay(color, view, right, below, dkParams.apparentSunDirection, sunRadius);
    }
    if (DK_TONE_MAP && DK_DITHER) {
        color = clamp(dkDither(color, id.xy), vec3f(0.0), vec3f(1.0));
    }
    dkOutputStore(id.xy, 0u, vec4f(color, 1.0));
}
