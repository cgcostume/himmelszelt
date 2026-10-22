// The sky pass: a compute pass that turns the precomputed tables into pixels, one invocation per pixel of the target,
// with no rasterization. Requires `atmosphere.wgsl`, `common.wgsl`, `lut.wgsl`, `sampling.wgsl`, `raymarch.wgsl`,
// `cube.wgsl`, `panorama.wgsl`, `sun.wgsl`, `tonemap.wgsl`, `grid.wgsl`, `frame.wgsl`, `quality.wgsl` and
// `features.wgsl`, plus the output at group 1, `dkOutputSize` and `dkOutputStore`, declared by whoever builds the
// pipeline since its format has to be spelled out: `skyOutput(format)` for an image or a panorama,
// `skyCubeOutput(format)` for a cube map's six faces.
//
// For an image, it writes every pixel, so the sky goes first, as the background the rest of the frame is drawn over.
// For a cube map, with DK_CUBE, or a panorama, with DK_PANORAMA, it writes the luminance itself, in cd/m², neither
// exposed nor tone mapped, or times skyViewScale with DK_CUBE_SCALED.

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

// The grid in white, over the sky (see grid.wgsl).
fn dkDebugOverlay(color: vec3f, view: vec3f, right: vec3f, below: vec3f) -> vec3f {
    let sun = dkParams.sunDirection;
    return dkGridOverlay(color, view, right, below, vec3f(1.0), sun, dkParams.sunAngularRadius, dkParams.pixelRatio);
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

// For an observer inside the atmosphere, from the sky-view table, at the altitude it was built for.
fn dkSkyFromInside(a: DkAtmosphere, view: vec3f) -> DkSkySample {
    var result: DkSkySample;
    // The observer's horizon, written by the light meter whenever the table is rebuilt: of the altitude alone.
    let horizon = dkMetering.horizon.xyz;
    result.hitsGround = dkBelowHorizon(horizon, view.z);

    // Azimuth measured from the sun, the frame the sky-view table is indexed in. Degenerate when either vector points
    // straight up, where azimuth is meaningless and any value gives the same lookup.
    let sunH = dkParams.sunDirection.xy;
    var cosAzimuth = 1.0;
    if (length(view.xy) > 1e-6 && length(sunH) > 1e-6) {
        cosAzimuth = clamp(dot(normalize(view.xy), normalize(sunH)), -1.0, 1.0);
    }

    let size = vec2f(textureDimensions(dkSkyViewLut));
    var uv = dkSkyViewUvAt(horizon, view.z, cosAzimuth, size);
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

// The sun disc's luminance along a sampled ray, attenuated by the air between it and the observer, from sun.wgsl.
fn dkSkySunLuminance(sky: DkSkySample) -> vec3f {
    let illuminance = dkToRgb(dkAtmosphere, dkSkySunTransmittance(sky) * dkAtmosphere.solarIlluminance);
    return dkSunDiscLuminance(illuminance, dkParams.sunAngularRadius);
}

fn dkSkySunCoverage(sky: DkSkySample, footprint: f32) -> f32 {
    return dkSunDiscCoverage(sky.direction, dkParams.sunDirection, dkParams.sunAngularRadius, footprint);
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
            result.sun = result.sun + dkSkySunLuminance(ray);
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
    let point = dkCubePointAt(face, position, size);
    return select(normalize(point), dkSphereFromCube(point), DK_CUBIFY);
}

// How far the cosine of the zenith angle runs across a ray's share of its texel, a square 1 / sqrt(rays) of a texel on a
// side, from the rays through its corners.
fn dkCellOf(view: vec3f, across: vec3f, down: vec3f) -> f32 {
    return abs(across.z - view.z) + abs(down.z - view.z);
}

// Offsets within a cube map's or a panorama's texel for its rays, in [-0.5, 0.5): eight at a time, each a point of
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
        luminance = luminance + dkSkyRayLuminance(view, sky, cell);
        if (DK_SUN_DISC && dkSkySunCoverage(sky, 0.0) > 0.0) {
            luminance = luminance + dkSkySunLuminance(sky);
        }
    }
    return luminance / f32(DK_SAMPLES_CUBE) * select(1.0, dkParams.skyViewScale, DK_CUBE_SCALED);
}

// The ground, as the sky pass shows it straight down, the nadir of a cube map: the fisheye's corner, where it sends
// every direction below the horizon.
fn dkPanoramaFill() -> vec3f {
    return dkSkyAt(vec3f(0.0, 0.0, -1.0)).luminance;
}

// A texel of a panorama, as a cube map's: the mean of its rays, and in alpha the share of them within the projection,
// 1 but around the fisheye's and the sphere map's circle. Beyond the circle, the rays are those of its rim, as
// dkPanoramaDirection takes them: the horizon at their azimuth for the fisheye, the nadir for the sphere map, so a
// lookup filtered across the rim blends into what lies there rather than into the ground or black. The fisheye's top
// left corner texel alone holds dkPanoramaFill.
fn dkPanoramaTexel(texel: vec2u, size: vec2u) -> vec4f {
    let scale = select(1.0, dkParams.skyViewScale, DK_CUBE_SCALED);
    if (DK_PANORAMA == DK_FISHEYE && all(texel == vec2u(0u))) {
        return vec4f(dkPanoramaFill() * scale, 0.0);
    }
    let round = DK_PANORAMA == DK_FISHEYE || DK_PANORAMA == DK_SPHERE_MAP;
    var luminance = vec3f(0.0);
    var inside = 0u;
    let side = inverseSqrt(f32(DK_SAMPLES_CUBE)) / vec2f(size);
    for (var i = 0u; i < DK_SAMPLES_CUBE; i = i + 1u) {
        let uv = (vec2f(texel) + 0.5 + dkTexelOffset(i)) / vec2f(size);
        let view = dkPanoramaDirection(DK_PANORAMA, uv, DK_PANORAMA_AZIMUTH_OFFSET);
        let sky = dkSkyAt(view);
        let cell = dkCellOf(
            view,
            dkPanoramaDirection(DK_PANORAMA, uv + vec2f(side.x, 0.0), DK_PANORAMA_AZIMUTH_OFFSET),
            dkPanoramaDirection(DK_PANORAMA, uv + vec2f(0.0, side.y), DK_PANORAMA_AZIMUTH_OFFSET),
        );
        luminance = luminance + dkSkyRayLuminance(view, sky, cell);
        if (DK_SUN_DISC && dkSkySunCoverage(sky, 0.0) > 0.0) {
            luminance = luminance + dkSkySunLuminance(sky);
        }
        inside = inside + select(1u, 0u, round && length(uv * 2.0 - 1.0) > 1.0);
    }
    return vec4f(luminance / f32(DK_SAMPLES_CUBE) * scale, f32(inside) / f32(DK_SAMPLES_CUBE));
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
    if (DK_PANORAMA != 0u) {
        dkOutputStore(id.xy, 0u, dkPanoramaTexel(id.xy, size));
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

    // In cd/m², exposed. Without tone mapping, that is what is written: linear, for the caller's own tone mapping.
    let exposure = dkExposure();
    var color = luminance * exposure;
    // The disc by how much of the pixel it covers, on the sky's part of it, looked up only there. Tone mapped, sky and
    // disc apart and mixed after, since the disc is far beyond white: mixed before, a pixel it barely touches would
    // turn white, and its edge would step.
    if (!DK_SUN_DISC) {
        disc = 0.0;
    } else if (disc < 0.0) {
        disc = dkSkySunCoverageOfPixel(sky, id.xy, size, footprint) * (1.0 - ground);
        if (disc > 0.0) {
            sunLuminance = dkSkySunLuminance(sky);
        }
    }
    let sun = sunLuminance * exposure;
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
        color = dkDebugOverlay(color, view, right, below);
    }
    if (DK_TONE_MAP != 0u && DK_DITHER) {
        color = clamp(dkDither(color, id.xy), vec3f(0.0), dkEncodeSrgbExtended(vec3f(DK_HEADROOM), DK_HEADROOM));
    }
    dkOutputStore(id.xy, 0u, vec4f(color, select(1.0, disc, DK_TONE_MAP == 0u && DK_DISC_ALPHA)));
}
