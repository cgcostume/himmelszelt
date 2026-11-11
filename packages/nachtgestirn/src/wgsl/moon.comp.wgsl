// The Moon's disc along every pixel's ray, over a background in cd/m² where there is one, then exposed and tone mapped
// like dunstkreis' sky, or left linear. Requires `params.wgsl`, `camera.wgsl` (dunstkreis'), `surface.wgsl`,
// `tonemap.wgsl` and `vision.wgsl` (helldunkel's) and the output binding from `moonOutput`.

@group(0) @binding(0) var<uniform> ngParams: NgParams;
@group(0) @binding(1) var ngColorMap: texture_2d<f32>;
@group(0) @binding(2) var ngReliefMap: texture_2d<f32>;
@group(0) @binding(3) var ngMapSampler: sampler;
@group(0) @binding(4) var ngBackground: texture_2d<f32>;
// A strip of the maps at a finer size, where `ngParams.detailRegion` says, read instead of the whole maps within it.
@group(0) @binding(5) var ngDetailColor: texture_2d<f32>;
@group(0) @binding(6) var ngDetailRelief: texture_2d<f32>;
// What of the Sun the terrain leaves each point of the band around the terminator, from `shadow.comp.wgsl`.
@group(0) @binding(7) var ngShadowMap: texture_2d<f32>;
// The Moon alone, linear and premultiplied, as the layer pass wrote it: what `shimmer.comp.wgsl` moves about.
@group(0) @binding(8) var ngLayer: texture_2d<f32>;

// Tone map for a display by Neutral (1), AgX (2), ACES (3) or none (4); 0 writes the exposed luminance, linear.
override NG_TONE_MAP: u32 = 1u;
override NG_HEADROOM: f32 = 1.0;
override NG_DITHER: bool = true;
// Whether a background is bound; without one the Moon alone is written, premultiplied, with its coverage in alpha.
override NG_BACKGROUND: bool = true;
// The composed light as the eye sees it at night, with a background: the rods' blue shift, `hdNightVision`.
override NG_NIGHT_VISION: bool = false;
// The Moon alone, linear and premultiplied, its coverage in alpha, for the shimmer's pass to move about and finish.
override NG_LAYER: bool = false;

// The flags and the laws fixed when the pipeline is made, where NG_FIXED: a pipeline specialized to them, which leaves
// out all the rest. Else read from `ngParams`, one pipeline for everything.
override NG_FIXED: bool = false;
override NG_FIXED_FLAGS: u32 = 0u;
override NG_FIXED_LAW: u32 = 0u;
override NG_FIXED_COMPARE_LAW: u32 = 0u;

fn ngFlag(flag: u32) -> bool {
    return (select(ngParams.flags, NG_FIXED_FLAGS, NG_FIXED) & flag) != 0u;
}

fn ngToneMap(exposed: vec3f) -> vec3f {
    if (NG_TONE_MAP == 2u) {
        return hdToneMapAgx(exposed);
    }
    if (NG_TONE_MAP == 3u) {
        return hdToneMapAces(exposed);
    }
    if (NG_TONE_MAP == 4u) {
        return hdToneMapClipHdr(exposed, NG_HEADROOM);
    }
    return hdToneMapNeutralHdr(exposed, NG_HEADROOM);
}

// The ray through a point of the target, in pixels from its top left corner, on dunstkreis' camera.
fn ngPixelRay(position: vec2f, size: vec2u) -> vec3f {
    let uv = position / vec2f(size);
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    return dkProjectRay(ngParams.inverseViewProjection, ndc, clamp(ngParams.projectionDistance, 0.0, 1.0));
}

// A map magnified, by a cubic B-spline in four bilinear taps after Sigg and Hadwiger, so the texels' edges do not show
// as steps along the terminator.
fn ngSampleBicubic(map: texture_2d<f32>, uv: vec2f) -> vec3f {
    let size = vec2f(textureDimensions(map));
    let texel = uv * size - 0.5;
    let f = fract(texel);
    let f2 = f * f;
    let f3 = f2 * f;
    let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    let w3 = f3 / 6.0;
    let g0 = w0 + w1;
    let g1 = w2 + w3;
    let base = floor(texel) + 0.5;
    let t0 = (base - 1.0 + w1 / g0) / size;
    let t1 = (base + 1.0 + w3 / g1) / size;
    let a = textureSampleLevel(map, ngMapSampler, vec2f(t0.x, t0.y), 0.0).rgb;
    let b = textureSampleLevel(map, ngMapSampler, vec2f(t1.x, t0.y), 0.0).rgb;
    let c = textureSampleLevel(map, ngMapSampler, vec2f(t0.x, t1.y), 0.0).rgb;
    let d = textureSampleLevel(map, ngMapSampler, vec2f(t1.x, t1.y), 0.0).rgb;
    return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
}

// The directions east and north along the surface at a point of the unit sphere in the Moon's frame, and the cosine of
// its latitude, the parallel's radius.
struct NgLocal {
    east: vec3f,
    north: vec3f,
    parallel: f32,
}

fn ngLocal(body: vec3f) -> NgLocal {
    let parallel = max(length(body.xy), 1e-4);
    let east = vec3f(-body.y, body.x, 0.0) / parallel;
    return NgLocal(east, cross(body, east), parallel);
}

// How far in the map's uv a step `t` along the surface is: east stretched by the parallels' shrinking.
fn ngUvStep(local: NgLocal, t: vec3f) -> vec2f {
    return vec2f(dot(t, local.east) / local.parallel / (2.0 * NG_PI), -dot(t, local.north) / NG_PI);
}

// A map over a ray's footprint: by the B-spline where it is magnified, else filtered anisotropically by the hardware
// over the footprint's two axes in uv, up to sixteen taps along the long one. Towards the poles the parallels crowd
// the texels together east to west, and at the limb the slant stretches the footprint: an isotropic mip level would
// take the longest of both and blur what the other axis still resolves. `dx` and `dy` the footprint's axes in uv.
fn ngSampleIn(map: texture_2d<f32>, uv: vec2f, dx: vec2f, dy: vec2f) -> vec3f {
    let size = vec2f(textureDimensions(map));
    let texels = max(length(dx * size), length(dy * size));
    // Blended over a band around a texel to a footprint, so no seam shows where the one hands over to the other.
    if (!NG_MAP_BSPLINE || texels >= 1.25) {
        return textureSampleGrad(map, ngMapSampler, uv, dx, dy).rgb;
    }
    let spline = ngSampleBicubic(map, uv);
    if (texels <= 0.75) {
        return spline;
    }
    return mix(spline, textureSampleGrad(map, ngMapSampler, uv, dx, dy).rgb, (texels - 0.75) / 0.5);
}

// Where a point of the whole maps lies in the detail strip, in the strip's own uv, or -1 outside it or without one: a
// few texels in from its edges, so neither the filter nor the B-spline reaches past them.
fn ngDetailUv(uv: vec2f) -> vec2f {
    let r = ngParams.detailRegion;
    if (r.z <= r.x) {
        return vec2f(-1.0);
    }
    let local = (uv - r.xy) / (r.zw - r.xy);
    let margin = 4.0 / vec2f(textureDimensions(ngDetailRelief));
    if (any(local < margin) || any(local > 1.0 - margin)) {
        return vec2f(-1.0);
    }
    return local;
}

// How many texels of the strip's relief make one of the whole relief's, as log2: what a level is shifted by.
fn ngDetailLevels() -> f32 {
    let r = ngParams.detailRegion;
    return log2(f32(textureDimensions(ngDetailRelief).y) / (r.w - r.y) / f32(textureDimensions(ngReliefMap).y));
}

fn ngSampleMap(map: texture_2d<f32>, detail: texture_2d<f32>, body: vec3f, footprint: NgFootprint) -> vec3f {
    let uv = ngMapUv(ngSelenographic(body));
    let local = ngLocal(body);
    let dx = ngUvStep(local, footprint.across);
    let dy = ngUvStep(local, footprint.along);
    let inDetail = ngDetailUv(uv);
    if (inDetail.x >= 0.0) {
        let scale = 1.0 / (ngParams.detailRegion.zw - ngParams.detailRegion.xy);
        return ngSampleIn(detail, inDetail, dx * scale, dy * scale);
    }
    return ngSampleIn(map, uv, dx, dy);
}

// The color map at a point, sRGB-encoded.
fn ngColorAt(body: vec3f, footprint: NgFootprint) -> vec3f {
    return ngSampleMap(ngColorMap, ngDetailColor, body, footprint);
}

// Whether a point lies in the detail strip, where the relief's levels and texels are the strip's.
fn ngInDetail(body: vec3f) -> bool {
    return ngDetailUv(ngMapUv(ngSelenographic(body))).x >= 0.0;
}

// The height at a point in km, and the slope there as a vector along the surface, in the Moon's frame, km per km.
fn ngReliefAt(body: vec3f, footprint: NgFootprint) -> vec4f {
    let relief = ngSampleMap(ngReliefMap, ngDetailRelief, body, footprint);
    let local = ngLocal(body);
    return vec4f(relief.x, relief.y * local.east + relief.z * local.north);
}

// The relief's height at a level: by the B-spline where the level is the finest, so the terrain the shadows are marched
// through is smooth and their edges do not follow the texels' creases, bilinearly between levels above it.
fn ngHeightIn(map: texture_2d<f32>, uv: vec2f, level: f32) -> f32 {
    if (level < 0.5) {
        return ngSampleBicubic(map, uv).x;
    }
    return textureSampleLevel(map, ngMapSampler, uv, level).x;
}

// The height at a point at a level, the strip's where `fine`; past the strip the whole relief's, the level turned.
fn ngHeightAt(body: vec3f, level: f32, fine: bool) -> f32 {
    let uv = ngMapUv(ngSelenographic(body));
    if (fine) {
        let local = ngDetailUv(uv);
        if (local.x >= 0.0) {
            return ngHeightIn(ngDetailRelief, local, level);
        }
        return ngHeightIn(ngReliefMap, uv, max(level - ngDetailLevels(), 0.0));
    }
    return ngHeightIn(ngReliefMap, uv, level);
}

// A texel of the relief along the equator, in km, the strip's where `fine`.
fn ngReliefTexelKm(fine: bool) -> f32 {
    let texel = 2.0 * NG_PI * ngParams.moonRadiusKm / f32(textureDimensions(ngReliefMap).x);
    return select(texel, texel * exp2(-ngDetailLevels()), fine);
}

// What of the sunlight reaches a point of the Moon through Earth's shadow, per channel: the share of the Sun's disc
// Earth leaves uncovered, seen from that point, plus what its atmosphere bends into the umbra, red in the middle, with
// the turquoise rim ozone leaves where the light passed the stratosphere. `pointKm` from Earth's center.
fn ngShadow(pointKm: vec3f) -> vec3f {
    let distanceKm = length(pointKm);
    let toEarth = -pointKm / distanceKm;
    // The Sun's and Earth's discs as that point sees them, and the angle between their centers.
    let earthRadius = asin(min(ngParams.earthRadiusKm / distanceKm, 1.0));
    let sunRadius = ngParams.sunAngularRadius;
    let separation = acos(clamp(dot(toEarth, -ngParams.shadowAxis), -1.0, 1.0));
    let covered = ngLens(earthRadius, sunRadius, separation) / (NG_PI * sunRadius * sunRadius);
    let direct = vec3f(1.0 - covered);
    // What the air adds, from the table over the distance from the axis, the axis to the penumbra's edge.
    let axisKm = length(pointKm - dot(pointKm, ngParams.shadowAxis) * ngParams.shadowAxis);
    let x = axisKm / max(ngParams.penumbraKm, 1.0) * f32(NG_UMBRA_SAMPLES - 1u);
    if (x >= f32(NG_UMBRA_SAMPLES - 1u)) {
        return direct;
    }
    let i = u32(floor(x));
    let refracted = mix(ngParams.umbraTable[i].rgb, ngParams.umbraTable[i + 1u].rgb, fract(x));
    return direct + refracted * ngParams.umbraLight;
}

struct NgMoon {
    // The disc's luminance along the ray, in cd/m², and how much of the pixel it covers.
    luminance: vec3f,
    coverage: f32,
    // The luminance to hold it against: under `compareLaw` with NG_FLAG_COMPARE, with the Sun's disc's soft shadows
    // where NG_FLAG_COMPARE_SHADOWS draws a point Sun's hard ones, or both.
    reference: vec3f,
}

// Where a ray seen at `altitude` falls in the table: the entry below it and the share of the next.
fn ngTableAt(altitude: f32) -> vec2f {
    let x = clamp((altitude - ngParams.refractionFrom) / ngParams.refractionStep, 0.0, f32(NG_REFRACTION_SAMPLES - 1u));
    let i = min(floor(x), f32(NG_REFRACTION_SAMPLES - 2u));
    return vec2f(i, x - i);
}

// How far the air bends a ray seen at `altitude` down, in radians, read from the table between its entries.
fn ngBend(altitude: f32) -> f32 {
    let at = ngTableAt(altitude);
    let i = u32(at.x);
    let a = ngParams.refraction[i / 4u][i % 4u];
    let b = ngParams.refraction[(i + 1u) / 4u][(i + 1u) % 4u];
    return mix(a, b, at.y);
}

// What the air lets through along `view`, per channel: from the table where it has transmittances, else the one given.
fn ngTransmittance(view: vec3f) -> vec3f {
    if (!ngFlag(NG_FLAG_AIR) || ngParams.refractionStep <= 0.0) {
        return ngParams.transmittance;
    }
    let at = ngTableAt(atan2(view.z, length(view.xy)));
    let i = u32(at.x);
    return mix(ngParams.airTransmittance[i].rgb, ngParams.airTransmittance[i + 1u].rgb, at.y);
}

// The ray as it left the atmosphere: turned down within its vertical plane by the bend the air gave it, the way
// dunstkreis bends its rays to find the sun disc. The lower limb is lifted more than the upper, so the disc shows
// squeezed near the horizon, and a ray that ends on the ground meets no Moon.
fn ngUnbend(view: vec3f) -> vec3f {
    let horizontal = length(view.xy);
    if (ngParams.refractionStep <= 0.0 || horizontal < 1e-6) {
        return view;
    }
    let apparent = atan2(view.z, horizontal);
    let altitude = apparent - ngBend(apparent);
    return vec3f(view.xy / horizontal * cos(altitude), sin(altitude));
}

// Up to which elevation over its horizontal the Sun can still be hidden from a point by the terrain, in radians: no
// crater rim or mountain stands steeper above a point than some 25°. Above it, no march.
const NG_SHADOW_ELEVATION: f32 = 0.45;
// Steps towards the Sun, each this much farther than the last, from three quarters of a texel on: 24 of them reach
// some 450 km on the 4096 texel map, as far as a mountain's shadow runs with the Sun a degree up.
const NG_SHADOW_STEPS: u32 = 24u;
const NG_SHADOW_GROWTH: f32 = 1.26;

// How much of the Sun's disc stands above the terrain's horizon towards it, seen from a point of the surface: the
// relief marched along the great circle towards the Sun, the highest elevation the terrain reaches above the point's
// horizontal, and the share of the Sun's disc above it. Near what casts it that angle changes fast and the shadow's
// edge is sharp; far from it slowly, and the penumbra widens with the distance, as the Sun's half degree makes it.
// `up` the point's direction and `sun` the Sun's, in the Moon's frame; `height` its height in km; `lod` its level.
// The Sun's size the shadow map's, a point for a small disc. Its share, and a point Sun's, 0 or 1, to compare.
fn ngSunAboveTerrain(up: vec3f, sun: vec3f, height: f32, lod: f32, fine: bool) -> vec2f {
    let radius = max(ngParams.shadowWindow.w, 1e-7);
    let horizon = ngHorizon(up, sun, height, lod, fine, radius);
    return vec2f(ngDiscAbove(horizon, radius), select(0.0, 1.0, horizon.y < horizon.x));
}

// The same for any direction, a disc of `radius` around it: the Sun's, or the viewer's, a point.
fn ngAboveTerrain(up: vec3f, sun: vec3f, height: f32, lod: f32, fine: bool, radius: f32) -> f32 {
    return ngDiscAbove(ngHorizon(up, sun, height, lod, fine, radius), radius);
}

// The share of a disc of `radius` above the terrain, from `ngHorizon`: above a line through it, the line x radii below
// its center.
fn ngDiscAbove(horizon: vec2f, radius: f32) -> f32 {
    let x = clamp((horizon.x - horizon.y) / radius, -1.0, 1.0);
    return 0.5 + (x * sqrt(1.0 - x * x) + asin(x)) / NG_PI;
}

// The elevation of a direction over a point's horizontal and the terrain's highest towards it, in radians: the march
// stops once the terrain stands `radius` above the direction, where nothing of a disc that wide is left.
fn ngHorizon(up: vec3f, sun: vec3f, height: f32, lod: f32, fine: bool, radius: f32) -> vec2f {
    let elevation = asin(clamp(dot(sun, up), -1.0, 1.0));
    let along = sun - dot(sun, up) * up;
    if (elevation > NG_SHADOW_ELEVATION || length(along) < 1e-6) {
        return vec2f(elevation, -0.5 * NG_PI);
    }
    let toward = normalize(along);
    let texelKm = ngReliefTexelKm(fine);
    let origin = (ngParams.moonRadiusKm + height) * up;
    // The terrain's steepest rise towards the Sun, as a tangent: every step lies ahead, so its angle is the tangent's.
    let enough = tan(elevation + radius);
    var slope = -1e30;
    var distanceKm = 0.75 * texelKm;
    for (var k = 0u; k < NG_SHADOW_STEPS && slope <= enough; k = k + 1u) {
        let angle = distanceKm / ngParams.moonRadiusKm;
        let q = up * cos(angle) + toward * sin(angle);
        // Read as coarse as the steps are apart, so no peak falls between two of them.
        let h = ngHeightAt(q, max(lod, log2(distanceKm * 0.3 / texelKm)), fine);
        let to = (ngParams.moonRadiusKm + h) * q - origin;
        slope = max(slope, dot(to, up) / dot(to, toward));
        distanceKm = distanceKm * NG_SHADOW_GROWTH;
    }
    return vec2f(elevation, atan(slope));
}

// The band the shadow map covers, as angles from the subsolar point: from where the Sun stands too high for any slope to
// hide it to where it has set for the highest peak, some 11 km up, a little more than six degrees past the terminator.
const NG_BAND_FROM: f32 = NG_PI / 2.0 - NG_SHADOW_ELEVATION;
const NG_BAND_TO: f32 = NG_PI / 2.0 + 0.12;

// A point of the Moon's unit sphere in the shadow map's frame: its longitude about the Sun from the window's first, in
// [0, 2π), and its angle from the subsolar point. The frame as `shadow.comp.wgsl` lays it out.
fn ngBandAt(point: vec3f) -> vec2f {
    let toSun = ngParams.shadowSun.xyz;
    let axisX = ngParams.shadowEast.xyz;
    let axisY = cross(toSun, axisX);
    let longitude = atan2(dot(point, axisY), dot(point, axisX)) - ngParams.shadowEast.w;
    let fromSubsolar = acos(clamp(dot(point, toSun), -1.0, 1.0));
    return vec2f(longitude - floor(longitude / (2.0 * NG_PI)) * 2.0 * NG_PI, fromSubsolar);
}

// The share of the Sun's disc a point sees above the terrain, from the shadow map, and a point Sun's: lit before the
// band, dark past it, and outside the window, which holds only what the view shows, lit on the day side.
fn ngShadowAt(body: vec3f) -> vec2f {
    let band = ngBandAt(body);
    if (band.y < NG_BAND_FROM) {
        return vec2f(1.0);
    }
    if (band.y > NG_BAND_TO) {
        return vec2f(0.0);
    }
    let texel = vec2f(band.x, band.y - ngParams.shadowWindow.x) / ngParams.shadowSun.w;
    if (texel.x > ngParams.shadowWindow.y || texel.y < 0.0 || texel.y > ngParams.shadowWindow.z) {
        return vec2f(select(0.0, 1.0, band.y < NG_PI / 2.0));
    }
    // Between the four nearest texels, by hand: the map is larger than its window, rounded up, and a sampler would mix in
    // the texels past its edges. The whole ring wraps around, a window stops at its edges.
    let size = vec2i(i32(ngParams.shadowWindow.y), i32(ngParams.shadowWindow.z));
    let ring = ngParams.shadowWindow.y * ngParams.shadowSun.w >= 2.0 * NG_PI - 1e-4;
    let q = texel - 0.5;
    let first = vec2i(floor(q));
    let t = q - floor(q);
    var xs = vec2i(first.x, first.x + 1);
    if (ring) {
        xs = (xs % size.x + size.x) % size.x;
    } else {
        xs = clamp(xs, vec2i(0), vec2i(size.x - 1));
    }
    let ys = clamp(vec2i(first.y, first.y + 1), vec2i(0), vec2i(size.y - 1));
    let a = textureLoad(ngShadowMap, vec2i(xs.x, ys.x), 0).rg;
    let b = textureLoad(ngShadowMap, vec2i(xs.y, ys.x), 0).rg;
    let c = textureLoad(ngShadowMap, vec2i(xs.x, ys.y), 0).rg;
    let d = textureLoad(ngShadowMap, vec2i(xs.y, ys.y), 0).rg;
    return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

// How far the relief reaches below and above the mean radius, in km: Antoniadi's floor and the Selenean summit.
const NG_HEIGHT_MIN_KM: f32 = -9.2;
const NG_HEIGHT_MAX_KM: f32 = 10.8;
const NG_DISPLACE_STEPS: u32 = 96u;

// A ray against the Moon's sphere at unit distance, kept well conditioned: the ray and the direction to the center are
// nearly parallel, and their dot product, near 1, keeps only some five digits of the angle between them, steps of a
// third of a percent of the radius, which showed as stairs in a large disc. Their difference keeps all of f32's. `w`
// from the ray to the center, `w2` its square, `s2` the square of the ray's distance from the center and `angle` the
// angle between them. Points along the ray are `ngAlong(ray, tau)`, tau the distance past unit distance.
struct NgRay {
    v: vec3f,
    w: vec3f,
    w2: f32,
    s2: f32,
    angle: f32,
}

fn ngRayOf(v: vec3f) -> NgRay {
    let w = ngParams.direction - v;
    let w2 = dot(w, w);
    // The center's part across the ray, m - (m·v) v, with m·v = 1 - w2 / 2.
    let across = w + 0.5 * w2 * v;
    return NgRay(v, w, w2, dot(across, across), 2.0 * asin(min(0.5 * sqrt(w2), 1.0)));
}

// Where a ray enters the sphere of radius `r` about the center, as tau; past it, the point of closest approach.
fn ngEnter(ray: NgRay, r: f32) -> f32 {
    return -0.5 * ray.w2 - sqrt(max(r * r - ray.s2, 0.0));
}

// The point at tau along a ray, from the Moon's center.
fn ngAlong(ray: NgRay, tau: f32) -> vec3f {
    return tau * ray.v - ray.w;
}

// A ray's footprint where it meets the sphere at `body`, in the Moon's frame: `width` across the line of sight, and
// along it stretched by the slant, up to fifty times at the limb.
fn ngFootprintAt(body: vec3f, v: vec3f, width: f32) -> NgFootprint {
    let toViewer = ngParams.orientation * -v;
    let side = toViewer - dot(toViewer, body) * body;
    let helper = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(body.z) > 0.9);
    let along = select(normalize(cross(body, helper)), normalize(side), length(side) > 1e-5);
    let mu = max(dot(body, toViewer), 0.0);
    return NgFootprint(cross(body, along) * width, along * width / max(mu, 0.02));
}

// How far a point lies above the relief, radially, at unit distance: `q` from the Moon's center, `scale` km to those
// units, the heights read at `level` of the whole relief. As finely as the pixel is wide, not over its footprint along
// the line of sight, which near the limb would average the peaks that stand against the sky away.
fn ngAboveRelief(q: vec3f, sinA: f32, scale: f32, level: f32) -> f32 {
    let r = length(q);
    let body = ngParams.orientation * (q / r);
    let fine = ngInDetail(body);
    let h = ngHeightAt(body, max(select(level, level + ngDetailLevels(), fine), 0.0), fine);
    return r - (sinA + h * scale);
}

// Where a ray meets the relief itself, not the smooth sphere: marched through the shell the heights span, from where it
// enters, in steps half as long as its height over the terrain, as no slope rises steeper than 63°, but no shorter than
// half a pixel, and the crossing found between the last two steps. A ray that passes over the terrain covers the pixel
// by how near it came, within its own width: the limb shows its mountains. Where the heights would move the surface by
// less than a quarter pixel, the smooth sphere.
// `limb` the coverage of the smooth limb; returns the surface's direction from the center and the ray's coverage.
fn ngDisplaced(ray: NgRay, sampleAngle: f32, pixelAngle: f32, limb: f32) -> vec4f {
    let v = ray.v;
    let sinA = sin(ngParams.angularRadius);
    let scale = sinA / ngParams.moonRadiusKm;
    let r0 = sinA + NG_HEIGHT_MIN_KM * scale;
    let r1 = sinA + NG_HEIGHT_MAX_KM * scale;
    if (ray.s2 >= r1 * r1) {
        return vec4f(0.0);
    }
    if (ray.s2 < sinA * sinA) {
        let n = normalize(ngAlong(ray, ngEnter(ray, sinA)));
        let mu = max(dot(n, -v), 1e-3);
        if ((r1 - r0) * sqrt(max(1.0 - mu * mu, 0.0)) / mu < 0.25 * pixelAngle) {
            return vec4f(n, limb);
        }
    }
    let tIn = ngEnter(ray, r1);
    let tOut = select(-0.5 * ray.w2 + sqrt(r1 * r1 - ray.s2), ngEnter(ray, r0), ray.s2 < r0 * r0);
    // Near the limb a ray runs hundreds of pixels through the shell, close over the terrain: its steps no shorter than
    // a 64th of that run, and a ray still above the terrain when they are spent is taken to meet it there.
    let minStep = max(0.5 * pixelAngle, (tOut - tIn) / 64.0);
    let level = log2(max(pixelAngle / scale / ngReliefTexelKm(false), 1e-4));
    // Read by the B-spline only within a few pixels of the terrain: farther above it, bilinearly from the next level.
    let coarse = max(level, 0.5);
    var t = tIn;
    var margin = ngAboveRelief(ngAlong(ray, t), sinA, scale, coarse);
    var closest = margin;
    var closestT = t;
    for (var i = 0u; i < NG_DISPLACE_STEPS && margin > 0.0 && t < tOut; i = i + 1u) {
        let previous = margin;
        let previousT = t;
        t = min(t + max(0.5 * margin, minStep), tOut);
        margin = ngAboveRelief(ngAlong(ray, t), sinA, scale, select(coarse, level, previous < 4.0 * pixelAngle));
        if (margin <= 0.0) {
            t = previousT + (t - previousT) * previous / max(previous - margin, 1e-12);
        } else if (margin < closest) {
            closest = margin;
            closestT = t;
        }
    }
    if (margin <= 0.0 || t < tOut) {
        return vec4f(normalize(ngAlong(ray, t)), 1.0);
    }
    return vec4f(normalize(ngAlong(ray, closestT)), clamp(1.0 - closest / max(sampleAngle, 1e-9), 0.0, 1.0));
}

// Where a ray meets the sphere of the Moon's angular radius at unit distance, from its center: where it enters it, or
// past the limb the point nearest the center, so the partly covered rays at the edge are shaded like the limb.
fn ngSmooth(ray: NgRay) -> vec3f {
    return normalize(ngAlong(ray, ngEnter(ray, sin(ngParams.angularRadius))));
}

// How much of its share of the pixel a ray's smooth limb covers, `sampleAngle` wide.
fn ngLimb(ray: NgRay, sampleAngle: f32) -> f32 {
    return clamp((ngParams.angularRadius - ray.angle) / max(sampleAngle, 1e-7) + 0.5, 0.0, 1.0);
}

// Where a ray meets the Moon, the smooth sphere or the relief itself, and how much of its share of the pixel it covers.
fn ngHit(ray: NgRay, sampleAngle: f32, pixelAngle: f32) -> vec4f {
    if (ngFlag(NG_FLAG_DISPLACE)) {
        return ngDisplaced(ray, sampleAngle, pixelAngle, ngLimb(ray, sampleAngle));
    }
    return vec4f(ngSmooth(ray), ngLimb(ray, sampleAngle));
}

// One ray's share of a pixel: `view` as seen and `ray` as it left the air, `hit` where it meets the Moon and how much
// it covers, and `pixelAngle` the pixel's width, which the maps are filtered over: the rays resolve the shading and the
// shadows' edges, the filtering the maps, so more rays sharpen the one and never alias the other.
fn ngMoon(view: vec3f, ray: NgRay, hit: vec4f, pixelAngle: f32) -> NgMoon {
    let v = ray.v;
    let n = hit.xyz;
    let coverage = hit.w;
    if (coverage <= 0.0) {
        return NgMoon(vec3f(0.0), 0.0, vec3f(0.0));
    }
    let body = ngParams.orientation * n;
    // The pixel's footprint on the sphere: its width across, and along the line of sight stretched by the slant, up to
    // fifty times at the limb. The maps are filtered anisotropically over it, so the limb and the poles stay sharp.
    let footprint = ngFootprintAt(body, v, pixelAngle / sin(ngParams.angularRadius));

    var albedo = vec3f(ngParams.albedo);
    if (ngFlag(NG_FLAG_COLOR)) {
        albedo = ngSrgbToLinear(ngColorAt(body, footprint)) * ngParams.albedoScale;
        if (ngFlag(NG_FLAG_GRAY)) {
            albedo = vec3f(dot(albedo, vec3f(0.2126, 0.7152, 0.0722)));
        } else if (!ngFlag(NG_FLAG_UNTINTED)) {
            albedo = albedo * ngParams.albedoTint;
        }
    }
    // The relief: the surface's normal from its slope.
    var shading = n;
    if (ngFlag(NG_FLAG_RELIEF)) {
        let relief = ngReliefAt(body, footprint);
        shading = transpose(ngParams.orientation) * normalize(body - relief.yzw);
    }

    // Sunlight by the reflectance law: the phase angle between the Sun and the viewer at that point.
    let s = ngParams.sunDirection;
    let cosG = clamp(dot(s, -v), -1.0, 1.0);
    // A slope turned away from the viewer is a facet the terrain in front would hide; the ray meets the smooth sphere
    // and sees it anyway, black near the limb at full Moon. Tilted towards the viewer until it faces them a little.
    let facing = dot(shading, -v);
    if (facing < NG_FACING) {
        shading = normalize(shading - v * (NG_FACING - facing));
    }
    let mu0 = dot(shading, s);
    let muView = dot(shading, -v);
    // What reaches the point of the sunlight: the terrain's shadows and Earth's; and under a point Sun, to compare.
    var shade = vec3f(1.0);
    var hard = vec3f(1.0);
    if (ngFlag(NG_FLAG_SHADOWS) && mu0 > 0.0) {
        let terrain = ngShadowAt(body);
        shade = shade * terrain.x;
        hard = hard * terrain.y;
    }
    if (ngFlag(NG_FLAG_ECLIPSE) && mu0 > 0.0) {
        let earth = ngShadow(ngParams.moonCenterKm + n * ngParams.moonRadiusKm);
        shade = shade * earth;
        hard = hard * earth;
    }
    // Earthshine comes from Earth's center, which the Moon sees up to a degree off the observer: near opposition.
    let e = ngParams.earthDirection;
    let cosGe = clamp(dot(e, -v), -1.0, 1.0);
    let mu0e = dot(shading, e);
    let earthshine = ngParams.earthshine > 0.0;
    let through = albedo * ngTransmittance(view);
    // With NG_FLAG_COMPARE_SHADOWS the point Sun's hard shadows are drawn, held against the Sun's disc.
    let pointSun = ngFlag(NG_FLAG_COMPARE_SHADOWS);
    let law = select(ngParams.law, NG_FIXED_LAW, NG_FIXED);
    var lit = ngParams.sunIlluminance * ngReflectance(law, mu0, muView, cosG) * select(shade, hard, pointSun);
    if (earthshine) {
        lit = lit + ngParams.earthshine * ngReflectance(law, mu0e, muView, cosGe);
    }
    var reference = vec3f(0.0);
    if (ngFlag(NG_FLAG_COMPARE | NG_FLAG_COMPARE_SHADOWS)) {
        let other = select(law, select(ngParams.compareLaw, NG_FIXED_COMPARE_LAW, NG_FIXED), ngFlag(NG_FLAG_COMPARE));
        reference = ngParams.sunIlluminance * ngReflectance(other, mu0, muView, cosG) * shade;
        if (earthshine) {
            reference = reference + ngParams.earthshine * ngReflectance(other, mu0e, muView, cosGe);
        }
    }
    let luminance = through * lit;
    reference = through * reference;
    return NgMoon(luminance, coverage, reference);
}

// Rays per pixel on and around the disc, spread by Roberts' R2 sequence. One suffices: the maps are filtered over the
// pixel, the shadows read from their map, the smooth limb covered by its distance. Along the terminator, where the Sun
// stands low over the relief and every crater rim turns from lit to dark within a texel, and along a displaced limb,
// NG_TERMINATOR_SAMPLES rays instead.
override NG_SAMPLES: u32 = 1u;
// Whether magnified maps are read by the cubic B-spline, rather than as the sampler filters them.
override NG_MAP_BSPLINE: bool = true;
override NG_TERMINATOR_SAMPLES: u32 = 4u;
// How much at least a slope faces the viewer, as the cosine of its normal to the line of sight.
const NG_FACING: f32 = 0.05;
// How near the terminator a pixel takes the extra rays: the cosine of the Sun's angle over the surface at its center.
const NG_TERMINATOR_BAND: f32 = 0.35;

fn ngR2(i: u32) -> vec2f {
    return fract(vec2f(0.5) + f32(i) * vec2f(0.7548776662466927, 0.5698402909980532)) - 0.5;
}

// Whether a pixel's center ray passes through the shell of a displaced relief at the limb, where its mountains stand
// against the sky.
fn ngNearLimb(ray: NgRay, pixelAngle: f32) -> bool {
    let sinA = sin(ngParams.angularRadius);
    let scale = sinA / ngParams.moonRadiusKm;
    let low = asin(sinA + NG_HEIGHT_MIN_KM * scale) - pixelAngle;
    return ngFlag(NG_FLAG_DISPLACE) && ray.angle > low && ray.angle < asin(sinA + NG_HEIGHT_MAX_KM * scale) + pixelAngle;
}

// The disc over a pixel: the mean of the rays through it where the disc may reach, nothing elsewhere. Their light is
// averaged as a sensor does, then the pixel tone mapped.
fn ngPixel(pixel: vec2f, size: vec2u) -> NgMoon {
    let center = ngPixelRay(pixel, size);
    let pixelAngle = length(ngPixelRay(pixel + vec2f(1.0, 0.0), size) - center);
    // The refraction moves the disc by up to a degree and squeezes it: tested on the bent ray, with room for both.
    let middle = ngRayOf(ngUnbend(center));
    if (middle.angle > ngParams.angularRadius * 1.3 + 3.0 * pixelAngle) {
        return NgMoon(vec3f(0.0), 0.0, vec3f(0.0));
    }
    // More rays near the terminator, where the relief's shading changes fastest, and at a displaced limb.
    let limb = ngNearLimb(middle, pixelAngle);
    let onSphere = ngSmooth(middle);
    let terminator = abs(dot(onSphere, ngParams.sunDirection)) < NG_TERMINATOR_BAND;
    var count = NG_SAMPLES;
    if (NG_TERMINATOR_SAMPLES > NG_SAMPLES && ngFlag(NG_FLAG_RELIEF) && (limb || terminator)) {
        count = NG_TERMINATOR_SAMPLES;
    }
    let sampleAngle = pixelAngle * inverseSqrt(f32(count));
    // The first ray the center's, R2's first point. Where the surface is seen less than 60° off straight on, the relief
    // moves the others' points as much as the first's, by its shift from the smooth sphere, and only the first is
    // marched through it; nearer the limb its peaks hide what lies behind them, and each ray is marched.
    let alike = !limb && dot(onSphere, -middle.v) > 0.5;
    var shift = vec3f(0.0);
    var luminance = vec3f(0.0);
    var coverage = 0.0;
    var reference = vec3f(0.0);
    for (var i = 0u; i < count; i = i + 1u) {
        var view = center;
        var ray = middle;
        if (i > 0u) {
            view = ngPixelRay(pixel + ngR2(i), size);
            ray = ngRayOf(ngUnbend(view));
        }
        var hit: vec4f;
        if (i == 0u || !alike) {
            hit = ngHit(ray, sampleAngle, pixelAngle);
        } else {
            hit = vec4f(normalize(ngSmooth(ray) + shift), ngLimb(ray, sampleAngle));
        }
        if (i == 0u) {
            shift = hit.xyz - onSphere;
        }
        // The ground hides whatever is below the horizon.
        if (view.z < ngParams.horizonZ) {
            continue;
        }
        let moon = ngMoon(view, ray, hit, pixelAngle);
        luminance = luminance + moon.luminance * moon.coverage;
        coverage = coverage + moon.coverage;
        reference = reference + moon.reference * moon.coverage;
    }
    let n = f32(count);
    return NgMoon(luminance / n, coverage / n, reference / n);
}

// The disc's light, premultiplied, at a pixel made what the target shows: over the background where there is one, as the
// eye sees it at night if asked, exposed, tone mapped and dithered, or left linear.
fn ngFinish(luminance: vec3f, coverage: f32, pixel: vec2u) -> vec4f {
    var color = luminance;
    var alpha = coverage;
    if (NG_BACKGROUND) {
        color = color + textureLoad(ngBackground, vec2i(pixel), 0).rgb;
        alpha = 1.0;
        if (NG_NIGHT_VISION) {
            color = hdNightVision(color);
        }
    }
    color = color * ngParams.exposure;
    if (NG_TONE_MAP != 0u) {
        color = ngToneMap(color);
        if (NG_DITHER) {
            color = clamp(hdDither(color, pixel, 255.0), vec3f(0.0), hdEncodeSrgbExtended(vec3f(NG_HEADROOM), NG_HEADROOM));
        }
    }
    return vec4f(color, alpha);
}

@compute @workgroup_size(8, 8, 1)
fn ngCompose(@builtin(global_invocation_id) id: vec3u) {
    let size = ngOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    // The disc's light, premultiplied by how much of the pixel it covers.
    let moon = ngPixel(vec2f(id.xy) + 0.5, size);
    if (NG_LAYER) {
        ngOutputStore(id.xy, vec4f(moon.luminance, moon.coverage));
        return;
    }
    let finished = ngFinish(moon.luminance, moon.coverage, id.xy);
    var color = finished.rgb;
    // Striped where the disc is off the law or the soft shadows it is compared with by more than a third of a stop, as a
    // camera stripes what clips: red where it is brighter, blue where darker, in four steps of opacity, from a third of a
    // stop, two thirds, one and two stops off; and only where either is bright enough to tell.
    let compared = ngFlag(NG_FLAG_COMPARE | NG_FLAG_COMPARE_SHADOWS);
    if (compared && moon.coverage > 0.5 && (id.x + id.y) % 6u < 3u) {
        let weights = vec3f(0.2126, 0.7152, 0.0722);
        let shown = dot(moon.luminance, weights);
        let reference = dot(moon.reference, weights);
        let floor = 1e-3 / max(ngParams.exposure, 1e-12);
        if (max(shown, reference) > floor) {
            let stops = log2(max(shown, floor) / max(reference, floor));
            let off = abs(stops);
            let amount = select(select(select(0.3, 0.6, off > 2.0 / 3.0), 0.8, off > 1.0), 1.0, off > 2.0);
            if (stops > 1.0 / 3.0) {
                color = mix(color, vec3f(1.0, 0.0, 0.3), amount);
            } else if (stops < -1.0 / 3.0) {
                color = mix(color, vec3f(0.1, 0.45, 1.0), amount);
            }
        }
    }
    ngOutputStore(id.xy, vec4f(color, finished.a));
}
