// The Moon's disc along every pixel's ray, over a background in cd/m² where there is one, then exposed and tone mapped
// like dunstkreis' sky, or left linear. Requires `params.wgsl`, `camera.wgsl` (dunstkreis'), `surface.wgsl`,
// `tonemap.wgsl` (helldunkel's) and the output binding from `moonOutput`.

@group(0) @binding(0) var<uniform> nbParams: NbParams;
@group(0) @binding(1) var nbColorMap: texture_2d<f32>;
@group(0) @binding(2) var nbNormalMap: texture_2d<f32>;
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

fn nbMoon(v: vec3f, pixelAngle: f32) -> NbMoon {
    let p = nbParams;
    let m = p.direction;
    let cosC = dot(v, m);
    let angle = acos(clamp(cosC, -1.0, 1.0));
    // The limb antialiased by the pixel's width; the ground hides whatever is below the horizon.
    var coverage = clamp((p.angularRadius - angle) / max(pixelAngle, 1e-7) + 0.5, 0.0, 1.0);
    if (v.z < p.horizonZ) {
        coverage = 0.0;
    }
    if (coverage <= 0.0) {
        return NbMoon(vec3f(0.0), 0.0);
    }
    // The sphere of that angular radius at unit distance, hit where the ray enters it; a ray past the limb takes the
    // point nearest the center, so the partly covered pixels at the edge are shaded like the limb.
    let sinA = sin(p.angularRadius);
    let t = cosC - sqrt(max(cosC * cosC - 1.0 + sinA * sinA, 0.0));
    let n = normalize(t * v - m);
    let body = p.orientation * n;
    let lonLat = nbSelenographic(body);
    let uv = nbMapUv(lonLat);
    let mu = max(dot(n, -v), 0.0);
    // A pixel's width on the sphere, in radians of its surface, stretched where the surface is seen at a slant.
    let footprint = pixelAngle / sinA / max(mu, 0.25);

    var albedo = vec3f(p.albedo);
    if ((p.flags & NB_FLAG_COLOR) != 0u) {
        let lod = nbLod(textureDimensions(nbColorMap), footprint, lonLat.y);
        albedo = nbSrgbToLinear(textureSampleLevel(nbColorMap, nbMapSampler, uv, lod).rgb) * p.albedoScale;
    }
    var shading = n;
    if ((p.flags & NB_FLAG_NORMALS) != 0u) {
        let lod = nbLod(textureDimensions(nbNormalMap), footprint, lonLat.y);
        let tangent = textureSampleLevel(nbNormalMap, nbMapSampler, uv, lod).rgb * vec3f(2.0, 2.0, 1.0) - vec3f(1.0, 1.0, 0.0);
        shading = transpose(p.orientation) * nbBodyNormal(lonLat, tangent);
    }

    // Sunlight by the reflectance law: the phase angle between the Sun and the viewer at that point.
    let s = p.sunDirection;
    let g = acos(clamp(dot(s, -v), -1.0, 1.0));
    let mu0 = dot(shading, s);
    let muView = dot(shading, -v);
    var sunlight = vec3f(p.sunIlluminance * nbReflectance(p.law, mu0, muView, g));
    if ((p.flags & NB_FLAG_ECLIPSE) != 0u && mu0 > 0.0) {
        sunlight = sunlight * nbShadow(p, p.moonCenterKm + n * p.moonRadiusKm);
    }
    // Earthshine comes from where we look from, at a phase angle of 0.
    let earthlight = p.earthshine * nbReflectance(p.law, dot(shading, -m), muView, 0.0);
    return NbMoon(albedo * (sunlight + earthlight) * p.transmittance, coverage);
}

@compute @workgroup_size(8, 8, 1)
fn nbCompose(@builtin(global_invocation_id) id: vec3u) {
    let size = nbOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let pixel = vec2f(id.xy) + 0.5;
    let v = nbPixelRay(pixel, size);
    let pixelAngle = length(nbPixelRay(pixel + vec2f(1.0, 0.0), size) - v);
    let moon = nbMoon(v, pixelAngle);
    var color = moon.luminance * moon.coverage;
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
