// The sky render pass: a fullscreen triangle that turns the precomputed tables into pixels. Requires
// `atmosphere.wgsl`, `common.wgsl`, `lut.wgsl`, `sampling.wgsl`, `raymarch.wgsl` and `quality.wgsl`.
//
// Records into a render pass the caller owns and has already begun, so the sky composes with whatever else
// is being drawn under the caller's own blending and depth rules.

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
    exposure: f32,
    // The Sun's apparent angular radius, in radians.
    sunAngularRadius: f32,
    _padding0: f32,
    _padding1: f32,
    // Where the sun disc shows, lifted by refraction: the debug overlay's ring goes there.
    apparentSunDirection: vec3f,
    // The projection's d, from 0 (the matrix's own perspective) to 1 (stereographic), see dkProjectRay.
    projectionDistance: f32,
}

@group(0) @binding(0) var<uniform> dkAtmosphere: DkAtmosphere;
@group(0) @binding(1) var<uniform> dkParams: DkSkyParams;
@group(0) @binding(2) var dkTransmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var dkSkyViewLut: texture_2d<f32>;
@group(0) @binding(4) var dkLutSampler: sampler;
@group(0) @binding(5) var dkMultiScatteringLut: texture_2d<f32>;

struct DkVertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

// One oversized triangle rather than two triangles: no seam along the diagonal, and no vertex buffer.
@vertex
fn dkSkyVertex(@builtin(vertex_index) index: u32) -> DkVertexOutput {
    let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));

    var out: DkVertexOutput;
    out.position = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
    out.uv = vec2f(uv.x, 1.0 - uv.y);
    return out;
}

// Triangular noise of one 8-bit step, added before the output is quantized: it trades the sky's smooth gradients'
// bands for grain too fine to see. A PCG hash of the pixel, so it is stable from frame to frame.
fn dkHash(p: vec2u) -> f32 {
    var v = p.x * 747796405u + p.y * 2891336453u;
    v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
    return f32((v >> 22u) ^ v) / 4294967295.0;
}

fn dkDither(color: vec3f, pixel: vec2f) -> vec3f {
    let p = vec2u(pixel);
    return color + (dkHash(p) - dkHash(p + vec2u(7919u, 104729u))) / 255.0;
}

const DK_DEG_TO_RAD: f32 = 0.01745329251994330;

// Debug overlay, in the apparent (camera) frame: lines of altitude every 10 degrees with the horizon stronger, the
// eight compass directions up to 80 degrees, and a ring around the sun disc that shows where it is at any exposure.
fn dkLine(distance: f32, width: f32) -> f32 {
    return 1.0 - smoothstep(0.5 * width, 1.5 * width, distance);
}

fn dkDebugOverlay(color: vec3f, view: vec3f, apparentSun: vec3f, sunRadius: f32) -> vec3f {
    let altitude = asin(clamp(view.z, -1.0, 1.0)) / DK_DEG_TO_RAD;
    let azimuth = atan2(view.x, view.y) / DK_DEG_TO_RAD;
    // The azimuth jumps by 360 degrees due south, so its derivative is taken from the opposite direction there too.
    let azimuthWidth = min(fwidth(azimuth), fwidth(atan2(-view.x, -view.y) / DK_DEG_TO_RAD));
    let altitudeWidth = fwidth(altitude);
    let pixel = length(fwidth(view));

    let altitudeLine = dkLine(abs(fract(altitude / 10.0 + 0.5) - 0.5) * 10.0, altitudeWidth);
    let horizonLine = dkLine(abs(altitude), 1.5 * altitudeWidth);
    // Measured along the circle of altitude, so the lines keep their width as they converge towards the zenith.
    let compassDistance = abs(fract(azimuth / 45.0 + 0.5) - 0.5) * 45.0 * cos(altitude * DK_DEG_TO_RAD);
    let compassLine = dkLine(compassDistance, azimuthWidth * cos(altitude * DK_DEG_TO_RAD))
        * (1.0 - smoothstep(70.0, 80.0, abs(altitude)));
    // At least a few pixels wide, so it still finds the Sun in a wide view, where its disc is a dot.
    let sunAngle = length(view - apparentSun);
    let ring = dkLine(abs(sunAngle - max(sunRadius * 1.5, 6.0 * pixel)), pixel);

    let grid = max(max(0.1 * altitudeLine, 0.3 * horizonLine), 0.15 * compassLine);
    return mix(mix(color, vec3f(1.0), grid), vec3f(1.0, 0.8, 0.2), 0.7 * ring);
}

// Bruneton's tone curve, as osgHimmel used it: a gamma ramp in the low range and an exponential rolloff
// above, which keeps the sun's surroundings from clipping to white while leaving twilight readable.
fn dkToneMapChannel(value: f32) -> f32 {
    if (value < 1.413) {
        return pow(value * 0.38317, 1.0 / 2.2);
    }
    return 1.0 - exp(-value);
}

fn dkToneMap(luminance: vec3f, exposure: f32) -> vec3f {
    let scaled = luminance * exposure;
    return vec3f(dkToneMapChannel(scaled.r), dkToneMapChannel(scaled.g), dkToneMapChannel(scaled.b));
}

// Sky and sun disc transmittance for an observer inside the atmosphere, from the sky-view table.
struct DkSkySample {
    luminance: vec3f,
    // Transmittance towards the sun disc along the ray, zero where the planet is in the way.
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

    let sunMu = dkParams.sunDirection.z;
    let sunTransmittance = dkSampleTransmittanceToTop(a, dkTransmittanceLut, dkLutSampler, a.Rg + h, sunMu);
    result.sunTransmittance = select(sunTransmittance, vec3f(0.0), result.hitsGround);
    return result;
}

// The same for an observer above the atmosphere, raymarched per pixel from where the ray enters it; beyond the table,
// which covers only altitudes inside.
fn dkSkyFromSpace(a: DkAtmosphere, view: vec3f, altitude: f32) -> DkSkySample {
    var result: DkSkySample;
    result.direction = view;
    result.hitsGround = false;
    result.luminance = vec3f(0.0);
    result.sunTransmittance = vec3f(1.0);

    let top = a.Rt - a.Rg;
    let rc = a.Rg + altitude;
    let b = rc * view.z;
    // The discriminant of the ray and the atmosphere's sphere, rc^2 - Rt^2 factored as for dkRhoSquared.
    let discriminant = b * b - (altitude - top) * (rc + a.Rt);
    if (discriminant < 0.0 || b >= 0.0) {
        return result;
    }

    let entry = vec3f(0.0, 0.0, rc) + view * (-b - sqrt(discriminant));
    let ray = dkRaymarchSky(
        a, dkTransmittanceLut, dkMultiScatteringLut, dkLutSampler, normalize(entry), top, view, dkParams.sunDirection,
        DK_SAMPLES_SKY_VIEW, true,
    );
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

@fragment
fn dkSkyFragment(input: DkVertexOutput) -> @location(0) vec4f {
    let a = dkAtmosphere;

    // Fragment back to a world-space ray. The observer sits at the origin of this frame, so the point on the
    // far plane is the direction.
    let ndc = vec2f(input.uv.x * 2.0 - 1.0, 1.0 - input.uv.y * 2.0);
    let view = dkProjectRay(dkParams.inverseViewProjection, ndc, clamp(dkParams.projectionDistance, 0.0, 1.0));
    let sunDirection = dkParams.sunDirection;

    let altitude = max(dkParams.observerAltitude, 0.0);
    let inSpace = altitude > a.Rt - a.Rg;
    var sky: DkSkySample;
    if (inSpace) {
        sky = dkSkyFromSpace(a, view, altitude);
    } else {
        sky = dkSkyFromInside(a, view, altitude);
    }
    let direction = sky.direction;
    var luminance = sky.luminance;

    // The sun disc, attenuated by the air between it and the observer. Its radiance is the irradiance spread over the
    // disc's solid angle, some 15000 times brighter than the sky. Tested by the chord between the two unit vectors,
    // which equals the angle this close: a test against cos(radius) would need cos to 1e-5, and WGSL promises it only
    // to 2^-11.
    let sunRadius = dkParams.sunAngularRadius;
    if (length(direction - sunDirection) < sunRadius) {
        luminance = luminance + sky.sunTransmittance * a.solarIrradiance / (DK_PI * sunRadius * sunRadius);
    }

    var color = dkToneMap(luminance, dkParams.exposure);

    // The blue hour, an artistic term rather than a physical one, strongest when the sun sits just below the
    // horizon. The +0.03 keeps a faint blue cast through the night, as in the original.
    if (dkParams.lHeureBleueIntensity > 0.0 && !sky.hitsGround && !inSpace) {
        let falloff = exp(-sunDirection.z * sunDirection.z * 166.0) + 0.03;
        color = color
            + dkParams.lHeureBleueIntensity * dkParams.lHeureBleueColor
            * (dot(direction, sunDirection) + 1.5) * falloff;
    }

    if (DK_DEBUG_GRID) {
        color = dkDebugOverlay(color, view, dkParams.apparentSunDirection, sunRadius);
    }
    if (DK_DITHER) {
        color = dkDither(color, input.position.xy);
    }
    return vec4f(color, 1.0);
}
