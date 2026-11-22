// The layered model's clouds along every pixel's ray: three layers, low heaps or a deck, deep towers or a front, and a
// middle layer, each read from a map `layermap.comp.wgsl` bakes and marched together as one density with nothing else
// built first, the way Horizon Zero Dawn and Red Dead Redemption 2 do it. Every change is free, at the price of a
// march that samples towards the sun. Written as the voxel march writes its cloudscape: light in cd/m², premultiplied,
// with what the layers let through of what lies behind, their shadow on the ground in it where a ray ends there.
// Under the deep layer's tall columns rain falls, and where the sun reaches it, it sends back the bows of `rainbow.wgsl`.
// Requires `params.wgsl`, dunstkreis' `camera.wgsl`, `rainbow.wgsl`, `godrays.comp.wgsl` and the output binding.

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
    layer: array<GwCloudLayer, 3>,
}

@group(0) @binding(0) var<uniform> gwParams: GwParams;
@group(0) @binding(1) var<uniform> gwSunlight: GwSunlight;
@group(0) @binding(2) var<uniform> gwLayered: GwLayered;
@group(0) @binding(3) var gwLayerMaps: texture_2d_array<f32>;
// Repeats in every axis: the maps' and the detail noise's.
@group(0) @binding(4) var gwLayerSampler: sampler;
@group(0) @binding(5) var gwLayerDetail: texture_3d<f32>;
// The rain's phase function over the scattering angle, `rainbowTable`'s row.
@group(0) @binding(6) var gwLayerRainbow: texture_2d<f32>;

// Steps a ray takes at most.
override GW_LAYER_MAX_STEPS: u32 = 128u;

const GW_LAYER_COUNT: u32 = 3u;
// The deep layer, whose front the low layer answers to, and how far the low clouds' base sinks in its rain, in km.
const GW_LAYER_DEEP: u32 = 1u;
const GW_LAYER_SCUD_DROP: f32 = 0.45;
// How much of the low clouds' coverage a front's full shade takes.
const GW_LAYER_SHADE_THINS: f32 = 0.8;
// Where an anvil's top lies, as a share of its layer's depth, and how thick it is at its tower.
const GW_LAYER_ANVIL_TOP: f32 = 0.9;
const GW_LAYER_ANVIL_THICK: f32 = 0.22;
// An anvil's ice against a tower's water, in extinction.
const GW_LAYER_ANVIL_DENSITY: f32 = 0.2;
// The shadow of towers on the ground: the samples along the sun's way up through their layer.
const GW_LAYER_SHADOW_STEPS: u32 = 16u;
// How far a billow heaps the surface out, as a share of the detail noise's tile, of which a billow spans a quarter,
// how far the surface gives way between billows, as a share of its soft edge, and what is left of that edge, both at
// full detail.
const GW_LAYER_HEAP: f32 = 0.2;
const GW_LAYER_GIVE: f32 = 0.4;
const GW_LAYER_CRISP: f32 = 0.35;
// The air under the layers: the points along a ray it is asked at whether they lie in the layers' shade, how much of
// the air's light a full shade takes, and what the shaded air still sends, as a share of the horizon's.
const GW_LAYER_AIR_STEPS: u32 = 6u;
const GW_LAYER_AIR_SHADED: f32 = 0.8;
const GW_LAYER_AIR_UNDER: f32 = 0.3;
// The phase function's forward and backward lobes, four parts to one, and how far forwards the droplets scatter for
// what light a cloud lets through to the air and the ground under it.
const GW_LAYER_FORWARD_G: f32 = 0.8;
const GW_LAYER_BACKWARD_G: f32 = -0.15;
const GW_LAYER_FORWARD: f32 = 0.85;
// Rain: the deep layer's column values between which it sets in and falls in full, the points along a ray under the
// deep layer's base it is asked at, as far as GW_LAYER_RAIN_REACH km, and the samples up the deep layer towards the sun.
const GW_LAYER_RAIN_FROM: vec2f = vec2f(0.35, 0.65);
const GW_LAYER_RAIN_STEPS: u32 = 24u;
const GW_LAYER_RAIN_REACH: f32 = 90.0;
const GW_LAYER_RAIN_SUN_STEPS: u32 = 6u;
// A curtain of rain hangs in streaks: how wide the field that thins them is, in km, and what it leaves between them.
const GW_LAYER_RAIN_STREAKS: f32 = 2.4;
const GW_LAYER_RAIN_BETWEEN: f32 = 0.3;
// The points the rain in the sun's way is asked at, and how far that way is followed, in km.
const GW_LAYER_RAIN_WET_STEPS: u32 = 3u;
const GW_LAYER_RAIN_WET_REACH: f32 = 12.0;
// Below this transmittance a ray is done.
const GW_LAYER_MIN_TRANSMITTANCE: f32 = 0.01;
const GW_LAYER_LUMA: vec3f = vec3f(0.2126, 0.7152, 0.0722);

// The ray through a point of the target, in pixels from its top left corner, on dunstkreis' camera.
fn gwLayerRay(position: vec2f, size: vec2u) -> vec3f {
    let uv = position / vec2f(size);
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    return dkProjectRay(gwParams.inverseViewProjection, ndc, clamp(gwParams.projectionDistance, 0.0, 1.0));
}

// Interleaved gradient noise (Jimenez 2014), a different frame of it each frame.
fn gwLayerJitter(pixel: vec2u, frame: u32) -> f32 {
    let p = vec2f(pixel) + 5.588238 * f32(frame % 64u);
    return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

// Where a point stands over the ground, east and north in km along the planet's surface from below the observer.
fn gwLayerGround(p: vec3f) -> vec2f {
    let across = length(p.xy);
    return p.xy / max(across, 1e-6) * (gwParams.planetRadius * atan2(across, p.z));
}

// The sun's illuminance from `row` of the sunlight table at `elevation`.
fn gwLayerSunAt(row: u32, elevation: f32) -> vec3f {
    let span = gwSunlight.span[row].xy;
    let f = clamp((elevation - span.x) / max(span.y - span.x, 1e-6), 0.0, 1.0) * f32(GW_SUNLIGHT_ENTRIES - 1u);
    let i = min(u32(f), GW_SUNLIGHT_ENTRIES - 2u);
    let at = row * GW_SUNLIGHT_ENTRIES + i;
    return mix(gwSunlight.illuminance[at].rgb, gwSunlight.illuminance[at + 1u].rgb, f - f32(i));
}

// The sun's illuminance at `altitude` km where it stands `elevation` radians above the local horizon: between the
// table's rows, which stand at the cloudscape's base and top and at each sheet's altitude, the nearest beyond them.
fn gwLayerSunlight(altitude: f32, elevation: f32) -> vec3f {
    let base = gwParams.cloudscape.base;
    let top = base + gwParams.cloudscape.height;
    if (altitude <= top) {
        let h = clamp((altitude - base) / max(top - base, 1e-3), 0.0, 1.0);
        return mix(gwLayerSunAt(0u, elevation), gwLayerSunAt(1u, elevation), h);
    }
    // The rows under and over this altitude, each with where it stands.
    var under = 1u;
    var underAt = top;
    var over = 0u;
    var overAt = 1e9;
    for (var s = 0u; s < min(gwParams.sheets, 2u); s = s + 1u) {
        let at = gwParams.sheet[s].altitude;
        if (at <= altitude && at > underAt) {
            under = 2u + s;
            underAt = at;
        }
        if (at > altitude && at < overAt) {
            over = 2u + s;
            overAt = at;
        }
    }
    let low = gwLayerSunAt(under, elevation);
    if (over == 0u) {
        return low;
    }
    return mix(low, gwLayerSunAt(over, elevation), (altitude - underAt) / max(overAt - underAt, 1e-3));
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

// An anvil's density at the height `h`, a share of its layer's depth, over the skirt `s`: a wedge that thins towards
// its rim, densest under its flat top and fading out below, where its ice falls from it.
fn gwLayerAnvil(s: f32, h: f32) -> f32 {
    let thick = GW_LAYER_ANVIL_THICK * s;
    let t = (h - (GW_LAYER_ANVIL_TOP - thick)) / max(thick, 1e-4);
    return clamp(t / 0.4, 0.0, 1.0) * clamp((1.0 - t) / 0.15, 0.0, 1.0) * smoothstep(0.0, 0.25, s);
}

// How much of the clouds' coverage the clearing takes over a point `near` km east and north of the observer: none
// close by, all of it from the clearing's distance on, where one is set.
fn gwLayerCleared(near: vec2f) -> f32 {
    let clearing = gwLayered.clearing;
    if (clearing <= 0.0) {
        return 0.0;
    }
    return smoothstep(min(gwLayered.clearingFrom, 0.99 * clearing), clearing, length(near));
}

// Whether the low layer lies under a front, which changes it.
fn gwLayerUnderFront() -> bool {
    return gwLayered.layer[GW_LAYER_DEEP].enabled != 0u && gwLayered.layer[GW_LAYER_DEEP].kind == 3u && gwLayered.layer[0].enabled != 0u;
}

// The extinction per km at `p` and the optical depth straight up from there to the tops, summed over the layers, or of
// the layer `only` alone, GW_LAYER_COUNT for all.
fn gwLayerDensity(p: vec3f, detailed: bool, only: u32) -> vec2f {
    let altitude = length(p) - gwParams.planetRadius;
    let near = gwLayerGround(p);
    let g = near + gwLayered.observer;
    // Under a front's shield the ground warms no more: the low clouds thin out, and what is left hangs lower and
    // ragged in the rain.
    var shade = 0.0;
    var above = 0.0;
    if (gwLayerUnderFront()) {
        let deep = gwLayered.layer[GW_LAYER_DEEP];
        let front = gwLayerColumn(GW_LAYER_DEEP, g);
        shade = front.b;
        // What hangs under the front's base has all of the front over it.
        let span = gwLayerSpan(deep.depth, front.r);
        above = 0.6 * deep.extinction * (span.y - span.x) * deep.depth * step(altitude, deep.base);
    }
    // Towards the clearing every layer's coverage falls, to nothing at its edge.
    let cleared = gwLayerCleared(near);
    if (cleared >= 1.0) {
        return vec2f(0.0, above);
    }
    var sum = vec2f(0.0);
    for (var i = 0u; i < GW_LAYER_COUNT; i = i + 1u) {
        let l = gwLayered.layer[i];
        if (l.enabled == 0u || (only < GW_LAYER_COUNT && i != only)) {
            continue;
        }
        var base = l.base;
        var depth = l.depth;
        var erosion = l.detail;
        var thinned = cleared;
        if (i == 0u && shade > 0.0) {
            let ragged = smoothstep(0.6, 1.0, shade);
            thinned = max(thinned, GW_LAYER_SHADE_THINS * shade);
            base = base - GW_LAYER_SCUD_DROP * ragged;
            depth = depth * (1.0 - 0.4 * ragged);
            erosion = mix(erosion, 1.0, 0.6 * ragged);
        }
        let h = (altitude - base) / depth;
        if (h <= 0.0 || h >= 1.0) {
            continue;
        }
        // The noise drifts with the layer's clouds. Wrapped here, in full float precision, before the sampler's
        // coarser coordinates see it.
        let local = vec3f(g - l.drift, altitude);
        // The clouds lean with the wind as they rise, and their flanks bulge: the map is read a little off.
        var at = g - gwLayered.shear * (altitude - base);
        if (detailed && l.bulge > 0.0) {
            let bulge = textureSampleLevel(gwLayerDetail, gwLayerSampler, fract(local / max(1.2 * l.size, 2.0 * gwLayered.noiseScale)), 0.0).rb;
            at = at + (bulge - 0.5) * 0.3 * l.bulge * l.size * clamp(2.0 * h, 0.0, 1.0);
        }
        let m = gwLayerColumn(i, at);
        let value = clamp((m.r - thinned) / max(1.0 - thinned, 1e-3), 0.0, 1.0);
        let span = gwLayerSpan(depth, value);
        // How far inside the cloud, in km: over its bottom, and under its top by that top's slope.
        let slope = depth * m.a / max(1.0 - thinned, 1e-3);
        let inside = min(h - span.x, (span.y - h) / sqrt(1.0 + slope * slope)) * depth;
        let edge = clamp(0.1 * depth, 0.15, 0.6);
        let shape = clamp(inside / edge, 0.0, 1.0) * step(1e-3, value);
        var density = shape;
        // Billows heap the surface out where the noise is up, by as much as they are wide, and leave creases between
        // them: more with height, so tops heap up and bottoms stay flat, as in the voxels. The surface gives way a
        // little all over first, which takes the thinnest clouds whole; no billow is bigger than what that leaves of
        // half its cloud, and a billowed surface is as much crisper as it is rougher.
        let give = erosion * GW_LAYER_GIVE * edge;
        let heap = min(erosion * GW_LAYER_HEAP * gwLayered.noiseScale * (0.15 + 0.85 * h), max(0.5 * (span.y - span.x) * depth - give, 0.0));
        if (detailed && erosion > 0.0 && inside > -heap && inside < edge + give) {
            let noise = textureSampleLevel(gwLayerDetail, gwLayerSampler, fract(local / gwLayered.noiseScale), 0.0);
            let heaped = inside - give + heap * mix(noise.b, noise.a, 0.4);
            density = clamp(heaped / (edge * mix(1.0, GW_LAYER_CRISP, erosion)), 0.0, 1.0) * step(1e-3, value);
        }
        var over = 0.6 * shape * max(base + span.y * depth - altitude, 0.0);
        // An anvil: where a tall tower nears the top of its layer it spreads out over its skirt, in thin ice.
        if (l.kind >= 2u && m.g > 0.0) {
            let anvil = GW_LAYER_ANVIL_DENSITY * gwLayerAnvil(m.g, h);
            density = max(density, anvil);
            over = max(over, anvil * max(l.base + GW_LAYER_ANVIL_TOP * l.depth - altitude, 0.0));
        }
        sum = sum + l.extinction * vec2f(density, over);
    }
    return sum + vec2f(0.0, above);
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

// How much of the sun's light the layers take on its way to `p`, by their columns. A sun at the horizon or under it
// counts as one a little up.
fn gwLayerShade(p: vec3f, sun: vec3f) -> f32 {
    let up = normalize(p);
    let towards = normalize(sun + up * 2.0 * max(0.1 - dot(sun, up), 0.0));
    let slant = 1.0 / max(dot(towards, up), 0.05);
    var tau = 0.0;
    for (var i = 0u; i < GW_LAYER_COUNT; i = i + 1u) {
        tau = tau + gwLayerOver(i, p, towards, slant);
    }
    return 1.0 - gwDiffused(tau, GW_LAYER_FORWARD);
}

// The cloud in the sun's way to a point `p` under the layers, as an optical depth: the deep layer's sampled up its
// depth, as tall as its towers stand, the others' by their columns.
fn gwLayerSunDepth(p: vec3f, sun: vec3f) -> f32 {
    let up = normalize(p);
    let slant = 1.0 / max(dot(sun, up), 0.05);
    let altitude = length(p) - gwParams.planetRadius;
    var tau = (gwLayerOver(0u, p, sun, slant) + gwLayerOver(2u, p, sun, slant)) * slant;
    let deep = gwLayered.layer[GW_LAYER_DEEP];
    let rise = deep.depth / f32(GW_LAYER_RAIN_SUN_STEPS);
    for (var k = 0u; k < GW_LAYER_RAIN_SUN_STEPS; k = k + 1u) {
        let over = deep.base + (f32(k) + 0.5) * rise - altitude;
        tau = tau + gwLayerDensity(p + sun * over * slant, false, GW_LAYER_DEEP).x * rise * slant;
    }
    return tau;
}

// How much of the full rain falls through `p`, 0 to 1, and the optical depth of the deep layer straight over where it
// fell from: rain in curtains under the deep layer's dense columns, the towers of a shower or a front's wall, none past
// the clearing. A curtain hangs in streaks and trails behind its cloud, more the farther it has fallen. Asked for a
// stretch `across` km long, the streaks narrower than that are taken at their mean.
fn gwLayerRain(p: vec3f, across: f32) -> vec2f {
    let deep = gwLayered.layer[GW_LAYER_DEEP];
    let fallen = max(deep.base - (length(p) - gwParams.planetRadius), 0.0);
    let near = gwLayerGround(p) + gwLayered.rainLean * fallen * (0.4 + 0.6 * fallen / deep.base);
    let g = near + gwLayered.observer;
    let m = gwLayerColumn(GW_LAYER_DEEP, g);
    let thinned = gwLayerCleared(near);
    let value = clamp((m.r - thinned) / max(1.0 - thinned, 1e-3), 0.0, 1.0);
    let rain = smoothstep(GW_LAYER_RAIN_FROM.x, GW_LAYER_RAIN_FROM.y, value);
    if (rain <= 0.0) {
        return vec2f(0.0);
    }
    let field = textureSampleLevel(gwLayerDetail, gwLayerSampler, vec3f(fract((g - deep.drift) / GW_LAYER_RAIN_STREAKS), 0.5), 0.0).b;
    let streaks = mix(GW_LAYER_RAIN_BETWEEN, 1.0, mix(smoothstep(0.3, 0.7, field), 0.5, clamp(2.0 * across / GW_LAYER_RAIN_STREAKS, 0.0, 1.0)));
    let span = gwLayerSpan(deep.depth, value);
    return vec2f(rain * streaks, deep.extinction * (span.y - span.x) * deep.depth);
}

// The rain in the sun's way to `p`, a point in the rain under the deep layer's base, as a share of the full rain times
// the km of that way: what dims the sun for the rain behind a curtain's lit face.
fn gwLayerWet(p: vec3f, sun: vec3f) -> f32 {
    let up = normalize(p);
    let under = max(gwLayered.layer[GW_LAYER_DEEP].base - (length(p) - gwParams.planetRadius), 0.0);
    let way = min(under / max(dot(sun, up), 0.05), GW_LAYER_RAIN_WET_REACH);
    var wet = 0.0;
    for (var k = 0u; k < GW_LAYER_RAIN_WET_STEPS; k = k + 1u) {
        wet = wet + gwLayerRain(p + sun * way * (f32(k) + 0.5) / f32(GW_LAYER_RAIN_WET_STEPS), way).x;
    }
    return wet * way / f32(GW_LAYER_RAIN_WET_STEPS);
}

// The lowest base and the highest top of the layers that are on.
fn gwLayerBounds() -> vec2f {
    var bounds = vec2f(1e9, -1e9);
    for (var i = 0u; i < GW_LAYER_COUNT; i = i + 1u) {
        if (gwLayered.layer[i].enabled != 0u) {
            let base = gwLayered.layer[i].base;
            bounds = vec2f(min(bounds.x, base), max(bounds.y, base + gwLayered.layer[i].depth));
        }
    }
    if (gwLayerUnderFront()) {
        bounds.x = min(bounds.x, gwLayered.layer[0].base - GW_LAYER_SCUD_DROP);
    }
    return bounds;
}

@compute @workgroup_size(8, 8, 1)
fn gwLayers(@builtin(global_invocation_id) id: vec3u) {
    let size = gwOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let v = gwLayerRay(vec2f(id.xy) + 0.5, size);
    let radius = gwParams.planetRadius;
    let o = vec3f(0.0, 0.0, radius + gwParams.observerAltitude);
    let sun = normalize(gwParams.sunDirection);
    let bounds = gwLayerBounds();
    var luminance = vec3f(0.0);
    var through = 1.0;
    if (bounds.x < bounds.y) {
        // The stretch of the ray between the lowest base and the highest top, short of the ground.
        let shell = gwShell(o, v, radius + bounds.x, radius + bounds.y, radius);
        let outer = gwSphere(o, v, radius + bounds.y);
        let earth = gwSphere(o, v, radius);
        let grounded = earth.hits && earth.near > 0.0;
        let t0 = shell.near;
        let t1 = select(-1.0, min(shell.far, t0 + gwLayered.reach), shell.hits);
        let fade = max(gwLayered.fade, 1e-3);
        let horizon = gwParams.horizonLuminance;
        let cosTheta = dot(v, sun);
        let jitter = gwLayerJitter(id.xy, gwParams.frame);
        // Where a sample falls within its stretch: jittered alike wherever asked, the middle without jitter.
        let within = mix(0.5, jitter, gwParams.jitter);
        // How much of the air along the ray lies in the layers' shade, up to the ground or the layers' top: asked where
        // the air's light comes from, more of it near and low.
        let farthest = min(select(outer.far, earth.near, grounded), 4.0 * fade);
        let lit = 1.0 - exp(-max(farthest, 0.0) / fade);
        var shade = vec2f(0.0);
        // With god rays their table answers instead, for each stretch of the ray and for the air in front of a cloud,
        // and the shade takes the air's share of the light behind, not its light as a share of the horizon's.
        let way = gwGodRaysWay(v);
        var airShare = lit;
        if (GW_GOD_RAYS) {
            let shares = gwGodRaysShares(cosTheta, fade);
            let air = gwGodRaysAir(o, v, way, lit, fade, bounds, shares);
            shade = vec2f(air.x, 1.0);
            airShare = gwGodRaysShare(o, v, air.y, lit, farthest, fade, grounded, shares);
        }
        for (var k = 0u; k < select(GW_LAYER_AIR_STEPS, 0u, GW_GOD_RAYS); k = k + 1u) {
            let part = (f32(k) + within) / f32(GW_LAYER_AIR_STEPS);
            let p = o + v * (-fade * log(1.0 - part * lit));
            let thin = exp(-max(length(p) - radius, 0.0) / 8.0);
            shade = shade + thin * vec2f(gwLayerShade(p, sun), 1.0);
        }
        let shaded = GW_LAYER_AIR_SHADED * shade.x / max(shade.y, 1e-6);
        // Shaded air is lit by the clouds over it and the ground under it: gray, and dim.
        let murk = GW_LAYER_AIR_UNDER * mix(horizon, vec3f(dot(horizon, GW_LAYER_LUMA)), 0.7);
        let haze = mix(horizon, murk, shaded);
        // Jittered by a whole stride, so the bands a fixed start would draw turn into grain.
        var t = t0 + jitter * gwParams.jitter * gwLayered.stepMin * (1.0 + max(t0, 0.0) * gwLayered.stepGrowth) * 2.5;
        // Striding through clear air; at the first cloud a stride back, and on in steps until the air has been clear
        // for a few of them.
        var striding = true;
        var clear = 0u;
        for (var i = 0u; i < GW_LAYER_MAX_STEPS; i = i + 1u) {
            if (t >= t1 || through < GW_LAYER_MIN_TRANSMITTANCE) {
                break;
            }
            let step = gwLayered.stepMin * (1.0 + t * gwLayered.stepGrowth);
            let p = o + v * t;
            let here = gwLayerDensity(p, true, GW_LAYER_COUNT);
            if (here.x <= 0.0) {
                clear = clear + 1u;
                striding = striding || clear > 6u;
                t = t + select(step, step * 2.5, striding);
                continue;
            }
            if (striding) {
                striding = false;
                clear = 0u;
                t = max(t - step * 2.5, t0) + step;
                continue;
            }
            clear = 0u;
            // The cloud between here and the sun: six samples, each twice as far as the last, the first two detailed.
            var tau = 0.0;
            var reach = 0.06;
            for (var k = 0u; k < 6u; k = k + 1u) {
                tau = tau + gwLayerDensity(p + sun * (reach * 1.5 - 0.06), k < 2u, GW_LAYER_COUNT).x * reach;
                reach = reach * 2.0;
            }
            let up = p / length(p);
            let light = gwLayerSunlight(length(p) - radius, asin(clamp(dot(sun, up), -1.0, 1.0)));
            // The sun's light scattered once, and again and again as octaves, each through less cloud, its lobe wider.
            var orders = 0.0;
            var share = 1.0;
            var depth = 1.0;
            var lobe = 1.0;
            for (var k = 0u; k < 4u; k = k + 1u) {
                let phase = 0.8 * gwHenyeyGreenstein(cosTheta, GW_LAYER_FORWARD_G * lobe) + 0.2 * gwHenyeyGreenstein(cosTheta, GW_LAYER_BACKWARD_G * lobe);
                orders = orders + share * exp(-tau * depth) * phase;
                share = share * gwLayered.multiScatter;
                depth = depth * max(gwLayered.multiScatter, 0.5);
                lobe = lobe * 0.5;
            }
            // Deep inside, the octaves die out long before the light does: it diffuses on, without a direction.
            orders = max(orders, gwLayered.multiScatter * gwDiffused(tau, GW_LAYER_FORWARD_G) / (4.0 * GW_PI));
            // The sky's light from above, through the cloud overhead, and the ground's from below, each a hemisphere of
            // even radiance E / pi, half of which an isotropic phase scatters our way; and a little from all around.
            let fromSky = gwParams.skyIrradiance * exp(-0.2 * here.y);
            let ambient = gwLayered.ambient * ((fromSky + gwParams.groundIrradiance) / (2.0 * GW_PI) + 0.1 * horizon);
            let source = light * orders + ambient;
            let passed = exp(-here.x * step);
            let near = exp(-t / fade);
            var veil = haze;
            if (GW_GOD_RAYS) {
                veil = mix(horizon, murk, GW_LAYER_AIR_SHADED * gwGodRaysBefore(o, v, way, t, bounds));
            }
            luminance = luminance + through * (1.0 - passed) * (source * near + veil * (1.0 - near));
            through = through * passed;
            t = t + step;
        }
        // A march ends on a hundredth let through, and a sun behind would still shine through that: it counts as none.
        through = max(through - GW_LAYER_MIN_TRANSMITTANCE, 0.0) / (1.0 - GW_LAYER_MIN_TRANSMITTANCE);
        // Rain under the deep layer, along the ray's stretch between the ground and that layer's base: more points near
        // than far. Where the sun reaches it, it sends the sun's light back by the rain's phase function, the bows in
        // it, less the deeper in the rain; all of it is lit by the sky through the cloud overhead and by the ground.
        // Seen from under the base it lies in front of the clouds, from above behind them.
        let deep = gwLayered.layer[GW_LAYER_DEEP];
        if (gwLayered.rain > 0.0 && deep.enabled != 0u && deep.kind >= 2u) {
            let lid = gwSphere(o, v, radius + deep.base);
            let start = max(lid.near, 0.0);
            let end = min(select(lid.far, min(lid.far, earth.near), grounded), start + GW_LAYER_RAIN_REACH);
            if (lid.hits && end > start) {
                let bows = gwRainbowPhase(cosTheta, gwLayerRainbow, gwLayerSampler);
                var rained = vec3f(0.0);
                var dry = 1.0;
                var before = start;
                for (var k = 0u; k < GW_LAYER_RAIN_STEPS; k = k + 1u) {
                    let part = (f32(k) + 1.0) / f32(GW_LAYER_RAIN_STEPS);
                    let after = start + (end - start) * part * part;
                    let t = mix(before, after, within);
                    let step = after - before;
                    before = after;
                    let p = o + v * t;
                    let falling = gwLayerRain(p, step);
                    if (falling.x <= 0.0) {
                        continue;
                    }
                    let up = p / length(p);
                    let light = gwLayerSunlight(length(p) - radius, asin(clamp(dot(sun, up), -1.0, 1.0)));
                    let direct = exp(-gwLayerSunDepth(p, sun) - gwLayered.rain * gwLayerWet(p, sun));
                    let fromSky = gwParams.skyIrradiance * gwDiffused(falling.y, GW_LAYER_FORWARD);
                    let source = light * direct * bows + gwLayered.ambient * (fromSky + gwParams.groundIrradiance) / (4.0 * GW_PI);
                    let passed = exp(-gwLayered.rain * falling.x * step);
                    let near = exp(-t / fade);
                    rained = rained + dry * (1.0 - passed) * (source * near + haze * (1.0 - near));
                    dry = dry * passed;
                }
                if (gwParams.observerAltitude < deep.base) {
                    luminance = rained + dry * luminance;
                } else {
                    luminance = luminance + through * rained;
                }
                through = through * dry;
            }
        }
        // The layers' shadow on the ground, where the ray ends there: what they let through of the sun's light on its
        // way down to that point, taken from what the ground sends back. The sky's light on it stays, and the air in
        // front hides the far ground's shadows as it hides the ground.
        if (grounded && through > 0.0) {
            let at = o + v * earth.near;
            let rise = dot(sun, at / length(at));
            if (rise > 0.0) {
                let slant = 1.0 / max(rise, 0.05);
                var tau = 0.0;
                for (var i = 0u; i < GW_LAYER_COUNT; i = i + 1u) {
                    // A flat layer by its column, which has no grain; towers and a front sampled up their height, so
                    // that their shadows are as long as they are tall.
                    if (gwLayered.layer[i].enabled == 0u || gwLayered.layer[i].kind < 2u) {
                        tau = tau + gwLayerOver(i, at, sun, slant) * slant;
                        continue;
                    }
                    let deep = gwLayered.layer[i].depth / f32(GW_LAYER_SHADOW_STEPS);
                    for (var k = 0u; k < GW_LAYER_SHADOW_STEPS; k = k + 1u) {
                        let altitude = gwLayered.layer[i].base + (f32(k) + within) * deep;
                        tau = tau + gwLayerDensity(at + sun * altitude * slant, false, i).x * deep * slant;
                    }
                }
                // The sun's share of the light on the ground, by illuminance: what a full shadow takes.
                let fromSun = dot(gwParams.sunIlluminance, GW_LAYER_LUMA) * rise;
                let sunShare = fromSun / max(fromSun + dot(gwParams.skyIrradiance, GW_LAYER_LUMA), 1e-6);
                let dark = sunShare * (1.0 - gwDiffused(tau, GW_LAYER_FORWARD)) * exp(-earth.near / fade);
                through = through * (1.0 - dark);
            }
        }
        // What lies behind the layers is seen through the air under them: where that is shaded, less of the sky's or
        // the ground's own color arrives, and the shaded air's gray instead.
        let veiled = shaded * airShare;
        luminance = luminance + through * veiled * murk;
        through = through * (1.0 - veiled);
    }
    gwOutputStore(id.xy, vec4f(luminance, through));
}
