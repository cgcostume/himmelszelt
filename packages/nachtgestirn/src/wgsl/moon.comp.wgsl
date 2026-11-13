// The Moon's disc along every pixel's ray: linear and premultiplied with its coverage in alpha, or over a background in
// cd/m², exposed and tone mapped like dunstkreis' sky. Requires `params.wgsl`, `surface.wgsl`, `reflectance.wgsl` or a
// law of one's own, `camera.wgsl` (dunstkreis'), `tonemap.wgsl` and `vision.wgsl` (helldunkel's), and the output
// binding from `moonOutput`.

// Bindings ------------------------------------------------------------------------------------------------------------

@group(0) @binding(0) var<uniform> ngParams: NgParams;
@group(0) @binding(1) var<uniform> ngTables: NgTables;
@group(0) @binding(2) var ngColorMap: texture_2d<f32>;
@group(0) @binding(3) var ngReliefMap: texture_2d<f32>;
@group(0) @binding(4) var ngMapSampler: sampler;
// A strip of the maps at a finer size, where `ngParams.detailRegion` says, read instead of the whole maps within it.
@group(0) @binding(5) var ngDetailColor: texture_2d<f32>;
@group(0) @binding(6) var ngDetailRelief: texture_2d<f32>;
// The share of the Sun's disc each point of the band around the terminator sees, from `shadow.comp.wgsl`.
@group(0) @binding(7) var ngShadowMap: texture_2d<f32>;
// The sky behind the Moon, in cd/m², with NG_BACKGROUND.
@group(0) @binding(8) var ngBackground: texture_2d<f32>;
// The Moon alone, linear and premultiplied, as the layer pass wrote it: what `shimmer.comp.wgsl` moves about.
@group(0) @binding(9) var ngLayer: texture_2d<f32>;

// What the pipeline is made with --------------------------------------------------------------------------------------

// The output: tone mapped for a display by Neutral (1), AgX (2), ACES (3) or clipped (4), and dithered; or, 0, the
// exposed light, linear.
override NG_TONE_MAP: u32 = 0u;
override NG_HEADROOM: f32 = 1.0;
override NG_DITHER: bool = false;
// Over a background, and with it as the eye sees it at night, by the rods' blue shift, `hdNightVision`. Without one
// the Moon alone, premultiplied, with its coverage in alpha.
override NG_BACKGROUND: bool = false;
override NG_NIGHT_VISION: bool = false;
// The Moon alone, linear and premultiplied, for the shimmer's pass to move about and finish.
override NG_LAYER: bool = false;
// Rays per pixel, and along the terminator and a displaced limb.
override NG_SAMPLES: u32 = 1u;
override NG_TERMINATOR_SAMPLES: u32 = 4u;
// Whether magnified maps are read by the cubic B-spline, rather than as the sampler filters them.
override NG_MAP_BSPLINE: bool = true;
// Whether the maps have a detail strip.
override NG_DETAIL: bool = false;
// The frame's flags fixed, where NG_FIXED: a pipeline made for them, which leaves out what they leave out. Else read
// from `ngParams`, one pipeline for every frame.
override NG_FIXED: bool = false;
override NG_FIXED_FLAGS: u32 = 0u;

fn ngHas(flag: u32) -> bool {
    return (select(ngParams.flags, NG_FIXED_FLAGS, NG_FIXED) & flag) != 0u;
}

// The maps ------------------------------------------------------------------------------------------------------------

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

// A map over a ray's footprint, `dx` and `dy` its axes in uv: by the B-spline where it is magnified, else filtered
// anisotropically by the hardware, up to sixteen taps along the long axis. Towards the poles the parallels crowd the
// texels together east to west, and at the limb the slant stretches the footprint: an isotropic mip level would take
// the longer of both and blur what the other axis still resolves.
fn ngSampleIn(map: texture_2d<f32>, uv: vec2f, dx: vec2f, dy: vec2f) -> vec3f {
    let size = vec2f(textureDimensions(map));
    let texels = max(length(dx * size), length(dy * size));
    if (!NG_MAP_BSPLINE || texels >= 1.25) {
        return textureSampleGrad(map, ngMapSampler, uv, dx, dy).rgb;
    }
    let spline = ngSampleBicubic(map, uv);
    if (texels <= 0.75) {
        return spline;
    }
    // Blended over a band around a texel to a footprint, so no seam shows where the one hands over to the other.
    return mix(spline, textureSampleGrad(map, ngMapSampler, uv, dx, dy).rgb, (texels - 0.75) / 0.5);
}

// Where a point of the whole maps lies in the detail strip, in the strip's own uv, or -1 outside it or without one: a
// few texels in from its edges, so neither the filter nor the B-spline reaches past them.
fn ngDetailUv(uv: vec2f) -> vec2f {
    if (!NG_DETAIL) {
        return vec2f(-1.0);
    }
    let region = ngParams.detailRegion;
    let inStrip = (uv - region.xy) / (region.zw - region.xy);
    let margin = 4.0 / vec2f(textureDimensions(ngDetailRelief));
    if (any(inStrip < margin) || any(inStrip > 1.0 - margin)) {
        return vec2f(-1.0);
    }
    return inStrip;
}

// How many texels of the strip's relief make one of the whole relief's, as log2: what a level is shifted by.
fn ngDetailLevels() -> f32 {
    let region = ngParams.detailRegion;
    let stripTexels = f32(textureDimensions(ngDetailRelief).y) / (region.w - region.y);
    return log2(stripTexels / f32(textureDimensions(ngReliefMap).y));
}

// Whether a point lies in the detail strip, where the relief's levels and texels are the strip's.
fn ngInDetail(point: vec3f) -> bool {
    return ngDetailUv(ngMapUv(ngSelenographic(point))).x >= 0.0;
}

// A map at a point over a ray's footprint, the strip's where it lies in one.
fn ngSampleMap(map: texture_2d<f32>, detail: texture_2d<f32>, point: vec3f, footprint: NgFootprint) -> vec3f {
    let uv = ngMapUv(ngSelenographic(point));
    let local = ngLocal(point);
    let dx = ngUvStep(local, footprint.across);
    let dy = ngUvStep(local, footprint.along);
    let inStrip = ngDetailUv(uv);
    if (inStrip.x >= 0.0) {
        let scale = 1.0 / (ngParams.detailRegion.zw - ngParams.detailRegion.xy);
        return ngSampleIn(detail, inStrip, dx * scale, dy * scale);
    }
    return ngSampleIn(map, uv, dx, dy);
}

// The normal albedo at a point, per channel: the color map's, or the one given.
fn ngAlbedoAt(point: vec3f, footprint: NgFootprint) -> vec3f {
    if (!ngHas(NG_FLAG_COLOR)) {
        return vec3f(ngParams.albedo);
    }
    let encoded = ngSampleMap(ngColorMap, ngDetailColor, point, footprint);
    return ngParams.albedoMatrix * ngSrgbToLinear(encoded);
}

// The surface's normal at a point, in the Moon's frame: the relief's slope tilts it from the sphere's.
fn ngNormalAt(point: vec3f, footprint: NgFootprint) -> vec3f {
    let relief = ngSampleMap(ngReliefMap, ngDetailRelief, point, footprint);
    let local = ngLocal(point);
    return normalize(point - relief.y * local.east - relief.z * local.north);
}

// The relief's height at a level: by the B-spline below `splineBelow`, smooth across the texels' creases, bilinearly
// above it. The shadows are marched through a smooth terrain wherever the finest level is read, so their edges do not
// follow the creases: below half a level. The displaced relief only where it is magnified: below level 0.
const NG_SPLINE_SHADOWS: f32 = 0.5;
// Where a shadow is cast from between a coarse texel's mean height and its highest: the march follows a line, the texel
// is a square, and its highest point mostly lies off the line. Halfway matches the share of shadow photographs show
// along the terminator.
override NG_PEAK_SHARE: f32 = 0.5;
const NG_SPLINE_DISPLACED: f32 = 0.0;

fn ngHeightIn(map: texture_2d<f32>, uv: vec2f, level: f32, splineBelow: f32, highest: bool) -> f32 {
    if (level < splineBelow) {
        return ngSampleBicubic(map, uv).x;
    }
    let texel = textureSampleLevel(map, ngMapSampler, uv, max(level, 0.0));
    return select(texel.x, mix(texel.x, texel.w, NG_PEAK_SHARE), highest);
}

// The height at a point in km at a level, the strip's where `inStrip`; past the strip the whole relief's, its level
// turned to the whole relief's. `highest` reads the highest the terrain rises within a texel of the level instead of
// its mean: what casts a shadow.
fn ngHeightAt(point: vec3f, level: f32, inStrip: bool, splineBelow: f32, highest: bool) -> f32 {
    let uv = ngMapUv(ngSelenographic(point));
    if (inStrip) {
        let stripUv = ngDetailUv(uv);
        if (stripUv.x >= 0.0) {
            return ngHeightIn(ngDetailRelief, stripUv, level, splineBelow, highest);
        }
        return ngHeightIn(ngReliefMap, uv, level - ngDetailLevels(), splineBelow, highest);
    }
    return ngHeightIn(ngReliefMap, uv, level, splineBelow, highest);
}

// A texel of the relief along the equator, in km, the strip's where `inStrip`.
fn ngReliefTexelKm(inStrip: bool) -> f32 {
    let texelKm = 2.0 * NG_PI * ngParams.moonRadiusKm / f32(textureDimensions(ngReliefMap).x);
    return select(texelKm, texelKm * exp2(-ngDetailLevels()), inStrip);
}

// The air -------------------------------------------------------------------------------------------------------------

// Where a ray seen at `altitude` falls in the air's table: the entry below it, and the share of the next.
fn ngTableAt(altitude: f32) -> vec2f {
    let last = f32(NG_REFRACTION_SAMPLES - 1u);
    let at = clamp((altitude - ngParams.refractionFrom) / ngParams.refractionStep, 0.0, last);
    let entry = min(floor(at), last - 1.0);
    return vec2f(entry, at - entry);
}

// How far the air bends a ray seen at `altitude` down, between the table's entries.
fn ngBend(altitude: f32) -> f32 {
    let at = ngTableAt(altitude);
    let i = u32(at.x);
    let below = ngTables.bends[i / 4u][i % 4u];
    let above = ngTables.bends[(i + 1u) / 4u][(i + 1u) % 4u];
    return mix(below, above, at.y);
}

// What the air lets through along `view`, per channel: from the table with NG_FLAG_AIR, else the one given.
fn ngTransmittance(view: vec3f) -> vec3f {
    if (!ngHas(NG_FLAG_AIR)) {
        return ngParams.transmittance;
    }
    let at = ngTableAt(atan2(view.z, length(view.xy)));
    let i = u32(at.x);
    return mix(ngTables.airTransmittance[i].rgb, ngTables.airTransmittance[i + 1u].rgb, at.y);
}

// The ray as it left the atmosphere, with NG_FLAG_AIR: turned down within its vertical plane by the bend the air gave
// it, the way dunstkreis bends its rays to find the sun disc. The lower limb is lifted more than the upper, so the disc
// shows squeezed near the horizon.
fn ngUnbend(view: vec3f) -> vec3f {
    let horizontal = length(view.xy);
    if (!ngHas(NG_FLAG_AIR) || horizontal < 1e-6) {
        return view;
    }
    let apparent = atan2(view.z, horizontal);
    let altitude = apparent - ngBend(apparent);
    return vec3f(view.xy / horizontal * cos(altitude), sin(altitude));
}

// Earth's shadow ------------------------------------------------------------------------------------------------------

// What of the sunlight reaches a point of the Moon through Earth's shadow, per channel: the share of the Sun's disc
// Earth leaves uncovered, seen from that point, plus what its atmosphere bends into the umbra, red in the middle, with
// the turquoise rim ozone leaves where the light passed the stratosphere. `pointKm` from Earth's center.
fn ngEarthShadow(pointKm: vec3f) -> vec3f {
    // The Sun's and Earth's discs as that point sees them, and the angle between their centers.
    let distanceKm = length(pointKm);
    let toEarth = -pointKm / distanceKm;
    let earthRadius = asin(min(ngParams.earthRadiusKm / distanceKm, 1.0));
    let sunRadius = ngParams.sunAngularRadius;
    let separation = acos(clamp(dot(toEarth, -ngParams.shadowAxis), -1.0, 1.0));
    let covered = ngLens(earthRadius, sunRadius, separation) / (NG_PI * sunRadius * sunRadius);
    let direct = vec3f(1.0 - covered);

    // What the air adds, from the table over the distance from the axis, the axis to the penumbra's edge.
    let axis = ngParams.shadowAxis;
    let fromAxisKm = length(pointKm - dot(pointKm, axis) * axis);
    let at = fromAxisKm / max(ngParams.penumbraKm, 1.0) * f32(NG_UMBRA_SAMPLES - 1u);
    if (at >= f32(NG_UMBRA_SAMPLES - 1u)) {
        return direct;
    }
    let i = u32(at);
    let refracted = mix(ngTables.umbra[i].rgb, ngTables.umbra[i + 1u].rgb, fract(at));
    return direct + refracted * ngParams.umbraLight;
}

// The terrain's shadows -----------------------------------------------------------------------------------------------

// Up to which elevation over its horizontal the Sun can still be hidden from a point by the terrain: no crater rim or
// mountain stands steeper above a point than some 25°. Above it, no march.
const NG_SHADOW_ELEVATION: f32 = 0.45;
// Steps towards the Sun, each this much farther than the last, from three quarters of a texel on: 24 of them reach
// some 450 km on the 4096 texel map, as far as a mountain's shadow runs with the Sun a degree up.
const NG_SHADOW_STEPS: u32 = 24u;
const NG_SHADOW_GROWTH: f32 = 1.26;

// How much of a disc of `radius` around `toward` stands above the terrain's horizon, seen from a point of the surface,
// `up` its direction in the Moon's frame, `height` its height in km: the Sun's, or the viewer's, a point. The relief is
// marched along the great circle towards it for the highest elevation the terrain reaches above the point's horizontal.
// Near what casts it that angle changes fast and the shadow's edge is sharp; far from it slowly, and the penumbra widens
// with the distance, as the Sun's half degree makes it. `level` the relief's level at the point.
fn ngDiscAboveTerrain(up: vec3f, toward: vec3f, height: f32, level: f32, inStrip: bool, radius: f32) -> f32 {
    let elevation = asin(clamp(dot(toward, up), -1.0, 1.0));
    let along = toward - dot(toward, up) * up;
    if (elevation > NG_SHADOW_ELEVATION || length(along) < 1e-6) {
        return 1.0;
    }
    let ahead = normalize(along);
    let texelKm = ngReliefTexelKm(inStrip);
    let origin = (ngParams.moonRadiusKm + height) * up;
    // The terrain's steepest rise ahead, as a tangent, every step lying ahead; the march stops once nothing of the disc
    // is left above it.
    let enough = tan(elevation + radius);
    var slope = -1e30;
    // From a texel of the point's own level on: nearer, a step would read the point's own coarse texel, whose highest
    // stands over the mean the point sits at, and a small disc would shadow itself all along the terminator.
    var distanceKm = 0.75 * texelKm * exp2(max(level, 0.0));
    for (var step = 0u; step < NG_SHADOW_STEPS && slope <= enough; step = step + 1u) {
        let angle = distanceKm / ngParams.moonRadiusKm;
        let there = up * cos(angle) + ahead * sin(angle);
        // Read as coarse as the steps are apart, so no peak falls between two of them, and the highest within a texel
        // of that level, so no peak is averaged away either.
        let levelThere = max(level, log2(distanceKm * 0.3 / texelKm));
        let heightThere = ngHeightAt(there, levelThere, inStrip, NG_SPLINE_SHADOWS, true);
        let toThere = (ngParams.moonRadiusKm + heightThere) * there - origin;
        slope = max(slope, dot(toThere, up) / dot(toThere, ahead));
        distanceKm = distanceKm * NG_SHADOW_GROWTH;
    }
    // The share of the disc above a line through it, the line x radii below its center.
    let x = clamp((elevation - atan(slope)) / radius, -1.0, 1.0);
    return 0.5 + (x * sqrt(1.0 - x * x) + asin(x)) / NG_PI;
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

// The share of the Sun's disc a point sees above the terrain, from the shadow map: lit before the band, dark past it,
// and outside the window, which holds only what the view shows, lit on the day side.
fn ngTerrainShadow(point: vec3f) -> f32 {
    let band = ngBandAt(point);
    if (band.y < NG_BAND_FROM) {
        return 1.0;
    }
    if (band.y > NG_BAND_TO) {
        return 0.0;
    }
    let window = ngParams.shadowWindow;
    let texel = vec2f(band.x, band.y - window.x) / ngParams.shadowSun.w;
    if (texel.x > window.y || texel.y < 0.0 || texel.y > window.z) {
        return select(0.0, 1.0, band.y < NG_PI / 2.0);
    }
    // Between the four nearest texels, by hand: the map is larger than its window, rounded up, and a sampler would mix
    // in the texels past its edges. The whole ring wraps around, a window stops at its edges.
    let size = vec2i(i32(window.y), i32(window.z));
    let ring = window.y * ngParams.shadowSun.w >= 2.0 * NG_PI - 1e-4;
    let corner = texel - 0.5;
    let first = vec2i(floor(corner));
    let t = corner - floor(corner);
    var xs = vec2i(first.x, first.x + 1);
    xs = select(clamp(xs, vec2i(0), vec2i(size.x - 1)), (xs % size.x + size.x) % size.x, ring);
    let ys = clamp(vec2i(first.y, first.y + 1), vec2i(0), vec2i(size.y - 1));
    let a = textureLoad(ngShadowMap, vec2i(xs.x, ys.x), 0).r;
    let b = textureLoad(ngShadowMap, vec2i(xs.y, ys.x), 0).r;
    let c = textureLoad(ngShadowMap, vec2i(xs.x, ys.y), 0).r;
    let d = textureLoad(ngShadowMap, vec2i(xs.y, ys.y), 0).r;
    return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

// Rays against the Moon -----------------------------------------------------------------------------------------------

// A ray against the Moon's sphere at unit distance, kept well conditioned: the ray and the direction to the center are
// nearly parallel, and their dot product, near 1, keeps only some five digits of the angle between them, steps of a
// third of a percent of the radius, which showed as stairs in a large disc. Their difference keeps all of f32's. `v`
// the ray, `w` from it to the center, `w2` its square, `s2` the square of the ray's distance from the center and
// `angle` the angle between them. Points along the ray are `ngAlong(ray, tau)`, tau the distance past unit distance.
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

// Where a ray meets the sphere of the Moon's angular radius, as a direction from its center: where it enters it, or
// past the limb the point nearest the center, so the partly covered rays at the edge are shaded like the limb.
fn ngOnSphere(ray: NgRay) -> vec3f {
    return normalize(ngAlong(ray, ngEnter(ray, sin(ngParams.angularRadius))));
}

// How much of its share of the pixel, `sampleAngle` wide, a ray's smooth limb covers.
fn ngLimbCoverage(ray: NgRay, sampleAngle: f32) -> f32 {
    return clamp((ngParams.angularRadius - ray.angle) / max(sampleAngle, 1e-7) + 0.5, 0.0, 1.0);
}

// A ray's footprint where it meets the sphere at `point`, in the Moon's frame: `width` across the line of sight, and
// along it stretched by the slant, up to fifty times at the limb.
fn ngFootprintAt(point: vec3f, v: vec3f, width: f32) -> NgFootprint {
    let toViewer = ngParams.orientation * -v;
    let side = toViewer - dot(toViewer, point) * point;
    let helper = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(point.z) > 0.9);
    let along = select(normalize(cross(point, helper)), normalize(side), length(side) > 1e-5);
    let mu = max(dot(point, toViewer), 0.0);
    return NgFootprint(cross(point, along) * width, along * width / max(mu, 0.02));
}

// The displaced relief ------------------------------------------------------------------------------------------------

// How far the relief reaches below and above the mean radius, in km: Antoniadi's floor and the Selenean summit.
const NG_HEIGHT_MIN_KM: f32 = -9.2;
const NG_HEIGHT_MAX_KM: f32 = 10.8;
const NG_DISPLACE_STEPS: u32 = 96u;

// How far a point lies above the relief, radially, at unit distance: `at` from the Moon's center, `kmToUnits` km to
// those units, the heights read at `level` of the whole relief. As finely as the pixel is wide, not over its footprint
// along the line of sight, which near the limb would average the peaks that stand against the sky away.
fn ngAboveRelief(at: vec3f, sinA: f32, kmToUnits: f32, level: f32) -> f32 {
    let radius = length(at);
    let point = ngParams.orientation * (at / radius);
    let inStrip = ngInDetail(point);
    let height = ngHeightAt(point, select(level, level + ngDetailLevels(), inStrip), inStrip, NG_SPLINE_DISPLACED, false);
    return radius - (sinA + height * kmToUnits);
}

// Where a ray meets the relief itself, not the smooth sphere: marched through the shell the heights span, from where it
// enters, in steps half as long as its height over the terrain, as no slope rises steeper than 63°, but no shorter than
// half a pixel, and the crossing found between the last two steps. A ray that passes over the terrain covers the pixel
// by how near it came, within its own width: the limb shows its mountains. Where the heights would move the surface by
// less than a quarter pixel, the smooth sphere. `limb` the coverage of the smooth limb; returns the surface's direction
// from the center and the ray's coverage.
fn ngDisplaced(ray: NgRay, sampleAngle: f32, pixelAngle: f32, limb: f32) -> vec4f {
    let sinA = sin(ngParams.angularRadius);
    let kmToUnits = sinA / ngParams.moonRadiusKm;
    let bottom = sinA + NG_HEIGHT_MIN_KM * kmToUnits;
    let top = sinA + NG_HEIGHT_MAX_KM * kmToUnits;
    if (ray.s2 >= top * top) {
        return vec4f(0.0);
    }
    if (ray.s2 < sinA * sinA) {
        let onSphere = normalize(ngAlong(ray, ngEnter(ray, sinA)));
        let mu = max(dot(onSphere, -ray.v), 1e-3);
        if ((top - bottom) * sqrt(max(1.0 - mu * mu, 0.0)) / mu < 0.25 * pixelAngle) {
            return vec4f(onSphere, limb);
        }
    }

    // Near the limb a ray runs hundreds of pixels through the shell, close over the terrain: its steps no shorter than
    // a 64th of that run, and a ray still above the terrain when they are spent is taken to meet it there.
    let enter = ngEnter(ray, top);
    let leave = select(-0.5 * ray.w2 + sqrt(top * top - ray.s2), ngEnter(ray, bottom), ray.s2 < bottom * bottom);
    let minStep = max(0.5 * pixelAngle, (leave - enter) / 64.0);
    // Within a few pixels of the terrain as finely as a pixel, farther above it bilinearly from a coarser level.
    let level = log2(max(pixelAngle / kmToUnits / ngReliefTexelKm(false), 1e-4));
    let coarse = max(level, 0.5);

    var t = enter;
    var margin = ngAboveRelief(ngAlong(ray, t), sinA, kmToUnits, coarse);
    var closest = margin;
    var closestT = t;
    for (var step = 0u; step < NG_DISPLACE_STEPS && margin > 0.0 && t < leave; step = step + 1u) {
        let previous = margin;
        let previousT = t;
        t = min(t + max(0.5 * margin, minStep), leave);
        margin = ngAboveRelief(ngAlong(ray, t), sinA, kmToUnits, select(coarse, level, previous < 4.0 * pixelAngle));
        if (margin <= 0.0) {
            t = previousT + (t - previousT) * previous / max(previous - margin, 1e-12);
        } else if (margin < closest) {
            closest = margin;
            closestT = t;
        }
    }
    if (margin <= 0.0 || t < leave) {
        return vec4f(normalize(ngAlong(ray, t)), 1.0);
    }
    return vec4f(normalize(ngAlong(ray, closestT)), clamp(1.0 - closest / max(sampleAngle, 1e-9), 0.0, 1.0));
}

// Where a ray meets the Moon, the smooth sphere or the relief itself, and how much of its share of the pixel it covers.
fn ngHit(ray: NgRay, sampleAngle: f32, pixelAngle: f32) -> vec4f {
    if (ngHas(NG_FLAG_DISPLACE)) {
        return ngDisplaced(ray, sampleAngle, pixelAngle, ngLimbCoverage(ray, sampleAngle));
    }
    return vec4f(ngOnSphere(ray), ngLimbCoverage(ray, sampleAngle));
}

// Shading -------------------------------------------------------------------------------------------------------------

// How much at least a slope faces the viewer, as the cosine of its normal to the line of sight.
const NG_FACING: f32 = 0.05;

// The light of one ray, in cd/m², and how much of its share of the pixel it covers.
struct NgMoon {
    luminance: vec3f,
    coverage: f32,
}

// One ray's light: `view` as seen and `ray` as it left the air, `hit` where it meets the Moon, as a direction from its
// center, and how much it covers, and `pixelAngle` the pixel's width, which the maps are filtered over: the rays resolve
// the shading and the shadows' edges, the filtering the maps, so more rays sharpen the one and never alias the other.
fn ngMoon(view: vec3f, ray: NgRay, hit: vec4f, pixelAngle: f32) -> NgMoon {
    if (hit.w <= 0.0) {
        return NgMoon(vec3f(0.0), 0.0);
    }
    let toViewer = -ray.v;
    let outward = hit.xyz;
    let point = ngParams.orientation * outward;
    // The pixel's footprint on the sphere: its width across, and along the line of sight stretched by the slant, up to
    // fifty times at the limb. The maps are filtered anisotropically over it, so the limb and the poles stay sharp.
    let footprint = ngFootprintAt(point, ray.v, pixelAngle / sin(ngParams.angularRadius));
    let albedo = ngAlbedoAt(point, footprint);

    // The surface's normal, in the observer's frame. A slope turned away from the viewer is a facet the terrain in
    // front would hide; the ray meets the smooth sphere and sees it anyway, black near the limb at full Moon. Tilted
    // towards the viewer until it faces them a little.
    var normal = outward;
    if (ngHas(NG_FLAG_RELIEF)) {
        normal = transpose(ngParams.orientation) * ngNormalAt(point, footprint);
    }
    let facing = dot(normal, toViewer);
    if (facing < NG_FACING) {
        normal = normalize(normal + toViewer * (NG_FACING - facing));
    }
    let muView = dot(normal, toViewer);

    // Sunlight, as much as the terrain's shadows and Earth's leave of it.
    let sun = ngParams.sunDirection;
    let muSun = dot(normal, sun);
    var sunlight = vec3f(ngParams.sunIlluminance * ngReflectance(muSun, muView, dot(sun, toViewer)));
    if (ngHas(NG_FLAG_SHADOWS) && muSun > 0.0) {
        sunlight = sunlight * ngTerrainShadow(point);
    }
    if (ngHas(NG_FLAG_ECLIPSE) && muSun > 0.0) {
        sunlight = sunlight * ngEarthShadow(ngParams.moonCenterKm + outward * ngParams.moonRadiusKm);
    }

    // Earthshine, from Earth's center, which the Moon sees up to a degree off the observer: near opposition. Bluer
    // than sunlight, as Earth's air and oceans make it.
    var light = sunlight;
    if (ngHas(NG_FLAG_EARTHSHINE)) {
        let earth = ngParams.earthDirection;
        let reflected = ngReflectance(dot(normal, earth), muView, dot(earth, toViewer));
        light = light + NG_EARTHLIGHT * (ngParams.earthshine * reflected);
    }
    return NgMoon(albedo * ngTransmittance(view) * light, hit.w);
}

// Earthlight's color over sunlight's in linear sRGB, of luminance 1: the earthlit night side measured 0.15 magnitudes
// bluer in B-V than the sunlit day side (Thejll et al. 2014), as a power law in wavelength through the channels.
const NG_EARTHLIGHT: vec3f = vec3f(0.943, 1.005, 1.115);

// A pixel -------------------------------------------------------------------------------------------------------------

// How near the terminator a pixel takes the extra rays: the cosine of the Sun's angle over the surface at its center.
const NG_TERMINATOR_BAND: f32 = 0.35;

// The ray through a point of the target, in pixels from its top left corner, on dunstkreis' camera.
fn ngPixelRay(position: vec2f, size: vec2u) -> vec3f {
    let uv = position / vec2f(size);
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    return dkProjectRay(ngParams.inverseViewProjection, ndc, clamp(ngParams.projectionDistance, 0.0, 1.0));
}

// Roberts' R2 sequence, centered on the pixel: its first point the pixel's center.
fn ngR2(i: u32) -> vec2f {
    return fract(vec2f(0.5) + f32(i) * vec2f(0.7548776662466927, 0.5698402909980532)) - 0.5;
}

// Whether a pixel's center ray passes through the shell of a displaced relief at the limb, where its mountains stand
// against the sky.
fn ngNearLimb(ray: NgRay, pixelAngle: f32) -> bool {
    if (!ngHas(NG_FLAG_DISPLACE)) {
        return false;
    }
    let sinA = sin(ngParams.angularRadius);
    let kmToUnits = sinA / ngParams.moonRadiusKm;
    let inner = asin(sinA + NG_HEIGHT_MIN_KM * kmToUnits) - pixelAngle;
    let outer = asin(sinA + NG_HEIGHT_MAX_KM * kmToUnits) + pixelAngle;
    return ray.angle > inner && ray.angle < outer;
}

// The disc over a pixel: the mean of the rays through it where the disc may reach, nothing elsewhere, their light
// averaged as a sensor does. One ray suffices: the maps are filtered over the pixel, the shadows read from their map,
// the smooth limb covered by its distance. Along the terminator, where the Sun stands low over the relief and every
// crater rim turns from lit to dark within a texel, and along a displaced limb, NG_TERMINATOR_SAMPLES rays instead.
fn ngPixel(pixel: vec2f, size: vec2u) -> NgMoon {
    let center = ngPixelRay(pixel, size);
    let pixelAngle = length(ngPixelRay(pixel + vec2f(1.0, 0.0), size) - center);
    // The refraction moves the disc by up to a degree and squeezes it: tested on the bent ray, with room for both.
    let middle = ngRayOf(ngUnbend(center));
    if (middle.angle > ngParams.angularRadius * 1.3 + 3.0 * pixelAngle) {
        return NgMoon(vec3f(0.0), 0.0);
    }

    // More rays near the terminator, where the relief's shading changes fastest, and at a displaced limb.
    let limb = ngNearLimb(middle, pixelAngle);
    let onSphere = ngOnSphere(middle);
    let terminator = abs(dot(onSphere, ngParams.sunDirection)) < NG_TERMINATOR_BAND;
    var count = NG_SAMPLES;
    if (NG_TERMINATOR_SAMPLES > NG_SAMPLES && ngHas(NG_FLAG_RELIEF) && (limb || terminator)) {
        count = NG_TERMINATOR_SAMPLES;
    }
    let sampleAngle = pixelAngle * inverseSqrt(f32(count));

    // Where the surface is seen less than 60° off straight on, the relief moves the other rays' points as much as the
    // first's, by its shift from the smooth sphere, and only the first is marched through it; nearer the limb its peaks
    // hide what lies behind them, and each ray is marched.
    let alike = !limb && dot(onSphere, -middle.v) > 0.5;
    var shift = vec3f(0.0);
    var luminance = vec3f(0.0);
    var coverage = 0.0;
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
            hit = vec4f(normalize(ngOnSphere(ray) + shift), ngLimbCoverage(ray, sampleAngle));
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
    }
    return NgMoon(luminance / f32(count), coverage / f32(count));
}

// The output ----------------------------------------------------------------------------------------------------------

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

// The disc's light, premultiplied, at a pixel made what the target shows: over the background where there is one, as
// the eye sees it at night if asked, exposed, tone mapped and dithered, or left linear.
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
            let white = hdEncodeSrgbExtended(vec3f(NG_HEADROOM), NG_HEADROOM);
            color = clamp(hdDither(color, pixel, 255.0), vec3f(0.0), white);
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
    let moon = ngPixel(vec2f(id.xy) + 0.5, size);
    if (NG_LAYER) {
        ngOutputStore(id.xy, vec4f(moon.luminance, moon.coverage));
        return;
    }
    ngOutputStore(id.xy, ngFinish(moon.luminance, moon.coverage, id.xy));
}
