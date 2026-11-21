// Every star of the catalog onto the target: where it shows, lifted by the air, how bright, dimmed by it and
// twinkling, how wide its image is, and into which tiles of the target it reaches, so the compose pass sums only the
// stars near each pixel; and the light beyond a star's knee into the halos' grid. Three steps: `shBin` draws each
// star's image and counts the stars per tile, `shTilePrepare` empties the tiles more reach than one holds, and
// `shTilePlace` puts each star into its tiles, a full one keeping its brightest. The deep stars, by the million, go
// into no tile: `shDeepSplat` adds each one's light to the pixels around it. Requires `params.wgsl`, `camera.wgsl`,
// `air.wgsl` and `seeing.wgsl` (dunstkreis'), `glare.wgsl` (helldunkel's) and `stars.wgsl`.

@group(0) @binding(0) var<uniform> shParams: ShParams;
@group(0) @binding(1) var<storage, read> shCatalog: array<u32>;
@group(0) @binding(2) var<storage, read_write> shSplats: array<ShSplat>;
// Per tile how many stars reach it, and the stars: their indices where they all fit, else the brightest, brightest
// first, each a key, the star's brightness in the high bits and its index counted down in the low `indexBits`, 0 for
// an empty slot. And per tile how many have been placed.
@group(0) @binding(3) var<storage, read_write> shTileCounts: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> shTileEntries: array<atomic<u32>>;
@group(0) @binding(12) var<storage, read_write> shTilePlaced: array<atomic<u32>>;
// The halos' finest level, three floats a texel as bits, summed atomically: `halo.comp.wgsl` spreads it.
@group(0) @binding(5) var<storage, read_write> shHaloSums: array<atomic<u32>>;
// The faint stars, packed, and the colors of their color indices.
@group(0) @binding(6) var<storage, read> shFaint: array<u32>;
@group(0) @binding(7) var<storage, read> shFaintColors: array<vec4f>;
// The deep stars, in blocks of 64, full or compact as the faint ones; the blocks to draw, those of the cells in view; and the
// target's pixels, three channels each, summed atomically in steps of `SH_DEEP_STEP`: the compose pass reads them.
@group(0) @binding(8) var<uniform> shDeep: ShDeep;
@group(0) @binding(9) var<storage, read> shDeepStars: array<u32>;
@group(0) @binding(10) var<storage, read> shDeepBlocks: array<u32>;
@group(0) @binding(11) var<storage, read_write> shDeepSums: array<atomic<u32>>;
// The air table, dunstkreis' `airTable`, read where the flags say so.
@group(0) @binding(15) var shAir: texture_2d<f32>;

// Adds to a float kept as bits: exchanged until no other star got in between.
fn shHaloAdd(at: u32, value: f32) {
    var old = atomicLoad(&shHaloSums[at]);
    loop {
        let result = atomicCompareExchangeWeak(&shHaloSums[at], old, bitcast<u32>(bitcast<f32>(old) + value));
        if (result.exchanged) {
            break;
        }
        old = result.old_value;
    }
}

// A star's excess light into the four texels of the finest level around it, by their shares, so its halo moves
// smoothly.
fn shHaloSplat(pixel: vec2f, light: vec3f) {
    let size = shHaloSize();
    let at = (pixel + f32(SH_HALO_MARGIN)) / f32(SH_HALO_SCALE) - 0.5;
    let base = floor(at);
    let share = at - base;
    for (var k = 0u; k < 4u; k = k + 1u) {
        let offset = vec2f(f32(k & 1u), f32(k >> 1u));
        let texel = vec2i(base + offset);
        if (any(texel < vec2i(0)) || any(texel >= vec2i(size))) {
            continue;
        }
        let weight = mix(1.0 - share.x, share.x, offset.x) * mix(1.0 - share.y, share.y, offset.y);
        let index = (u32(texel.y) * size.x + u32(texel.x)) * 3u;
        for (var c = 0u; c < 3u; c = c + 1u) {
            shHaloAdd(index + c, light[c] * weight);
        }
    }
}

// A star's image on the target: where it shows, lifted by the air, its light dimmed by it and twinkling, how wide its
// core is and how far it is drawn. The light beyond the knee goes into the halos' grid here. `seed` tells the stars
// apart for the twinkling.
struct ShImage {
    shown: bool,
    pixel: vec2f,
    sigma: f32,
    // The radius in pixels at which the exposed image falls to the threshold, 0 where it never reaches it, and by how
    // many times its peak passes the threshold.
    radius: f32,
    ratio: f32,
    // The core's light in lux per channel, the luminance at its center per lux, and the share the knee leaves it; the
    // star's whole light in its brightest channel, before the knee, and as a luminance, and what its halo shows of it.
    light: vec3f,
    peak: f32,
    pixelsPerRadian: f32,
    core: f32,
    brightest: f32,
    whole: f32,
    halo: f32,
}

fn shStarImage(seed: u32, magnitude: f32, trueDirection: vec3f, color: vec3f) -> ShImage {
    var image: ShImage;
    image.shown = false;
    var direction = trueDirection;
    // What reaches the eye of the light above the air: a point's is squeezed thinner where the air flattens the sky.
    var through = vec3f(1.0);
    if ((shParams.flags & SH_FLAG_AIR) != 0u) {
        direction = dkAirLifted(shAir, trueDirection);
        let air = dkAirTowards(shAir, direction);
        if (!air.shows) {
            return image;
        }
        through = air.transmittance * air.dilution;
        if ((shParams.flags & SH_FLAG_TWINKLE) != 0u) {
            through = through * dkScintillation(shParams.seeing, air, seed, shParams.time);
        }
    }
    if (direction.z < shParams.horizonZ) {
        return image;
    }
    let projected = shProject(direction);
    if (projected.z <= 0.0) {
        return image;
    }
    let pixel = projected.xy;
    // Nothing of a star this far outside the target reaches it, nor its halo, which the grid's margin bounds.
    let reach = max(shParams.maxRadius, f32(SH_HALO_MARGIN + 2u * SH_HALO_SCALE));
    if (any(pixel < vec2f(-reach)) || any(pixel > vec2f(f32(shParams.width), f32(shParams.height)) + reach)) {
        return image;
    }
    let light = shIlluminance(magnitude) * shParams.starLight * color * through;
    let pixelsPerRadian = shPixelsPerRadian(direction, pixel);
    // The core's width in pixels: the point spread's, at least a little over half a pixel, so no star falls between
    // pixels. On the sky it narrows as the view zooms in, and the star brightens, as it does in a telescope.
    let sigma = max(shParams.psfPixels, 0.6);
    let sigmaRadians = sigma / pixelsPerRadian;
    let peak = 1.0 / (2.0 * SH_PI * sigmaRadians * sigmaRadians);
    let brightest = max(max(light.r, light.g), light.b);
    // The core stays a point: its exposed peak stops at the knee, and whitens as far as it would pass it, as the eye's
    // or a sensor's channels saturate. The light beyond it, which keeps the star's color, goes into the halos' grid, a
    // point of light there that `halo.comp.wgsl` spreads into the halo's profile, its share `halo` of it.
    let exposedPeak = brightest * peak * shParams.displayExposure;
    let core = min(1.0, shParams.knee / max(exposedPeak, 1e-30));
    let coreLight = mix(vec3f(brightest), light, core);
    var halo = 0.0;
    if (core < 1.0 && shParams.halo > 0.0) {
        let excess = max(light - coreLight * core, vec3f(0.0)) * shParams.halo;
        halo = dot(excess, SH_LUMINANCE);
        // Exposed, over the pixels: the Gaussian's peak times its area, in units of display white times pixels.
        let exposed = excess * (peak * shParams.displayExposure * 2.0 * SH_PI * sigma * sigma);
        shHaloSplat(pixel, exposed / f32(SH_HALO_SCALE * SH_HALO_SCALE));
    }
    // Cut where the exposed image falls below the threshold: the core's Gaussian radius there.
    let ratio = exposedPeak * core / shParams.threshold;
    var radius = 0.0;
    if (ratio > 1.0) {
        radius = sigma * sqrt(2.0 * log(ratio));
    }
    image.shown = true;
    image.pixel = pixel;
    image.sigma = sigma;
    image.radius = radius;
    image.ratio = ratio;
    image.light = coreLight;
    image.peak = peak;
    image.pixelsPerRadian = pixelsPerRadian;
    image.core = core;
    image.brightest = brightest;
    image.whole = dot(light, SH_LUMINANCE);
    image.halo = halo;
    return image;
}

// A star's key in a tile: brighter stars larger, the high bits a float's exponent and the top of its mantissa, and of
// two alike the earlier in the catalog, by the index counted down in the low bits. Never 0, the empty slot's.
fn shTileKey(i: u32, light: f32) -> u32 {
    let mask = (1u << shParams.indexBits) - 1u;
    let brightness = bitcast<u32>(max(light, 1e-37)) >> (shParams.indexBits - 1u);
    return max((brightness << shParams.indexBits) | (mask - i), 1u);
}

// Keeps a full tile's brightest stars, brightest first, whichever order the invocations come in. The slots are sorted
// at every moment, as each one only grows: a star skips the brighter ones by halving, among no more than the stars
// placed before it, then takes its place, and each slot it passes keeps the brighter of the two and hands the other
// on, until one lands in an empty slot or falls off the end. So the tile holds the same stars every time.
fn shTileInsert(tile: u32, key: u32) {
    let base = tile * shParams.capacity;
    var low = 0u;
    var high = min(atomicAdd(&shTilePlaced[tile], 1u), shParams.capacity);
    while (low < high) {
        let middle = (low + high) / 2u;
        if (atomicLoad(&shTileEntries[base + middle]) > key) {
            low = middle + 1u;
        } else {
            high = middle;
        }
    }
    var carried = key;
    for (var slot = low; slot < shParams.capacity; slot = slot + 1u) {
        let old = atomicMax(&shTileEntries[base + slot], carried);
        if (old == 0u) {
            break;
        }
        carried = min(old, carried);
    }
}

// The tiles a star's image reaches: the first and the last column and row.
fn shTilesOf(pixel: vec2f, radius: f32) -> vec4u {
    let tile = f32(shParams.tileSize);
    let tilesY = (shParams.height + shParams.tileSize - 1u) / shParams.tileSize;
    let x0 = u32(clamp(floor((pixel.x - radius) / tile), 0.0, f32(shParams.tilesX - 1u)));
    let x1 = u32(clamp(floor((pixel.x + radius) / tile), 0.0, f32(shParams.tilesX - 1u)));
    let y0 = u32(clamp(floor((pixel.y - radius) / tile), 0.0, f32(tilesY - 1u)));
    let y1 = u32(clamp(floor((pixel.y + radius) / tile), 0.0, f32(tilesY - 1u)));
    return vec4u(x0, x1, y0, y1);
}

fn shStarCount() -> u32 {
    return shCatalogCount() + shParams.faintCount;
}

@compute @workgroup_size(64, 1, 1)
fn shBin(@builtin(global_invocation_id) id: vec3u) {
    let i = id.x;
    if (i >= shStarCount()) {
        return;
    }
    // Not drawn, until it is.
    shSplats[i].radius = 0.0;
    let magnitude = shStarMagnitude(i);
    if (magnitude > shParams.magnitudeLimit || (shStarIsFaint(i) && magnitude > shParams.faintLimit)) {
        return;
    }
    let image = shStarImage(i, magnitude, shStarDirection(i), shStarColor(i));
    if (!image.shown) {
        return;
    }
    let pixel = image.pixel;
    var radius = image.radius;
    if (shParams.glare > 0.0) {
        // The veil's 10 / θ² in degrees of the viewer's field: where it falls to the threshold.
        let brightest = max(max(image.light.r, image.light.g), image.light.b);
        let degrees = sqrt(10.0 * shParams.glare * brightest * shParams.displayExposure / shParams.threshold);
        radius = max(radius, degrees / shParams.screenDegreesPerPixel);
    }
    if (radius <= 0.0) {
        return;
    }
    radius = min(radius, shParams.maxRadius);
    if (pixel.x + radius < 0.0 || pixel.y + radius < 0.0 || pixel.x - radius > f32(shParams.width) || pixel.y - radius > f32(shParams.height)) {
        return;
    }
    shSplats[i] = ShSplat(pixel, image.sigma, radius, image.light, image.peak, image.whole, image.core, image.brightest, image.halo);
    let tiles = shTilesOf(pixel, radius);
    for (var y = tiles.z; y <= tiles.w; y = y + 1u) {
        for (var x = tiles.x; x <= tiles.y; x = x + 1u) {
            atomicAdd(&shTileCounts[y * shParams.tilesX + x], 1u);
        }
    }
}

// Empties the tiles more stars reach than one holds: their stars are sorted in, which needs empty slots to end on.
@compute @workgroup_size(64, 1, 1)
fn shTilePrepare(@builtin(global_invocation_id) id: vec3u) {
    let tilesY = (shParams.height + shParams.tileSize - 1u) / shParams.tileSize;
    if (id.x >= shParams.tilesX * tilesY || atomicLoad(&shTileCounts[id.x]) <= shParams.capacity) {
        return;
    }
    for (var slot = 0u; slot < shParams.capacity; slot = slot + 1u) {
        atomicStore(&shTileEntries[id.x * shParams.capacity + slot], 0u);
    }
}

// Every drawn star into the tiles it reaches: where they all fit, in any order, else sorted in by brightness.
@compute @workgroup_size(64, 1, 1)
fn shTilePlace(@builtin(global_invocation_id) id: vec3u) {
    let i = id.x;
    if (i >= shStarCount() || shSplats[i].radius <= 0.0) {
        return;
    }
    let tiles = shTilesOf(shSplats[i].pixel, shSplats[i].radius);
    let key = shTileKey(i, shSplats[i].brightest);
    for (var y = tiles.z; y <= tiles.w; y = y + 1u) {
        for (var x = tiles.x; x <= tiles.y; x = x + 1u) {
            let tile = y * shParams.tilesX + x;
            if (atomicLoad(&shTileCounts[tile]) <= shParams.capacity) {
                atomicStore(&shTileEntries[tile * shParams.capacity + atomicAdd(&shTilePlaced[tile], 1u)], i);
            } else {
                shTileInsert(tile, key);
            }
        }
    }
}

// A deep star's light into a pixel, exposed, in whole steps: what is left over is rounded up as often as it is a
// share of a step, by a number the star and the pixel keep, so the pixels' sum loses no light and does not flicker.
fn shDeepAdd(texel: vec2i, exposed: vec3f, seed: u32) {
    if (any(texel < vec2i(0)) || texel.x >= i32(shParams.width) || texel.y >= i32(shParams.height)) {
        return;
    }
    let at = (u32(texel.y) * shParams.width + u32(texel.x)) * 3u;
    let steps = vec3u(min(exposed / SH_DEEP_STEP, vec3f(1e9)) + dkHashUniform(seed));
    for (var c = 0u; c < 3u; c = c + 1u) {
        if (steps[c] > 0u) {
            atomicAdd(&shDeepSums[at + c], steps[c]);
        }
    }
}

// The deep stars: a block of 64 per group, each star's light spread over the pixels around it and added to them, all
// of it, whether or not the star alone would show: a million stars under the threshold are the glow of the Milky Way.
// A star's weights add up to 1 over the pixels it reaches: a Gaussian as wide as the catalog's stars', out to where it
// falls to an eighth of the threshold, three pixels at most; and the four pixels around a star that never reaches a
// third of the threshold, by their shares, so it does not pop as it crosses it.
@compute @workgroup_size(64, 1, 1)
fn shDeepSplat(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) local: u32) {
    let block = shDeepBlocks[group.x];
    let i = block * 64u + local;
    var star: ShPacked;
    if (SH_COMPACT_DEEP) {
        let base = block * SH_BLOCK_WORDS;
        star = shCompactStar(shDeepStars[base], shDeepStars[base + 1u + local], shBlockCodes(shDeepStars[base + 65u + local / 2u], local));
    } else {
        star = shFullStar(shDeepStars[i * 2u], shDeepStars[i * 2u + 1u]);
    }
    if (star.magnitude > min(min(shParams.magnitudeLimit, shDeep.magnitudeLimit), 99.0)) {
        return;
    }
    let magnitude = star.magnitude;
    let direction = normalize(shParams.skyRotation * star.direction);
    // Outside the cone around the view, with room for the air's lift: before the air is asked.
    if (dot(direction, shDeep.axis) < shDeep.cosCone) {
        return;
    }
    let seed = i + 0x40000000u;
    let image = shStarImage(seed, magnitude, direction, max(shFaintColors[star.color].rgb, vec3f(0.0)));
    if (!image.shown || any(image.pixel < vec2f(-4.0)) || any(image.pixel > vec2f(f32(shParams.width), f32(shParams.height)) + 4.0)) {
        return;
    }
    // A pixel's exposed luminance per lux and share of the star's light: a pixel's solid angle is 1 / pixelsPerRadian².
    let exposed = image.light * (image.core * image.pixelsPerRadian * image.pixelsPerRadian * shParams.displayExposure);
    let hash = dkHash(seed);
    if (image.ratio < 1.0 / 3.0) {
        let at = image.pixel - 0.5;
        let base = floor(at);
        let share = at - base;
        for (var k = 0u; k < 4u; k = k + 1u) {
            let offset = vec2f(f32(k & 1u), f32(k >> 1u));
            let weight = mix(1.0 - share.x, share.x, offset.x) * mix(1.0 - share.y, share.y, offset.y);
            shDeepAdd(vec2i(base + offset), exposed * weight, hash + k);
        }
        return;
    }
    // Out to where the image falls to an eighth of the threshold; what lies beyond goes to the pixels within.
    let cut = min(image.sigma * sqrt(2.0 * log(8.0 * image.ratio)), f32(SH_DEEP_REACH));
    let reach = i32(ceil(cut));
    let center = vec2i(floor(image.pixel));
    let offset = vec2f(center) + 0.5 - image.pixel;
    let narrow = -0.5 / (image.sigma * image.sigma);
    var sum = 0.0;
    for (var y = -reach; y <= reach; y = y + 1) {
        for (var x = -reach; x <= reach; x = x + 1) {
            let d = offset + vec2f(f32(x), f32(y));
            sum = sum + select(0.0, exp(narrow * dot(d, d)), dot(d, d) <= cut * cut);
        }
    }
    for (var y = -reach; y <= reach; y = y + 1) {
        for (var x = -reach; x <= reach; x = x + 1) {
            let d = offset + vec2f(f32(x), f32(y));
            if (dot(d, d) <= cut * cut) {
                shDeepAdd(center + vec2i(x, y), exposed * (exp(narrow * dot(d, d)) / sum), hash + u32((y + reach) * 8 + x + reach));
            }
        }
    }
}
