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

// The tone curve, as dunstkreis' sky pass numbers them: 0 none, the exposed luminance linear, 1 neutral, 2 AgX,
// 3 ACES, 4 clip; the display's headroom; dithering for an 8-bit target.
override SH_TONE_MAP: u32 = 1u;
override SH_HEADROOM: f32 = 1.0;
override SH_DITHER: bool = true;
// Whether a background is bound; without one the stars' light alone is written, to add.
override SH_BACKGROUND: bool = true;
// The composed light as the eye sees it at night, with a background: the rods' blue shift, `hdNightVision`.
override SH_NIGHT_VISION: bool = false;

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

// The light of the stars binned into the pixel's tile that reaches the pixel: each star's Gaussian image, in cd/m²,
// its light over its spread, and the eye's veil around it, CIE's glare equation of a point source.
fn shStarsAt(pixel: vec2f, tile: u32) -> vec3f {
    let p = shParams;
    let count = min(shTileCounts[tile], p.capacity);
    var sum = vec3f(0.0);
    for (var k = 0u; k < count; k = k + 1u) {
        let splat = shSplats[shTileEntries[tile * p.capacity + k]];
        let d = pixel - splat.pixel;
        let r2 = dot(d, d);
        if (r2 > splat.radius * splat.radius) {
            continue;
        }
        var factor = splat.peak * exp(-0.5 * r2 / (splat.sigma * splat.sigma));
        if (p.glare > 0.0) {
            let degrees = sqrt(r2) * p.screenDegreesPerPixel;
            factor = factor + p.glare * hdVeilingGlare(degrees, 30.0, 1.0);
        }
        sum = sum + splat.light * factor;
    }
    return sum;
}

// The Milky Way's light along a true direction: the map, in J2000 equatorial coordinates with right ascension
// increasing to the left, as NASA's Deep Star Maps lay it out, times what a texel stands for.
fn shMilkyWayAt(direction: vec3f) -> vec3f {
    let equatorial = transpose(shParams.skyRotation) * direction;
    let rightAscension = atan2(equatorial.y, equatorial.x);
    let declination = asin(clamp(equatorial.z, -1.0, 1.0));
    let uv = vec2f(fract(0.5 - rightAscension / (2.0 * SH_PI)), (0.5 * SH_PI - declination) / SH_PI);
    return textureSampleLevel(shMilkyWay, shMilkyWaySampler, uv, 0.0).rgb * (shParams.milkyWayLuminance * shParams.milkyWay);
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
    var sky = view.z >= p.horizonZ;
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
        }
        if ((p.flags & SH_FLAG_MILKY_WAY) != 0u) {
            color = color + shMilkyWayAt(direction) * transmittance;
        }
    }
    var alpha = 0.0;
    if (SH_BACKGROUND) {
        color = color + textureLoad(shBackground, vec2i(id.xy), 0).rgb;
        alpha = 1.0;
        if (SH_NIGHT_VISION) {
            color = hdNightVision(color);
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
