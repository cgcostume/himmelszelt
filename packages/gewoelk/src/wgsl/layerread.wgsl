// The layered model's maps as whoever marches or shades by them reads them: what a layer is, where its columns stand
// over the ground, and how much cloud a column holds over a point. The layers' march reads them so, and the voxel
// march, for the shade a deep layer casts on its cloudscape. Binding-free: requires `params.wgsl` with `gwParams`, and
// from the pass `gwLayered`, a uniform of `GwLayered`, `gwLayerMaps`, the maps as an array of the low, the deep and the
// middle layer's, and `gwLayerSampler`, which repeats and filters.

// A layer: a slab `depth` km deep from `base` km up, its clouds `size` km across on a map of one `tile` km. A front is
// placed, not tiled: `frontAt` km from the observer to its leading edge along `heading`, `frontDepth` km from there
// to its back.
struct GwCloudLayer {
    enabled: u32,
    // 0 heaps or a deck, 2 towers, 3 a front.
    kind: u32,
    base: f32,
    depth: f32,
    tile: f32,
    size: f32,
    // Extinction per km at full density.
    extinction: f32,
    // How far the detail noise's billows heap the surface out, and how far the flanks bulge, each 0 to 1.
    detail: f32,
    bulge: f32,
    frontAt: f32,
    frontDepth: f32,
    pad: f32,
    // Where the layer's clouds have drifted to with their wind, in km, and a front's heading, east and north.
    drift: vec2f,
    heading: vec2f,
}

// The march's settings and what the layers share. Lengths in km.
struct GwLayered {
    // One tile of the detail noise, and how far the march goes through the layers.
    noiseScale: f32,
    reach: f32,
    // The first step's length, and how steps grow with the distance, per km.
    stepMin: f32,
    stepGrowth: f32,
    // Each further order of scattering's share of the one before, and what the sky's and the ground's light on the
    // clouds is multiplied by.
    multiScatter: f32,
    ambient: f32,
    // The distance at which a cloud has faded to 1/e into the horizon's light: the air in between.
    fade: f32,
    // The distance at which the last cloud is gone, 0 for clouds all the way, and from where they thin out.
    clearing: f32,
    clearingFrom: f32,
    // The rain's extinction per km where it falls hardest, under the deep layer: 0 for none.
    rain: f32,
    // How far the clouds lean with the wind per km they rise, east and north.
    shear: vec2f,
    // Where the observer stands over the ground the layers were laid out on, east and north.
    observer: vec2f,
    // How far the rain lags behind its cloud by the time it has fallen 1 km, east and north: it falls into slower air.
    rainLean: vec2f,
    // Whether the march's jitter is helldunkel's blue noise, not interleaved gradient noise.
    blueNoise: u32,
    // Where the clearing is centered, east and north of the observer: around the observer at 0.
    clearingCenter: vec2f,
    layer: array<GwCloudLayer, 3>,
}

// The deep layer, whose front the low layer answers to.
const GW_LAYER_DEEP: u32 = 1u;
// Where an anvil's top lies, as a share of its layer's depth, and how thick it is at its tower.
const GW_LAYER_ANVIL_TOP: f32 = 0.9;
const GW_LAYER_ANVIL_THICK: f32 = 0.22;
// An anvil's ice against a tower's water, in extinction.
const GW_LAYER_ANVIL_DENSITY: f32 = 0.2;

// Where a point stands over the ground, east and north in km along the planet's surface from below the observer.
fn gwLayerGround(p: vec3f) -> vec2f {
    let across = length(p.xy);
    return p.xy / max(across, 1e-6) * (gwParams.planetRadius * atan2(across, p.z));
}

// A layer's map over the ground point `g`, km east and north: r the column's value, g the anvils' skirt, b a front's
// shade, a the tops' slope per km. A front is placed, not tiled: nothing ahead of its edge or behind its back.
fn gwLayerColumn(i: u32, g: vec2f) -> vec4f {
    let l = gwLayered.layer[i];
    var uv = fract((g - l.drift) / l.tile);
    if (l.kind == 3u) {
        let x = (dot(g, l.heading) - l.frontAt) / l.frontDepth;
        if (x <= 0.0 || x >= 1.0) {
            return vec4f(0.0);
        }
        uv = vec2f(x, fract(dot(g, vec2f(l.heading.y, -l.heading.x)) / l.tile));
    }
    return textureSampleLevel(gwLayerMaps, gwLayerSampler, uv, i32(i), 0.0);
}

// Where a column of value `m` has its bottom and its top, as shares of a layer `depth` km deep: the bottoms nearly
// flat and at one height whatever the depth, as rising air condenses at one level, the tops as tall as the value.
fn gwLayerSpan(depth: f32, m: f32) -> vec2f {
    let dip = min(0.15 / depth, 0.3);
    return vec2f(dip * (1.0 - m), dip + m * (1.0 - dip));
}

// How much of the clouds' coverage the clearing takes over a point `near` km east and north of the observer: none
// close to its center, all of it from the clearing's distance on, where one is set.
fn gwLayerCleared(near: vec2f) -> f32 {
    let clearing = gwLayered.clearing;
    if (clearing <= 0.0) {
        return 0.0;
    }
    return smoothstep(min(gwLayered.clearingFrom, 0.99 * clearing), clearing, length(near - gwLayered.clearingCenter));
}

// The optical depth of the layer `i` straight up over `p`, by its column alone: its map read where the way `towards`
// the sun crosses the layer's base, `slant` km for each km up.
fn gwLayerOver(i: u32, p: vec3f, towards: vec3f, slant: f32) -> f32 {
    let l = gwLayered.layer[i];
    let altitude = length(p) - gwParams.planetRadius;
    if (l.enabled == 0u || altitude >= l.base + l.depth) {
        return 0.0;
    }
    let near = gwLayerGround(p + towards * max(l.base - altitude, 0.0) * slant);
    let m = gwLayerColumn(i, near + gwLayered.observer);
    let thinned = gwLayerCleared(near);
    let value = clamp((m.r - thinned) / max(1.0 - thinned, 1e-3), 0.0, 1.0);
    let span = gwLayerSpan(l.depth, value);
    let column = min(l.base + span.y * l.depth - altitude, (span.y - span.x) * l.depth) * step(1e-3, value);
    return l.extinction * (max(column, 0.0) + GW_LAYER_ANVIL_DENSITY * GW_LAYER_ANVIL_THICK * m.g * l.depth * (1.0 - thinned));
}
