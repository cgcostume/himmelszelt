// The stars and the Milky Way along every pixel's ray, over a background in cd/m² where there is one, then exposed and
// tone mapped like dunstkreis' sky, or left linear. Requires `params.wgsl`, `camera.wgsl` (dunstkreis'), `glare.wgsl`,
// `tonemap.wgsl` and `vision.wgsl` (helldunkel's) and `stars.wgsl`, and an output binding, `starsOutput(format)`.

@group(0) @binding(0) var<uniform> shParams: ShParams;
@group(0) @binding(1) var<storage, read> shCatalog: array<f32>;
@group(0) @binding(2) var<storage, read> shSplats: array<ShSplat>;
@group(0) @binding(3) var<storage, read> shTileCounts: array<u32>;
@group(0) @binding(4) var<storage, read> shTileEntries: array<u32>;
@group(0) @binding(5) var shMilkyWay: texture_2d<f32>;
@group(0) @binding(6) var shMilkyWaySampler: sampler;
@group(0) @binding(7) var shBackground: texture_2d<f32>;
// The halos' pyramid added up, `halo.comp.wgsl`.
@group(0) @binding(8) var shHalos: texture_2d<f32>;
// The constellations' lines in pieces, binned into tiles, `lines.comp.wgsl`.
@group(0) @binding(9) var<storage, read> shPieces: array<ShPiece>;
@group(0) @binding(10) var<storage, read> shLineCounts: array<u32>;
@group(0) @binding(11) var<storage, read> shLineEntries: array<u32>;
// Named by `stars.wgsl`, read by the other passes only.
@group(0) @binding(12) var<storage, read> shFaint: array<u32>;
@group(0) @binding(13) var<storage, read> shFaintColors: array<vec4f>;

// The tone curve, as dunstkreis' sky pass numbers them: 0 none, the exposed luminance linear, 1 neutral, 2 AgX,
// 3 ACES, 4 clip; the display's headroom; dithering for an 8-bit target.
override SH_TONE_MAP: u32 = 1u;
override SH_HEADROOM: f32 = 1.0;
override SH_DITHER: bool = true;
// Whether a background is bound; without one the stars' light alone is written, to add.
override SH_BACKGROUND: bool = true;
// The composed light as the eye sees it at night, with a background: the rods' blue shift, `hdDarkAdaptedEye`.
override SH_DARK_ADAPTED: bool = false;

fn shToneMap(exposed: vec3f) -> vec3f {
    if (SH_TONE_MAP == 2u) {
        return hdToneMapAgx(exposed);
    }
    if (SH_TONE_MAP == 3u) {
        return hdToneMapAces(exposed);
    }
    if (SH_TONE_MAP == 4u) {
        return hdToneMapClipHdr(exposed, SH_HEADROOM);
    }
    return hdToneMapNeutralHdr(exposed, SH_HEADROOM);
}

// The light of the stars binned into the pixel's tile that reaches the pixel, in cd/m²: each star's core, a Gaussian
// whose exposed peak stops at the knee, and the eye's veil around it, CIE's glare equation of a point source.
fn shStarsAt(pixel: vec2f, tile: u32) -> vec3f {
    let count = min(shTileCounts[tile], shParams.capacity);
    var sum = vec3f(0.0);
    for (var k = 0u; k < count; k = k + 1u) {
        let splat = shSplats[shTileEntries[tile * shParams.capacity + k]];
        let d = pixel - splat.pixel;
        let r2 = dot(d, d);
        if (r2 > splat.radius * splat.radius) {
            continue;
        }
        var factor = splat.core * splat.peak * exp(-0.5 * r2 / (splat.sigma * splat.sigma));
        if (shParams.glare > 0.0) {
            factor = factor + shParams.glare * hdVeilingGlare(sqrt(r2) * shParams.screenDegreesPerPixel, 30.0, 1.0);
        }
        sum = sum + splat.light * factor;
    }
    return sum;
}

// The halos at a pixel, in cd/m²: the pyramid's sum of every star's light beyond its knee, falling as 1 / r², shown
// rising only logarithmically towards the halo's knee, its hue kept, so a brighter star's halo grows wider rather
// than whiter.
fn shHaloAt(pixel: vec2f) -> vec3f {
    let uv = (pixel + f32(SH_HALO_MARGIN)) / vec2f(shHaloSize() * SH_HALO_SCALE);
    let light = textureSampleLevel(shHalos, shMilkyWaySampler, uv, 0.0).rgb / shParams.haloLevels;
    let brightest = max(light.r, max(light.g, light.b));
    if (brightest <= 0.0) {
        return vec3f(0.0);
    }
    return light * (SH_HALO_KNEE * log(1.0 + brightest / SH_HALO_KNEE) / (brightest * shParams.displayExposure));
}

// How much of a constellation's line covers the pixel: the nearest piece's, antialiased over a pixel, fading out
// towards the two stars the line joins, so it points at them without touching them.
fn shLinesAt(pixel: vec2f, tile: u32) -> f32 {
    let count = min(shLineCounts[tile], SH_LINE_CAPACITY);
    var cover = 0.0;
    for (var k = 0u; k < count; k = k + 1u) {
        let piece = shPieces[shLineEntries[tile * SH_LINE_CAPACITY + k]];
        let along = piece.b - piece.a;
        let t = clamp(dot(pixel - piece.a, along) / max(dot(along, along), 1e-6), 0.0, 1.0);
        let distance = length(pixel - (piece.a + along * t));
        let gap = smoothstep(shParams.lineGap, shParams.lineGap + 3.0, min(length(pixel - piece.starA), length(pixel - piece.starB)));
        cover = max(cover, piece.shown * gap * clamp(0.5 * shParams.lineWidth + 0.5 - distance, 0.0, 1.0));
    }
    return cover;
}

// The Milky Way's light along a true direction: the map, in J2000 equatorial coordinates with right ascension
// increasing to the left, as NASA's Deep Star Maps lay it out, times what a texel stands for.
fn shMilkyWayAt(direction: vec3f) -> vec3f {
    let equatorial = transpose(shParams.skyRotation) * direction;
    let rightAscension = atan2(equatorial.y, equatorial.x);
    let declination = asin(clamp(equatorial.z, -1.0, 1.0));
    let uv = vec2f(fract(0.5 - rightAscension / (2.0 * SH_PI)), (0.5 * SH_PI - declination) / SH_PI);
    var light = textureSampleLevel(shMilkyWay, shMilkyWaySampler, uv, 0.0).rgb;
    if (shParams.milkyWayStops > 0.0) {
        // Each channel's logarithm, read between the texels in stops; the darkest step is black.
        light = select(exp2((light - 1.0) * shParams.milkyWayStops), vec3f(0.0), light <= vec3f(0.0));
    }
    return light * (shParams.milkyWayLuminance * shParams.milkyWay);
}

@compute @workgroup_size(8, 8, 1)
fn shCompose(@builtin(global_invocation_id) id: vec3u) {
    let p = shParams;
    if (id.x >= p.width || id.y >= p.height) {
        return;
    }
    let pixel = vec2f(id.xy) + 0.5;
    let view = shPixelRay(pixel);
    var color = vec3f(0.0);
    var sky = view.z >= p.horizonZ && dot(view, p.occluder.xyz) < p.occluder.w;
    var transmittance = vec3f(1.0);
    var direction = view;
    if ((p.flags & SH_FLAG_AIR) != 0u) {
        let apparent = shAltitude(view);
        sky = sky && apparent >= p.airHorizon;
        transmittance = shTransmittance(apparent);
        direction = shUnbend(view);
    }
    if (sky) {
        if ((p.flags & SH_FLAG_STARS) != 0u) {
            color = color + shStarsAt(pixel, (id.y / p.tileSize) * p.tilesX + id.x / p.tileSize);
            if (p.halo > 0.0) {
                color = color + shHaloAt(pixel);
            }
        }
        if ((p.flags & SH_FLAG_MILKY_WAY) != 0u) {
            color = color + shMilkyWayAt(direction) * transmittance;
        }
        if (p.lineOpacity > 0.0) {
            // A hint on the display, not light in the sky: the same however the image is exposed.
            let cover = shLinesAt(pixel, (id.y / p.tileSize) * p.tilesX + id.x / p.tileSize);
            color = color + p.lineColor * (p.lineOpacity * cover / p.displayExposure);
        }
    }
    var alpha = 0.0;
    if (SH_BACKGROUND) {
        color = color + textureLoad(shBackground, vec2i(id.xy), 0).rgb;
        alpha = 1.0;
        if (SH_DARK_ADAPTED) {
            color = hdDarkAdaptedEye(color);
        }
    }
    color = color * p.exposure;
    if (SH_TONE_MAP != 0u) {
        color = shToneMap(color);
        if (SH_DITHER) {
            color = clamp(hdDither(color, id.xy, 255.0), vec3f(0.0), hdEncodeSrgbExtended(vec3f(SH_HEADROOM), SH_HEADROOM));
        }
    }
    shOutputStore(id.xy, vec4f(color, alpha));
}
