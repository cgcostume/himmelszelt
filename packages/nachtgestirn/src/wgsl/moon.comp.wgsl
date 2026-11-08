// The Moon's disc along every pixel's ray, over a background in cd/m² where there is one, then exposed and tone mapped
// like dunstkreis' sky, or left linear. Requires `params.wgsl`, `camera.wgsl` (dunstkreis'), `surface.wgsl`,
// `tonemap.wgsl` and `vision.wgsl` (helldunkel's) and the output binding from `moonOutput`.

@group(0) @binding(0) var<uniform> nbParams: NbParams;
@group(0) @binding(1) var nbColorMap: texture_2d<f32>;
@group(0) @binding(2) var nbReliefMap: texture_2d<f32>;
@group(0) @binding(3) var nbMapSampler: sampler;
@group(0) @binding(4) var nbBackground: texture_2d<f32>;
// A strip of the maps at a finer size, where `nbParams.detailRegion` says, read instead of the whole maps within it.
@group(0) @binding(5) var nbDetailColor: texture_2d<f32>;
@group(0) @binding(6) var nbDetailRelief: texture_2d<f32>;

// Tone map for a display by Neutral (1), AgX (2), ACES (3) or none (4); 0 writes the exposed luminance, linear.
override NB_TONE_MAP: u32 = 1u;
override NB_HEADROOM: f32 = 1.0;
override NB_DITHER: bool = true;
// Whether a background is bound; without one the Moon alone is written, premultiplied, with its coverage in alpha.
override NB_BACKGROUND: bool = true;
// The composed light as the eye sees it at night, with a background: the rods' blue shift, `hdNightVision`.
override NB_NIGHT_VISION: bool = false;

fn nbToneMap(exposed: vec3f) -> vec3f {
    if (NB_TONE_MAP == 2u) {
        return hdToneMapAgx(exposed);
    }
    if (NB_TONE_MAP == 3u) {
        return hdToneMapAces(exposed);
    }
    if (NB_TONE_MAP == 4u) {
        return hdToneMapClipHdr(exposed, NB_HEADROOM);
    }
    return hdToneMapNeutralHdr(exposed, NB_HEADROOM);
}

// The ray through a point of the target, in pixels from its top left corner, on dunstkreis' camera.
fn nbPixelRay(position: vec2f, size: vec2u) -> vec3f {
    let uv = position / vec2f(size);
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    return dkProjectRay(nbParams.inverseViewProjection, ndc, clamp(nbParams.projectionDistance, 0.0, 1.0));
}

// A map magnified, by a cubic B-spline in four bilinear taps after Sigg and Hadwiger, so the texels' edges do not show
// as steps along the terminator.
fn nbSampleBicubic(map: texture_2d<f32>, uv: vec2f) -> vec3f {
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
    let a = textureSampleLevel(map, nbMapSampler, vec2f(t0.x, t0.y), 0.0).rgb;
    let b = textureSampleLevel(map, nbMapSampler, vec2f(t1.x, t0.y), 0.0).rgb;
    let c = textureSampleLevel(map, nbMapSampler, vec2f(t0.x, t1.y), 0.0).rgb;
    let d = textureSampleLevel(map, nbMapSampler, vec2f(t1.x, t1.y), 0.0).rgb;
    return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
}

// How far in the map's uv a step `t` along the surface at a point is: east stretched by the parallels' shrinking.
fn nbUvStep(lonLat: vec2f, t: vec3f) -> vec2f {
    let east = vec3f(-sin(lonLat.x), cos(lonLat.x), 0.0);
    let north = vec3f(-sin(lonLat.y) * cos(lonLat.x), -sin(lonLat.y) * sin(lonLat.x), cos(lonLat.y));
    return vec2f(dot(t, east) / max(cos(lonLat.y), 1e-4) / (2.0 * NB_PI), -dot(t, north) / NB_PI);
}

// A map over a ray's footprint: by the B-spline where it is magnified, else filtered anisotropically by the hardware
// over the footprint's two axes in uv, up to sixteen taps along the long one. Towards the poles the parallels crowd
// the texels together east to west, and at the limb the slant stretches the footprint: an isotropic mip level would
// take the longest of both and blur what the other axis still resolves. `dx` and `dy` the footprint's axes in uv.
fn nbSampleIn(map: texture_2d<f32>, uv: vec2f, dx: vec2f, dy: vec2f) -> vec3f {
    let size = vec2f(textureDimensions(map));
    let texels = max(length(dx * size), length(dy * size));
    // Blended over a band around a texel to a footprint, so no seam shows where the one hands over to the other.
    if (!NB_MAP_BSPLINE || texels >= 1.25) {
        return textureSampleGrad(map, nbMapSampler, uv, dx, dy).rgb;
    }
    let spline = nbSampleBicubic(map, uv);
    if (texels <= 0.75) {
        return spline;
    }
    return mix(spline, textureSampleGrad(map, nbMapSampler, uv, dx, dy).rgb, (texels - 0.75) / 0.5);
}

// Where a point of the whole maps lies in the detail strip, in the strip's own uv, or -1 outside it or without one: a
// few texels in from its edges, so neither the filter nor the B-spline reaches past them.
fn nbDetailUv(uv: vec2f) -> vec2f {
    let r = nbParams.detailRegion;
    if (r.z <= r.x) {
        return vec2f(-1.0);
    }
    let local = (uv - r.xy) / (r.zw - r.xy);
    let margin = 4.0 / vec2f(textureDimensions(nbDetailRelief));
    if (any(local < margin) || any(local > 1.0 - margin)) {
        return vec2f(-1.0);
    }
    return local;
}

// How many texels of the strip's relief make one of the whole relief's, as log2: what a level is shifted by.
fn nbDetailLevels() -> f32 {
    let r = nbParams.detailRegion;
    return log2(f32(textureDimensions(nbDetailRelief).y) / (r.w - r.y) / f32(textureDimensions(nbReliefMap).y));
}

fn nbSampleMap(map: texture_2d<f32>, detail: texture_2d<f32>, lonLat: vec2f, footprint: NbFootprint) -> vec3f {
    let uv = nbMapUv(lonLat);
    let dx = nbUvStep(lonLat, footprint.across);
    let dy = nbUvStep(lonLat, footprint.along);
    let local = nbDetailUv(uv);
    if (local.x >= 0.0) {
        let scale = 1.0 / (nbParams.detailRegion.zw - nbParams.detailRegion.xy);
        return nbSampleIn(detail, local, dx * scale, dy * scale);
    }
    return nbSampleIn(map, uv, dx, dy);
}

// The color map at a point, sRGB-encoded.
fn nbColorAt(body: vec3f, footprint: NbFootprint) -> vec3f {
    return nbSampleMap(nbColorMap, nbDetailColor, nbSelenographic(body), footprint);
}

// Whether a point lies in the detail strip, where the relief's levels and texels are the strip's.
fn nbInDetail(body: vec3f) -> bool {
    return nbDetailUv(nbMapUv(nbSelenographic(body))).x >= 0.0;
}

// The relief's level for a ray's footprint, by its width across, for the march of the shadows; in the strip's levels
// where `fine`.
fn nbReliefLevel(body: vec3f, footprint: NbFootprint, fine: bool) -> f32 {
    let level = log2(max(length(footprint.across) * f32(textureDimensions(nbReliefMap).y) / NB_PI, 1e-4));
    return select(level, level + nbDetailLevels(), fine);
}

// The height at a point in km, and the slope there as a vector along the surface, in the Moon's frame, km per km.
fn nbReliefAt(body: vec3f, footprint: NbFootprint) -> vec4f {
    let lonLat = nbSelenographic(body);
    let relief = nbSampleMap(nbReliefMap, nbDetailRelief, lonLat, footprint);
    let east = vec3f(-sin(lonLat.x), cos(lonLat.x), 0.0);
    let north = vec3f(-sin(lonLat.y) * cos(lonLat.x), -sin(lonLat.y) * sin(lonLat.x), cos(lonLat.y));
    return vec4f(relief.x, relief.y * east + relief.z * north);
}

// The relief's height at a level: by the B-spline where the level is the finest, so the terrain the shadows are marched
// through is smooth and their edges do not follow the texels' creases, bilinearly between levels above it.
fn nbHeightIn(map: texture_2d<f32>, uv: vec2f, level: f32) -> f32 {
    if (level < 0.5) {
        return nbSampleBicubic(map, uv).x;
    }
    return textureSampleLevel(map, nbMapSampler, uv, level).x;
}

// The height at a point at a level, the strip's where `fine`; past the strip the whole relief's, the level turned.
fn nbHeightAt(body: vec3f, level: f32, fine: bool) -> f32 {
    let uv = nbMapUv(nbSelenographic(body));
    if (fine) {
        let local = nbDetailUv(uv);
        if (local.x >= 0.0) {
            return nbHeightIn(nbDetailRelief, local, level);
        }
        return nbHeightIn(nbReliefMap, uv, max(level - nbDetailLevels(), 0.0));
    }
    return nbHeightIn(nbReliefMap, uv, level);
}

// A texel of the relief along the equator, in km, the strip's where `fine`.
fn nbReliefTexelKm(fine: bool) -> f32 {
    let texel = 2.0 * NB_PI * nbParams.moonRadiusKm / f32(textureDimensions(nbReliefMap).x);
    return select(texel, texel * exp2(-nbDetailLevels()), fine);
}

struct NbMoon {
    // The disc's luminance along the ray, in cd/m², and how much of the pixel it covers.
    luminance: vec3f,
    coverage: f32,
    // The luminance under `compareLaw`, with NB_FLAG_COMPARE.
    reference: vec3f,
}

// Where a ray seen at `altitude` falls in the table: the entry below it and the share of the next.
fn nbTableAt(altitude: f32) -> vec2f {
    let p = nbParams;
    let x = clamp((altitude - p.refractionFrom) / p.refractionStep, 0.0, f32(NB_REFRACTION_SAMPLES - 1u));
    let i = min(floor(x), f32(NB_REFRACTION_SAMPLES - 2u));
    return vec2f(i, x - i);
}

// How far the air bends a ray seen at `altitude` down, in radians, read from the table between its entries.
fn nbBend(altitude: f32) -> f32 {
    let at = nbTableAt(altitude);
    let i = u32(at.x);
    let a = nbParams.refraction[i / 4u][i % 4u];
    let b = nbParams.refraction[(i + 1u) / 4u][(i + 1u) % 4u];
    return mix(a, b, at.y);
}

// What the air lets through along `view`, per channel: from the table where it has transmittances, else the one given.
fn nbTransmittance(view: vec3f) -> vec3f {
    if ((nbParams.flags & NB_FLAG_AIR) == 0u || nbParams.refractionStep <= 0.0) {
        return nbParams.transmittance;
    }
    let at = nbTableAt(atan2(view.z, length(view.xy)));
    let i = u32(at.x);
    return mix(nbParams.airTransmittance[i].rgb, nbParams.airTransmittance[i + 1u].rgb, at.y);
}

// The ray as it left the atmosphere: turned down within its vertical plane by the bend the air gave it, the way
// dunstkreis bends its rays to find the sun disc. The lower limb is lifted more than the upper, so the disc shows
// squeezed near the horizon, and a ray that ends on the ground meets no Moon.
fn nbUnbend(view: vec3f) -> vec3f {
    let horizontal = length(view.xy);
    if (nbParams.refractionStep <= 0.0 || horizontal < 1e-6) {
        return view;
    }
    let apparent = atan2(view.z, horizontal);
    let altitude = apparent - nbBend(apparent);
    return vec3f(view.xy / horizontal * cos(altitude), sin(altitude));
}

// Up to which elevation over its horizontal the Sun can still be hidden from a point by the terrain, in radians: no
// crater rim or mountain stands steeper above a point than some 25°. Above it, no march.
const NB_SHADOW_ELEVATION: f32 = 0.45;
// Steps towards the Sun, each this much farther than the last, from three quarters of a texel on: 24 of them reach
// some 450 km on the 4096 texel map, as far as a mountain's shadow runs with the Sun a degree up.
const NB_SHADOW_STEPS: u32 = 24u;
const NB_SHADOW_GROWTH: f32 = 1.26;

// How much of the Sun's disc stands above the terrain's horizon towards it, seen from a point of the surface: the
// relief marched along the great circle towards the Sun, the highest elevation the terrain reaches above the point's
// horizontal, and the share of the Sun's disc above it. Near what casts it that angle changes fast and the shadow's
// edge is sharp; far from it slowly, and the penumbra widens with the distance, as the Sun's half degree makes it.
// `up` the point's direction and `sun` the Sun's, in the Moon's frame; `height` its height in km; `lod` its level.
fn nbSunAboveTerrain(up: vec3f, sun: vec3f, height: f32, lod: f32, fine: bool) -> f32 {
    return nbAboveTerrain(up, sun, height, lod, fine, nbParams.sunAngularRadius);
}

// The same for any direction, a disc of `radius` around it: the Sun's, or the viewer's, a point.
fn nbAboveTerrain(up: vec3f, sun: vec3f, height: f32, lod: f32, fine: bool, radius: f32) -> f32 {
    let p = nbParams;
    let elevation = asin(clamp(dot(sun, up), -1.0, 1.0));
    let along = sun - dot(sun, up) * up;
    if (elevation > NB_SHADOW_ELEVATION || length(along) < 1e-6) {
        return 1.0;
    }
    let toward = normalize(along);
    let texelKm = nbReliefTexelKm(fine);
    let origin = (p.moonRadiusKm + height) * up;
    var horizon = -0.5 * NB_PI;
    for (var k = 0u; k < NB_SHADOW_STEPS; k = k + 1u) {
        let distanceKm = 0.75 * texelKm * pow(NB_SHADOW_GROWTH, f32(k));
        let angle = distanceKm / p.moonRadiusKm;
        let q = up * cos(angle) + toward * sin(angle);
        // Read as coarse as the steps are apart, so no peak falls between two of them.
        let level = max(lod, log2(distanceKm * 0.3 / texelKm));
        let h = nbHeightAt(q, level, fine);
        let to = (p.moonRadiusKm + h) * q - origin;
        horizon = max(horizon, atan2(dot(to, up), dot(to, toward)));
        if (horizon > elevation + radius) {
            return 0.0;
        }
    }
    // The share of a disc above a line through it, the line x radii below its center.
    let x = clamp((elevation - horizon) / radius, -1.0, 1.0);
    return 0.5 + (x * sqrt(1.0 - x * x) + asin(x)) / NB_PI;
}

// One ray's share of a pixel: `view` as seen, `sampleAngle` the width it stands for among the pixel's rays, and
// `pixelAngle` the whole pixel's, which the maps are filtered over: the rays resolve the shading and the shadows'
// edges, the filtering the maps, so more rays sharpen the one and never alias the other.
fn nbMoon(view: vec3f, sampleAngle: f32, pixelAngle: f32) -> NbMoon {
    let p = nbParams;
    let m = p.direction;
    let v = nbUnbend(view);
    let cosC = dot(v, m);
    let angle = acos(clamp(cosC, -1.0, 1.0));
    // The limb antialiased by the ray's share of the pixel; the ground hides whatever is below the horizon.
    var coverage = clamp((p.angularRadius - angle) / max(sampleAngle, 1e-7) + 0.5, 0.0, 1.0);
    if (view.z < p.horizonZ) {
        coverage = 0.0;
    }
    if (coverage <= 0.0) {
        return NbMoon(vec3f(0.0), 0.0, vec3f(0.0));
    }
    // The sphere of that angular radius at unit distance, hit where the ray enters it; a ray past the limb takes the
    // point nearest the center, so the partly covered rays at the edge are shaded like the limb.
    let sinA = sin(p.angularRadius);
    let t = cosC - sqrt(max(cosC * cosC - 1.0 + sinA * sinA, 0.0));
    let n = normalize(t * v - m);
    let body = p.orientation * n;
    let mu = max(dot(n, -v), 0.0);
    // The pixel's footprint on the sphere: its width across, and along the line of sight stretched by the slant, up to
    // fifty times at the limb. The maps are filtered anisotropically over it, so the limb and the poles stay sharp.
    let width = pixelAngle / sinA;
    let toViewer = p.orientation * -v;
    let side = toViewer - dot(toViewer, body) * body;
    let helper = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(body.z) > 0.9);
    let along = select(normalize(cross(body, helper)), normalize(side), length(side) > 1e-5);
    let footprint = NbFootprint(cross(body, along) * width, along * width / max(mu, 0.02));

    var albedo = vec3f(p.albedo);
    if ((p.flags & NB_FLAG_COLOR) != 0u) {
        albedo = nbSrgbToLinear(nbColorAt(body, footprint)) * p.albedoScale;
        if ((p.flags & NB_FLAG_GRAY) != 0u) {
            albedo = vec3f(dot(albedo, vec3f(0.2126, 0.7152, 0.0722)));
        } else if ((p.flags & NB_FLAG_UNTINTED) == 0u) {
            albedo = albedo * p.albedoTint;
        }
    }
    // The relief: the surface's normal from its slope, and its height for the shadows.
    var shading = n;
    var height = 0.0;
    var reliefLod = 0.0;
    let fine = nbInDetail(body);
    if ((p.flags & NB_FLAG_RELIEF) != 0u) {
        reliefLod = nbReliefLevel(body, footprint, fine);
        let relief = nbReliefAt(body, footprint);
        height = relief.x;
        shading = transpose(p.orientation) * normalize(body - relief.yzw);
    }

    // Sunlight by the reflectance law: the phase angle between the Sun and the viewer at that point.
    let s = p.sunDirection;
    let g = acos(clamp(dot(s, -v), -1.0, 1.0));
    // A slope turned away from the viewer is a facet the terrain in front would hide; the ray meets the smooth sphere
    // and sees it anyway, black near the limb at full Moon. Tilted towards the viewer until it faces them a little.
    let facing = dot(shading, -v);
    if (facing < NB_FACING) {
        shading = normalize(shading - v * (NB_FACING - facing));
    }
    let mu0 = dot(shading, s);
    let muView = dot(shading, -v);
    // What reaches the point of the sunlight: the terrain's shadows and Earth's.
    var shade = vec3f(1.0);
    if ((p.flags & NB_FLAG_SHADOWS) != 0u && mu0 > 0.0) {
        // The rays meet the smooth sphere, not the heights: near the limb a point the terrain in front hides from the
        // viewer is seen anyway. Its shadow is then the hidden part of the occluder's, which near full Moon, the Sun at
        // the viewer's back, the eye would not see: where the viewer cannot see the point, it takes no shadow.
        let sunShare = nbSunAboveTerrain(body, p.orientation * s, height, reliefLod, fine);
        let seen = select(1.0, nbAboveTerrain(body, toViewer, height, reliefLod, fine, p.sunAngularRadius), sunShare < 1.0);
        shade = shade * mix(1.0, sunShare, seen);
    }
    if ((p.flags & NB_FLAG_ECLIPSE) != 0u && mu0 > 0.0) {
        shade = shade * nbShadow(p, p.moonCenterKm + n * p.moonRadiusKm);
    }
    // Earthshine comes from Earth's center, which the Moon sees up to a degree off the observer: near opposition.
    let e = p.earthDirection;
    let ge = acos(clamp(dot(e, -v), -1.0, 1.0));
    let mu0e = dot(shading, e);
    let through = albedo * nbTransmittance(view);
    let lit = p.sunIlluminance * nbReflectance(p.law, mu0, muView, g) * shade;
    let luminance = through * (lit + p.earthshine * nbReflectance(p.law, mu0e, muView, ge));
    var reference = vec3f(0.0);
    if ((p.flags & NB_FLAG_COMPARE) != 0u) {
        let litReference = p.sunIlluminance * nbReflectance(p.compareLaw, mu0, muView, g) * shade;
        reference = through * (litReference + p.earthshine * nbReflectance(p.compareLaw, mu0e, muView, ge));
    }
    return NbMoon(luminance, coverage, reference);
}

// Rays per pixel on and around the disc, spread by Roberts' R2 sequence: the terminator, the limb and the relief's
// shading are all sharper than a pixel. Along the terminator, where the Sun stands low over the relief and every
// crater rim turns from lit to dark within a texel, NB_TERMINATOR_SAMPLES rays instead.
override NB_SAMPLES: u32 = 8u;
// Whether magnified maps are read by the cubic B-spline, rather than as the sampler filters them.
override NB_MAP_BSPLINE: bool = true;
override NB_TERMINATOR_SAMPLES: u32 = 32u;
// How much at least a slope faces the viewer, as the cosine of its normal to the line of sight.
const NB_FACING: f32 = 0.05;
// How near the terminator a pixel takes the extra rays: the cosine of the Sun's angle over the surface at its center.
const NB_TERMINATOR_BAND: f32 = 0.35;

fn nbR2(i: u32) -> vec2f {
    return fract(vec2f(0.5) + f32(i) * vec2f(0.7548776662466927, 0.5698402909980532)) - 0.5;
}

// Whether a pixel's center ray meets the Moon near the terminator, where the relief's shading changes fastest.
fn nbNearTerminator(center: vec3f) -> bool {
    let p = nbParams;
    let v = nbUnbend(center);
    let cosC = dot(v, p.direction);
    let sinA = sin(p.angularRadius);
    let t = cosC - sqrt(max(cosC * cosC - 1.0 + sinA * sinA, 0.0));
    let n = normalize(t * v - p.direction);
    return abs(dot(n, p.sunDirection)) < NB_TERMINATOR_BAND;
}

// The air's shimmer. Turbulence tilts the light arriving, and the image wanders: by an rms angle that grows with the
// air crossed as the Fried parameter shrinks, r0 ~ airmass^-3/5, the tilt ~ r0^-5/6. The air also bends blue more than
// red, by about a hundredth of the refraction, so near the horizon each color comes from a little higher than the one
// redder than it. Both are given per disc, from the air between the observer and the Moon; the turbulence is a few
// drifting waves on the sky, cells some 20 arcseconds across, anchored to azimuth and altitude.
fn nbTurbulence(q: vec2f, t: f32) -> vec2f {
    var d = vec2f(0.0);
    var k = 1.0;
    for (var i = 0u; i < 4u; i = i + 1u) {
        let angle = f32(i) * 2.399963;
        let dir = vec2f(cos(angle), sin(angle));
        let across = vec2f(-dir.y, dir.x);
        let phase = dot(q, dir) * k + t * (1.7 + 0.6 * f32(i)) + f32(i) * 1.3;
        let phase2 = dot(q, across) * k * 1.13 - t * (1.3 + 0.5 * f32(i)) + f32(i) * 2.1;
        d = d + vec2f(sin(phase) + 0.6 * sin(phase2), cos(phase2) + 0.6 * cos(phase)) / k;
        k = k * 1.9;
    }
    // About unit rms.
    return d * 0.45;
}

// Red's, green's and blue's rays for a pixel's ray: moved by the turbulence, and spread apart towards the zenith.
fn nbShimmered(ray: vec3f) -> array<vec3f, 3> {
    let w = nbParams.shimmer;
    var up = vec3f(0.0, 0.0, 1.0) - ray.z * ray;
    up = select(vec3f(0.0, 1.0, 0.0), normalize(up), length(up) > 1e-5);
    let right = cross(ray, up);
    let alt = asin(clamp(ray.z, -1.0, 1.0));
    let q = vec2f(atan2(ray.x, ray.y) * cos(alt), alt) * (206265.0 / 20.0);
    let d = nbTurbulence(q, w.y) * w.x;
    let moved = normalize(ray + right * d.x + up * d.y);
    let spread = w.z;
    return array<vec3f, 3>(
        normalize(moved - up * spread * 0.0045),
        moved,
        normalize(moved + up * spread * 0.0065),
    );
}

// The disc over a pixel: the mean of the rays through it where the disc may reach, nothing elsewhere. Their light is
// averaged as a sensor does, then the pixel tone mapped.
fn nbPixel(pixel: vec2f, size: vec2u) -> NbMoon {
    let center = nbPixelRay(pixel, size);
    let pixelAngle = length(nbPixelRay(pixel + vec2f(1.0, 0.0), size) - center);
    // The refraction moves the disc by up to a degree and squeezes it: tested on the bent ray, with room for both.
    let reach = nbParams.angularRadius * 1.3 + 3.0 * pixelAngle;
    if (acos(clamp(dot(nbUnbend(center), nbParams.direction), -1.0, 1.0)) > reach) {
        return NbMoon(vec3f(0.0), 0.0, vec3f(0.0));
    }
    var count = NB_SAMPLES;
    if (NB_TERMINATOR_SAMPLES > NB_SAMPLES && (nbParams.flags & NB_FLAG_RELIEF) != 0u && nbNearTerminator(center)) {
        count = NB_TERMINATOR_SAMPLES;
    }
    let sampleAngle = pixelAngle * inverseSqrt(f32(count));
    var luminance = vec3f(0.0);
    var coverage = 0.0;
    var reference = vec3f(0.0);
    let shimmer = (nbParams.flags & NB_FLAG_SHIMMER) != 0u;
    for (var i = 0u; i < count; i = i + 1u) {
        let offset = select(nbR2(i), vec2f(0.0), count == 1u);
        let ray = nbPixelRay(pixel + offset, size);
        if (shimmer) {
            // Each channel along its own ray where the air spreads them apart, one ray for all where it does not.
            let rays = nbShimmered(ray);
            let spread = length(rays[2] - rays[0]);
            if (spread < 0.25 * sampleAngle) {
                let moon = nbMoon(rays[1], sampleAngle, pixelAngle);
                luminance = luminance + moon.luminance * moon.coverage;
                coverage = coverage + moon.coverage;
                reference = reference + moon.reference * moon.coverage;
            } else {
                let r = nbMoon(rays[0], sampleAngle, pixelAngle);
                let g = nbMoon(rays[1], sampleAngle, pixelAngle);
                let b = nbMoon(rays[2], sampleAngle, pixelAngle);
                luminance = luminance + vec3f(r.luminance.r * r.coverage, g.luminance.g * g.coverage, b.luminance.b * b.coverage);
                coverage = coverage + g.coverage;
                reference = reference + vec3f(r.reference.r * r.coverage, g.reference.g * g.coverage, b.reference.b * b.coverage);
            }
            continue;
        }
        let moon = nbMoon(ray, sampleAngle, pixelAngle);
        luminance = luminance + moon.luminance * moon.coverage;
        coverage = coverage + moon.coverage;
        reference = reference + moon.reference * moon.coverage;
    }
    let n = f32(count);
    return NbMoon(luminance / n, coverage / n, reference / n);
}

@compute @workgroup_size(8, 8, 1)
fn nbCompose(@builtin(global_invocation_id) id: vec3u) {
    let size = nbOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    // The disc's light, premultiplied by how much of the pixel it covers.
    let moon = nbPixel(vec2f(id.xy) + 0.5, size);
    var color = moon.luminance;
    var alpha = moon.coverage;
    if (NB_BACKGROUND) {
        color = color + textureLoad(nbBackground, vec2i(id.xy), 0).rgb;
        alpha = 1.0;
        if (NB_NIGHT_VISION) {
            color = hdNightVision(color);
        }
    }
    color = color * nbParams.exposure;
    if (NB_TONE_MAP != 0u) {
        color = nbToneMap(color);
        if (NB_DITHER) {
            color = clamp(hdDither(color, id.xy, 255.0), vec3f(0.0), hdEncodeSrgbExtended(vec3f(NB_HEADROOM), NB_HEADROOM));
        }
    }
    // Striped where the disc is off the law it is compared with by more than a third of a stop, as a camera stripes
    // what clips: red where it is brighter, blue where darker, in four steps of opacity, from a third of a stop, two
    // thirds, one and two stops off; and only where either is bright enough to tell.
    if ((nbParams.flags & NB_FLAG_COMPARE) != 0u && moon.coverage > 0.5 && (id.x + id.y) % 6u < 3u) {
        let weights = vec3f(0.2126, 0.7152, 0.0722);
        let shown = dot(moon.luminance, weights);
        let reference = dot(moon.reference, weights);
        let floor = 1e-3 / max(nbParams.exposure, 1e-12);
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
    nbOutputStore(id.xy, vec4f(color, alpha));
}
