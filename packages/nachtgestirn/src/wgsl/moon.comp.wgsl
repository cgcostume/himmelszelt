// The Moon's disc along every pixel's ray, over a background in cd/m² where there is one, then exposed and tone mapped
// like dunstkreis' sky, or left linear. Requires `params.wgsl`, `camera.wgsl` (dunstkreis'), `surface.wgsl`,
// `tonemap.wgsl` (helldunkel's) and the output binding from `moonOutput`.

@group(0) @binding(0) var<uniform> nbParams: NbParams;
@group(0) @binding(1) var nbColorMap: texture_2d<f32>;
@group(0) @binding(2) var nbReliefMap: texture_2d<f32>;
@group(0) @binding(3) var nbMapSampler: sampler;
@group(0) @binding(4) var nbBackground: texture_2d<f32>;

// Tone map for a display by Neutral (1), AgX (2), ACES (3) or none (4); 0 writes the exposed luminance, linear.
override NB_TONE_MAP: u32 = 1u;
override NB_HEADROOM: f32 = 1.0;
override NB_DITHER: bool = true;
// Whether a background is bound; without one the Moon alone is written, premultiplied, with its coverage in alpha.
override NB_BACKGROUND: bool = true;

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

// The mip level at which a map of `size` texels has about one texel per pixel at a point of the disc: `footprint` is
// a pixel's width on the Moon's unit sphere in radians, the map's texels per radian grow towards the poles.
fn nbLod(size: vec2u, footprint: f32, latitude: f32) -> f32 {
    let s = vec2f(size);
    let east = footprint * s.x / (2.0 * NB_PI) / max(cos(latitude), 0.01);
    let north = footprint * s.y / NB_PI;
    return log2(max(max(east, north), 1e-4));
}

struct NbMoon {
    // The disc's luminance along the ray, in cd/m², and how much of the pixel it covers.
    luminance: vec3f,
    coverage: f32,
}

// How far the air bends a ray seen at `altitude` down, in radians, read from the table between its entries.
fn nbBend(altitude: f32) -> f32 {
    let p = nbParams;
    let x = clamp((altitude - p.refractionFrom) / p.refractionStep, 0.0, f32(NB_REFRACTION_SAMPLES - 1u));
    let i = min(u32(x), NB_REFRACTION_SAMPLES - 2u);
    let a = p.refraction[i / 4u][i % 4u];
    let b = p.refraction[(i + 1u) / 4u][(i + 1u) % 4u];
    return mix(a, b, x - f32(i));
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

// A map read at `lod`; magnified, by a cubic B-spline in four bilinear taps after Sigg and Hadwiger, so the texels'
// edges do not show as steps along the terminator.
fn nbSampleMap(map: texture_2d<f32>, uv: vec2f, lod: f32) -> vec3f {
    if (lod > 0.0) {
        return textureSampleLevel(map, nbMapSampler, uv, lod).rgb;
    }
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
fn nbSunAboveTerrain(up: vec3f, sun: vec3f, height: f32, lod: f32) -> f32 {
    let p = nbParams;
    let elevation = asin(clamp(dot(sun, up), -1.0, 1.0));
    let along = sun - dot(sun, up) * up;
    if (elevation > NB_SHADOW_ELEVATION || length(along) < 1e-6) {
        return 1.0;
    }
    let toward = normalize(along);
    let texelKm = 2.0 * NB_PI * p.moonRadiusKm / f32(textureDimensions(nbReliefMap).x);
    let origin = (p.moonRadiusKm + height) * up;
    var horizon = -0.5 * NB_PI;
    for (var k = 0u; k < NB_SHADOW_STEPS; k = k + 1u) {
        let distanceKm = 0.75 * texelKm * pow(NB_SHADOW_GROWTH, f32(k));
        let angle = distanceKm / p.moonRadiusKm;
        let q = up * cos(angle) + toward * sin(angle);
        // Read as coarse as the steps are apart, so no peak falls between two of them.
        let level = max(lod, log2(distanceKm * 0.3 / texelKm));
        let h = textureSampleLevel(nbReliefMap, nbMapSampler, nbMapUv(nbSelenographic(q)), level).x;
        let to = (p.moonRadiusKm + h) * q - origin;
        horizon = max(horizon, atan2(dot(to, up), dot(to, toward)));
        if (horizon > elevation + p.sunAngularRadius) {
            return 0.0;
        }
    }
    // The share of a disc above a line through it, the line x radii below its center.
    let x = clamp((elevation - horizon) / p.sunAngularRadius, -1.0, 1.0);
    return 0.5 + (x * sqrt(1.0 - x * x) + asin(x)) / NB_PI;
}

// One ray's share of a pixel: `view` as seen, `sampleAngle` the width it stands for.
fn nbMoon(view: vec3f, sampleAngle: f32) -> NbMoon {
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
        return NbMoon(vec3f(0.0), 0.0);
    }
    // The sphere of that angular radius at unit distance, hit where the ray enters it; a ray past the limb takes the
    // point nearest the center, so the partly covered rays at the edge are shaded like the limb.
    let sinA = sin(p.angularRadius);
    let t = cosC - sqrt(max(cosC * cosC - 1.0 + sinA * sinA, 0.0));
    let n = normalize(t * v - m);
    let body = p.orientation * n;
    let lonLat = nbSelenographic(body);
    let uv = nbMapUv(lonLat);
    let mu = max(dot(n, -v), 0.0);
    // A ray's width on the sphere, in radians of its surface, stretched where the surface is seen at a slant.
    let footprint = sampleAngle / sinA / max(mu, 0.25);

    var albedo = vec3f(p.albedo);
    if ((p.flags & NB_FLAG_COLOR) != 0u) {
        let lod = nbLod(textureDimensions(nbColorMap), footprint, lonLat.y);
        albedo = nbSrgbToLinear(nbSampleMap(nbColorMap, uv, lod)) * p.albedoScale * p.albedoTint;
    }
    // The relief: the surface's normal from the slopes, and its height for the shadows.
    var shading = n;
    var height = 0.0;
    var reliefLod = 0.0;
    if ((p.flags & NB_FLAG_RELIEF) != 0u) {
        reliefLod = nbLod(textureDimensions(nbReliefMap), footprint, lonLat.y);
        let relief = nbSampleMap(nbReliefMap, uv, reliefLod);
        height = relief.x;
        shading = transpose(p.orientation) * nbBodyNormal(lonLat, normalize(vec3f(-relief.y, -relief.z, 1.0)));
    }

    // Sunlight by the reflectance law: the phase angle between the Sun and the viewer at that point.
    let s = p.sunDirection;
    let g = acos(clamp(dot(s, -v), -1.0, 1.0));
    let mu0 = dot(shading, s);
    let muView = dot(shading, -v);
    var sunlight = vec3f(p.sunIlluminance * nbReflectance(p.law, mu0, muView, g));
    if ((p.flags & NB_FLAG_SHADOWS) != 0u && mu0 > 0.0) {
        sunlight = sunlight * nbSunAboveTerrain(body, p.orientation * s, height, reliefLod);
    }
    if ((p.flags & NB_FLAG_ECLIPSE) != 0u && mu0 > 0.0) {
        sunlight = sunlight * nbShadow(p, p.moonCenterKm + n * p.moonRadiusKm);
    }
    // Earthshine comes from Earth's center, which the Moon sees up to a degree off the observer: near opposition.
    let e = p.earthDirection;
    let ge = acos(clamp(dot(e, -v), -1.0, 1.0));
    let earthlight = p.earthshine * nbReflectance(p.law, dot(shading, e), muView, ge);
    return NbMoon(albedo * (sunlight + earthlight) * p.transmittance, coverage);
}

// Rays per pixel on and around the disc, spread by Roberts' R2 sequence: the terminator, the limb and the relief's
// shading are all sharper than a pixel.
override NB_SAMPLES: u32 = 8u;

fn nbR2(i: u32) -> vec2f {
    return fract(vec2f(0.5) + f32(i) * vec2f(0.7548776662466927, 0.5698402909980532)) - 0.5;
}

// The disc over a pixel: the mean of NB_SAMPLES rays through it where the disc may reach, nothing elsewhere.
fn nbPixel(pixel: vec2f, size: vec2u) -> NbMoon {
    let center = nbPixelRay(pixel, size);
    let pixelAngle = length(nbPixelRay(pixel + vec2f(1.0, 0.0), size) - center);
    // The refraction moves the disc by up to a degree and squeezes it: tested on the bent ray, with room for both.
    let reach = nbParams.angularRadius * 1.3 + 3.0 * pixelAngle;
    if (acos(clamp(dot(nbUnbend(center), nbParams.direction), -1.0, 1.0)) > reach) {
        return NbMoon(vec3f(0.0), 0.0);
    }
    let sampleAngle = pixelAngle * inverseSqrt(f32(NB_SAMPLES));
    var luminance = vec3f(0.0);
    var coverage = 0.0;
    for (var i = 0u; i < NB_SAMPLES; i = i + 1u) {
        let offset = select(nbR2(i), vec2f(0.0), NB_SAMPLES == 1u);
        let moon = nbMoon(nbPixelRay(pixel + offset, size), sampleAngle);
        luminance = luminance + moon.luminance * moon.coverage;
        coverage = coverage + moon.coverage;
    }
    return NbMoon(luminance / f32(NB_SAMPLES), coverage / f32(NB_SAMPLES));
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
    }
    color = color * nbParams.exposure;
    if (NB_TONE_MAP != 0u) {
        color = nbToneMap(color);
        if (NB_DITHER) {
            color = clamp(hdDither(color, id.xy, 255.0), vec3f(0.0), hdEncodeSrgbExtended(vec3f(NB_HEADROOM), NB_HEADROOM));
        }
    }
    nbOutputStore(id.xy, vec4f(color, alpha));
}
