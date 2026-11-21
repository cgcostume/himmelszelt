// The stars and the Milky Way along every pixel's ray, over a background in cd/m² where there is one, then exposed and
// tone mapped like dunstkreis' sky, or left linear. Requires `params.wgsl`, `camera.wgsl`, `air.wgsl` and
// `seeing.wgsl` (dunstkreis'), `glare.wgsl`, `whitebalance.wgsl`, `tonemap.wgsl` and `vision.wgsl` (helldunkel's) and
// `stars.wgsl`, and an
// output binding, `starsOutput(format)`.

@group(0) @binding(0) var<uniform> shParams: ShParams;
@group(0) @binding(1) var<storage, read> shCatalog: array<u32>;
@group(0) @binding(2) var<storage, read> shSplats: array<ShSplat>;
// Per tile how many stars reach it, and the stars: their indices where they all fit, else the brightest, keyed.
@group(0) @binding(3) var<storage, read> shTileCounts: array<u32>;
@group(0) @binding(4) var<storage, read> shTileEntries: array<u32>;
@group(0) @binding(5) var shMilkyWay: texture_2d<f32>;
@group(0) @binding(6) var shMilkyWaySampler: sampler;
@group(0) @binding(7) var shBackground: texture_2d<f32>;
// The halos, the finest level of their grid added up, `halo.comp.wgsl`.
@group(0) @binding(8) var shHalos: texture_2d<f32>;
// The constellations' lines in pieces, binned into tiles, `lines.comp.wgsl`.
@group(0) @binding(9) var<storage, read> shPieces: array<ShPiece>;
@group(0) @binding(10) var<storage, read> shLineCounts: array<u32>;
@group(0) @binding(11) var<storage, read> shLineEntries: array<u32>;
// Named by `stars.wgsl`, read by the other passes only.
@group(0) @binding(12) var<storage, read> shFaint: array<u32>;
@group(0) @binding(13) var<storage, read> shFaintColors: array<vec4f>;
// The deep stars' light per pixel, exposed, three channels in steps of `SH_DEEP_STEP`: `shDeepSplat` sums them, and
// reading them here empties them for the next frame.
@group(0) @binding(14) var<storage, read_write> shDeepSums: array<u32>;
// The air table, dunstkreis' `airTable`, read where the flags say so.
@group(0) @binding(15) var shAir: texture_2d<f32>;
// helldunkel's blue noise, read with SH_DITHER.
@group(0) @binding(16) var shBlueNoise: texture_2d<f32>;

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
    let mask = (1u << shParams.indexBits) - 1u;
    let count = shTileCounts[tile];
    var sum = vec3f(0.0);
    for (var k = 0u; k < min(count, shParams.capacity); k = k + 1u) {
        let entry = shTileEntries[tile * shParams.capacity + k];
        let splat = shSplats[select(entry, mask - (entry & mask), count > shParams.capacity)];
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

// The deep stars' light at a pixel, in cd/m², taken out of the sums: the pass that fills them need not clear them.
fn shDeepTake(pixel: vec2u) -> vec3f {
    let at = (pixel.y * shParams.width + pixel.x) * 3u;
    let steps = vec3u(shDeepSums[at], shDeepSums[at + 1u], shDeepSums[at + 2u]);
    if (all(steps == vec3u(0u))) {
        return vec3f(0.0);
    }
    shDeepSums[at] = 0u;
    shDeepSums[at + 1u] = 0u;
    shDeepSums[at + 2u] = 0u;
    return vec3f(steps) * (SH_DEEP_STEP / shParams.displayExposure);
}

// The halos at a pixel, in cd/m²: every star's light beyond its knee spread into its halo, shown rising only
// logarithmically towards the halo's knee, its hue kept, so a brighter star's halo grows wider rather than whiter.
fn shHaloAt(pixel: vec2f) -> vec3f {
    let uv = (pixel + f32(SH_HALO_MARGIN)) / vec2f(shHaloSize() * SH_HALO_SCALE);
    let light = textureSampleLevel(shHalos, shMilkyWaySampler, uv, 0.0).rgb;
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
// increasing to the left, as NASA's Deep Star Maps lay it out, times what a texel stands for. Read from the mipmap
// level whose texels span what the pixel does along the meridians, where plate carrée keeps its scale.
fn shMilkyWayAt(direction: vec3f, pixel: vec2f) -> vec3f {
    let equatorial = transpose(shParams.skyRotation) * direction;
    let rightAscension = atan2(equatorial.y, equatorial.x);
    let declination = asin(clamp(equatorial.z, -1.0, 1.0));
    let uv = vec2f(fract(0.5 - rightAscension / (2.0 * SH_PI)), (0.5 * SH_PI - declination) / SH_PI);
    let across = distance(shPixelRay(pixel), shPixelRay(pixel + vec2f(1.0, 0.0)));
    let level = log2(max(across * f32(textureDimensions(shMilkyWay).y) / SH_PI, 1e-6));
    var light = textureSampleLevel(shMilkyWay, shMilkyWaySampler, uv, level).rgb;
    if (shParams.milkyWayStops > 0.0) {
        // Each channel's logarithm, read between the texels in stops; the darkest step is black.
        light = select(exp2((light - 1.0) * shParams.milkyWayStops), vec3f(0.0), light <= vec3f(0.0));
    }
    return light * (shParams.milkyWayLuminance * shParams.milkyWay);
}

@compute @workgroup_size(8, 8, 1)
fn shCompose(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= shParams.width || id.y >= shParams.height) {
        return;
    }
    let pixel = vec2f(id.xy) + 0.5;
    let view = shPixelRay(pixel);
    var color = vec3f(0.0);
    var sky = view.z >= shParams.horizonZ && dot(view, shParams.occluder.xyz) < shParams.occluder.w;
    var transmittance = vec3f(1.0);
    var direction = view;
    // A surface keeps its luminance where the air squeezes the sky: the Milky Way is dimmed by the transmittance alone.
    if ((shParams.flags & SH_FLAG_AIR) != 0u) {
        let air = dkAirTowards(shAir, view);
        sky = sky && air.shows;
        transmittance = air.transmittance;
        direction = dkAirTurnedUp(view, -air.bend);
    }
    // Also where the ground or the Moon hides the sky, so no star's light is left in the sums.
    var deep = vec3f(0.0);
    if ((shParams.flags & SH_FLAG_DEEP) != 0u) {
        deep = shDeepTake(id.xy);
    }
    if (sky) {
        if ((shParams.flags & SH_FLAG_STARS) != 0u) {
            color = color + shStarsAt(pixel, (id.y / shParams.tileSize) * shParams.tilesX + id.x / shParams.tileSize) + deep;
            if (shParams.halo > 0.0) {
                color = color + shHaloAt(pixel);
            }
        }
        if ((shParams.flags & SH_FLAG_MILKY_WAY) != 0u) {
            color = color + shMilkyWayAt(direction, pixel) * transmittance;
        }
        if (shParams.lineOpacity > 0.0) {
            // A hint on the display, not light in the sky: the same however the image is exposed.
            let cover = shLinesAt(pixel, (id.y / shParams.tileSize) * shParams.tilesX + id.x / shParams.tileSize);
            color = color + shParams.lineColor * (shParams.lineOpacity * cover / shParams.displayExposure);
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
    color = hdWhiteBalance(color, shParams.whiteBalance) * shParams.exposure;
    if (SH_TONE_MAP != 0u) {
        color = shToneMap(color);
        if (SH_DITHER) {
            color = clamp(hdDitherBlue(color, id.xy, 255.0, shBlueNoise), vec3f(0.0), hdEncodeSrgbExtended(vec3f(SH_HEADROOM), SH_HEADROOM));
        }
    }
    shOutputStore(id.xy, vec4f(color, alpha));
}
