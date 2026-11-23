// The formation research figure: three layers of cloud, each a map of its own size and kind, marched together as one
// density with nothing baked but the maps, the way Horizon Zero Dawn and Red Dead Redemption 2 do it: every change is
// free, at the price of a march that samples towards the sun. For trying what the layers should be before any of
// them gets a distance field. Requires the research prelude, gewoelk's `noise.wgsl` and the `FormationLab` struct.

// A layer: its kind, 0 a layer from scattered heaps to a closed deck, 2 towers, 3 a front; a slab `depth` km deep from
// `base` km up; a map of one `tile` km with features `feature` km across; and for a front `a` km from the observer to
// its leading edge, along the heading `b` in radians, `c` km deep from front to back. `lumps` is how deep the cells on
// top cut, `warp` how far the flanks bulge, and `anvilX` and `anvilY` how far the anvils reach downwind, in the map's
// cells.
struct FormLayer {
    enabled: f32,
    kind: f32,
    base: f32,
    depth: f32,
    coverage: f32,
    tile: f32,
    feature: f32,
    extinction: f32,
    detail: f32,
    sharp: f32,
    driftX: f32,
    driftY: f32,
    a: f32,
    b: f32,
    c: f32,
    seed: f32,
    lumps: f32,
    anvilX: f32,
    anvilY: f32,
    warp: f32,
}

const FORM_LAYERS: u32 = 3u;
// The deep layer, whose front the low layer answers to, and how far the low clouds' base sinks in its rain, in km.
const FORM_DEEP: u32 = 1u;
const SCUD_DROP: f32 = 0.45;
// How much of the low clouds' coverage a front's full shade takes.
const SHADE_THINS: f32 = 0.8;
// Where an anvil's top lies, as a share of its layer's depth, and how thick it is at its tower.
const ANVIL_TOP: f32 = 0.9;
const ANVIL_THICK: f32 = 0.22;
// An anvil's ice against a tower's water, in extinction.
const ANVIL_DENSITY: f32 = 0.2;
// The shadow of towers on the ground: the samples along the sun's way up through their layer.
const SHADOW_STEPS: u32 = 16u;
// How far a billow heaps the surface out, as a share of the detail noise's tile, of which a billow spans a quarter,
// how far the surface gives way between billows, as a share of its soft edge, and what is left of that edge, both at
// full detail.
const HEAP: f32 = 0.2;
const GIVE: f32 = 0.4;
const CRISP: f32 = 0.35;
// The air under the layers: the points along a ray it is asked at whether they lie in the layers' shade, how much of
// the air's light a full shade takes, and what the shaded air still sends, as a share of the sunlit air's.
const AIR_STEPS: u32 = 6u;
const AIR_SHADED: f32 = 0.8;
const AIR_UNDER: f32 = 0.3;
// How far forwards the layers' droplets scatter, for what light a cloud lets through to the air and the ground under it.
const FORWARD: f32 = 0.85;
// A front's wall of towers, as a share of the way from its leading edge to its back: where it stands and how wide.
const WALL_AT: f32 = 0.09;
const WALL_WIDE: f32 = 0.06;

@group(0) @binding(0) var<uniform> F: FormationLab;
@group(0) @binding(1) var<uniform> L: array<FormLayer, 3>;
@group(0) @binding(2) var<uniform> V: LabView;
@group(0) @binding(3) var formMaps: texture_2d_array<f32>;
@group(0) @binding(4) var formSampler: sampler;
@group(0) @binding(5) var formDetail: texture_3d<f32>;
@group(0) @binding(6) var formClouds: texture_2d<f32>;
@group(0) @binding(7) var formClamp: sampler;
@group(0) @binding(8) var<uniform> formBake: vec4u;
@group(0) @binding(9) var formMapOut: texture_storage_2d_array<rgba16float, write>;
@group(1) @binding(0) var formOut: texture_storage_2d<rgba16float, write>;
@group(1) @binding(1) var formCanvas: texture_storage_2d<rgba16float, write>;

// A layer's map at `uv`: x a column's value, y the skirt of an anvil, z how far a front shades what lies under it.
fn formValue(layer: u32, uv: vec2f) -> vec3f {
    let l = L[layer];
    let seed = u32(l.seed) + layer * 17u;
    let cells = max(1, i32(round(l.tile / max(l.feature, 1e-3))));
    let p = uv * f32(cells);
    let field = gwFbm(vec3f(p, F.phase), vec3i(cells, cells, 8), 5u, seed);
    let spread = clamp((field - 0.5) * 2.4 + 0.5, 0.0, 1.0);
    // Two more fields pull the lattices out of true, so that no outline is a circle.
    let twice = vec3i(2 * cells, 2 * cells, 8);
    let pull = vec2f(gwFbm(vec3f(p * 2.0, F.phase), twice, 3u, seed + 31u), gwFbm(vec3f(p * 2.0, F.phase), twice, 3u, seed + 37u)) - 0.5;
    let kind = u32(l.kind + 0.5);
    let reach = vec2f(l.anvilX, l.anvilY);
    if (kind <= 1u) {
        // The thesis' map: what the coverage leaves of the field, its edges hardened by the sharpness.
        var value = pow(clamp((spread - (1.0 - l.coverage)) / max(l.coverage, 1e-3), 0.0, 1.0), 1.0 - 0.8 * l.sharp);
        // Rounded on top: a column grows fast near a cloud's edge and levels off towards its middle.
        value = 1.0 - (1.0 - value) * (1.0 - value);
        // Cells on top, of two sizes: the turrets of a heap, the pillows of a deck.
        let q = p + pull * 0.6;
        let tops = gwPillows(q * 2.0, vec2i(2 * cells), seed + 7u) * (0.75 + 0.25 * gwPillows(q * 5.0, vec2i(5 * cells), seed + 8u));
        return vec3f(value * (1.0 - l.lumps * (1.0 - tops)), 0.0, 0.0);
    }
    // A front, x from its leading edge to its back, y along it, its line swaying with the field: its towers are those
    // of one column of twelve, which the wall stands on.
    let x = uv.x + (field - 0.5) * 0.12;
    var at = p;
    var period = vec2i(cells);
    if (kind == 3u) {
        at = vec2f((x - WALL_AT) * 12.0 + 1.5, uv.y * f32(cells));
        period = vec2i(12, cells);
    }
    let q = at + pull * 0.35;
    let towers = gwTowers(q, period, select(l.coverage, 0.9, kind == 3u), reach, select(-1, 1, kind == 3u), seed + 9u);
    // Turrets on a tower, of two sizes, the taller ones towards its middle.
    let turrets = gwPillows(q * 4.0, 4 * period, seed + 12u) * (0.65 + 0.35 * gwPillows(q * 10.0, 10 * period, seed + 13u));
    let tower = towers.x * (0.8 + 0.4 * spread) * (1.0 - 0.45 * l.lumps * (1.0 - turrets));
    // An anvil is drawn out into fibers along the wind, a field averaged along it: they thin it, and fray its rim.
    let far = length(reach);
    var streaks = 0.0;
    for (var k = -3; k <= 3; k = k + 1) {
        let along = at + reach / max(far, 1e-4) * f32(k) * 0.12;
        streaks = streaks + gwFbm(vec3f(along * 10.0, F.phase), vec3i(10 * period, 8), 3u, seed + 41u) / 7.0;
    }
    let fibers = clamp((streaks - 0.35) * 4.0, 0.0, 1.0);
    let frayed = clamp(towers.y * (0.5 + 0.5 * fibers) - 0.3 * (1.0 - fibers) * (1.0 - towers.y), 0.0, 1.0);
    if (kind == 2u) {
        return vec3f(clamp(tower, 0.0, 1.0), frayed, 0.0);
    }
    // A wall of towers on a ridge behind the edge, and a shield of layered cloud thinning out to the rear.
    let lead = smoothstep(0.0, 0.05, x);
    let across = (x - WALL_AT) / WALL_WIDE;
    let wall = sqrt(max(1.0 - across * across * across * across, 0.0));
    let shield = lead * smoothstep(0.98, 0.5, x);
    let layered = shield * (0.3 + 0.25 * spread) * (0.4 + 0.6 * l.coverage);
    let value = max(layered, wall * max(0.35 + 0.2 * spread, tower));
    return vec3f(clamp(value, 0.0, 1.0), frayed, shield);
}

@compute @workgroup_size(8, 8, 1)
fn formBakeMap(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(formMapOut).xy;
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let layer = formBake.x;
    let l = L[layer];
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    let texel = 1.0 / vec2f(size);
    let here = formValue(layer, uv);
    // How steep the columns' tops are, per km: the march turns a height over a top into a distance from it.
    let km = vec2f(select(l.tile, l.c, u32(l.kind + 0.5) == 3u), l.tile) * texel;
    let rise = vec2f(formValue(layer, uv + vec2f(texel.x, 0.0)).x, formValue(layer, uv + vec2f(0.0, texel.y)).x) - here.x;
    textureStore(formMapOut, vec2i(id.xy), layer, vec4f(here, length(rise / km)));
}

// A layer's map over the ground point `g`, km east and north of the observer: r the column's value, g the anvils'
// skirt, b a front's shade, a the tops' slope per km. A front is placed, not tiled: nothing ahead of its edge or
// behind its back.
fn formColumn(i: u32, g: vec2f) -> vec4f {
    let l = L[i];
    var uv = (g - vec2f(l.driftX, l.driftY)) / l.tile;
    if (u32(l.kind + 0.5) == 3u) {
        let heading = vec2f(sin(l.b), cos(l.b));
        let x = (dot(g, heading) - l.a) / l.c;
        if (x <= 0.0 || x >= 1.0) {
            return vec4f(0.0);
        }
        uv = vec2f(x, dot(g, vec2f(heading.y, -heading.x)) / l.tile);
    }
    return textureSampleLevel(formMaps, formSampler, uv, i32(i), 0.0);
}

// Where a column of value `m` has its bottom and its top, as shares of a layer `depth` km deep: the bottoms nearly
// flat and at one height whatever the depth, as rising air condenses at one level, the tops as tall as the value.
fn formSpan(depth: f32, m: f32) -> vec2f {
    let dip = min(0.15 / depth, 0.3);
    return vec2f(dip * (1.0 - m), dip + m * (1.0 - dip));
}

// An anvil's density at the height `h`, a share of its layer's depth, over the skirt `s`: a wedge that thins towards
// its rim, densest under its flat top and fading out below, where its ice falls from it.
fn formAnvil(s: f32, h: f32) -> f32 {
    let thick = ANVIL_THICK * s;
    let t = (h - (ANVIL_TOP - thick)) / max(thick, 1e-4);
    return clamp(t / 0.4, 0.0, 1.0) * clamp((1.0 - t) / 0.15, 0.0, 1.0) * smoothstep(0.0, 0.25, s);
}

// How much of the clouds' coverage the clearing takes over the ground point `g`: none near the observer, all of it from
// the clearing's distance on, where one is set.
fn formCleared(g: vec2f) -> f32 {
    if (F.clearing <= 0.0) {
        return 0.0;
    }
    return smoothstep(min(F.clearFrom, 0.99 * F.clearing), F.clearing, length(g - V.flown));
}

// Whether the low layer lies under a front, which changes it.
fn formUnderFront() -> bool {
    return L[FORM_DEEP].enabled > 0.5 && u32(L[FORM_DEEP].kind + 0.5) == 3u && L[0].enabled > 0.5;
}

// The extinction per km at `p` and the optical depth straight up from there to the tops, summed over the layers, or of
// the layer `only` alone, FORM_LAYERS for all.
fn formAt(p: vec3f, detailed: bool, only: u32) -> vec2f {
    let radius = length(p);
    let altitude = radius - V.planetRadius;
    let up = p / radius;
    let g = labGround(up) * radius + V.flown;
    // Under a front's shield the ground warms no more: the low clouds thin out, and what is left hangs lower and
    // ragged in the rain.
    var shade = 0.0;
    var above = 0.0;
    if (formUnderFront()) {
        let front = formColumn(FORM_DEEP, g);
        shade = front.b;
        // What hangs under the front's base has all of the front over it.
        let span = formSpan(L[FORM_DEEP].depth, front.r);
        above = 0.6 * L[FORM_DEEP].extinction * (span.y - span.x) * L[FORM_DEEP].depth * step(altitude, L[FORM_DEEP].base);
    }
    // Towards the clearing every layer's coverage falls, to nothing at its edge.
    let cleared = formCleared(g);
    if (cleared >= 1.0) {
        return vec2f(0.0, above);
    }
    var sum = vec2f(0.0);
    for (var i = 0u; i < FORM_LAYERS; i = i + 1u) {
        let l = L[i];
        if (l.enabled < 0.5 || (only < FORM_LAYERS && i != only)) {
            continue;
        }
        var base = l.base;
        var depth = l.depth;
        var erosion = l.detail;
        var thinned = cleared;
        if (i == 0u && shade > 0.0) {
            let ragged = smoothstep(0.6, 1.0, shade);
            thinned = max(thinned, SHADE_THINS * shade);
            base = base - SCUD_DROP * ragged;
            depth = depth * (1.0 - 0.4 * ragged);
            erosion = mix(erosion, 1.0, 0.6 * ragged);
        }
        let h = (altitude - base) / depth;
        if (h <= 0.0 || h >= 1.0) {
            continue;
        }
        let kind = u32(l.kind + 0.5);
        // The clouds lean with the wind as they rise, and their flanks bulge: the map is read a little off.
        var at = g - vec2f(F.shearX, F.shearY) * (altitude - base);
        if (detailed && l.warp > 0.0) {
            let bulge = textureSampleLevel(formDetail, formSampler, vec3f(g, altitude) / max(1.2 * l.feature, 2.0 * F.noiseKm), 0.0).rb;
            at = at + (bulge - 0.5) * 0.3 * l.warp * l.feature * clamp(2.0 * h, 0.0, 1.0);
        }
        let m = formColumn(i, at);
        let value = clamp((m.r - thinned) / max(1.0 - thinned, 1e-3), 0.0, 1.0);
        let span = formSpan(depth, value);
        // How far inside the cloud, in km: over its bottom, and under its top by that top's slope.
        let slope = depth * m.a / max(1.0 - thinned, 1e-3);
        let inside = min(h - span.x, (span.y - h) / sqrt(1.0 + slope * slope)) * depth;
        let edge = clamp(0.1 * depth, 0.15, 0.6);
        let shape = clamp(inside / edge, 0.0, 1.0) * step(1e-3, value);
        var density = shape;
        // Billows heap the surface out where the noise is up, by as much as they are wide, and leave creases between
        // them: more with height, so tops heap up and bottoms stay flat, as in the library's voxels.
        // The surface gives way a little all over first, which takes the thinnest clouds whole; no billow is bigger than
        // what that leaves of half its cloud, and a billowed surface is as much crisper as it is rougher.
        let give = erosion * GIVE * edge;
        let heap = min(erosion * HEAP * F.noiseKm * (0.15 + 0.85 * h), max(0.5 * (span.y - span.x) * depth - give, 0.0));
        if (detailed && erosion > 0.0 && inside > -heap && inside < edge + give) {
            let noise = textureSampleLevel(formDetail, formSampler, vec3f(g, altitude) / F.noiseKm, 0.0);
            let heaped = inside - give + heap * mix(noise.b, noise.a, 0.4);
            density = clamp(heaped / (edge * mix(1.0, CRISP, erosion)), 0.0, 1.0) * step(1e-3, value);
        }
        var over = 0.6 * shape * max(base + span.y * depth - altitude, 0.0);
        // An anvil: where a tall tower nears the top of its layer it spreads out over its skirt, in thin ice.
        if (kind >= 2u && m.g > 0.0) {
            let anvil = ANVIL_DENSITY * formAnvil(m.g, h);
            density = max(density, anvil);
            over = max(over, anvil * max(l.base + ANVIL_TOP * l.depth - altitude, 0.0));
        }
        sum = sum + l.extinction * vec2f(density, over);
    }
    return sum + vec2f(0.0, above);
}

// The optical depth of the layer `i` straight up over `p`, by its column alone: its map read where the way `towards`
// the sun crosses the layer's base, `slant` km for each km up.
fn formOver(i: u32, p: vec3f, towards: vec3f, slant: f32) -> f32 {
    let l = L[i];
    let altitude = length(p) - V.planetRadius;
    if (l.enabled < 0.5 || altitude >= l.base + l.depth) {
        return 0.0;
    }
    let q = p + towards * max(l.base - altitude, 0.0) * slant;
    let g = labGround(q / length(q)) * length(q) + V.flown;
    let m = formColumn(i, g);
    let thinned = formCleared(g);
    let value = clamp((m.r - thinned) / max(1.0 - thinned, 1e-3), 0.0, 1.0);
    let span = formSpan(l.depth, value);
    let column = min(l.base + span.y * l.depth - altitude, (span.y - span.x) * l.depth) * step(1e-3, value);
    return l.extinction * (max(column, 0.0) + ANVIL_DENSITY * ANVIL_THICK * m.g * l.depth * (1.0 - thinned));
}

// How much of the sun's light the layers take on its way to `p`, by their columns. A sun at the horizon or under it
// counts as one a little up.
fn formShade(p: vec3f, sun: vec3f) -> f32 {
    let up = normalize(p);
    let towards = normalize(sun + up * 2.0 * max(0.1 - dot(sun, up), 0.0));
    let slant = 1.0 / max(dot(towards, up), 0.05);
    var tau = 0.0;
    for (var i = 0u; i < FORM_LAYERS; i = i + 1u) {
        tau = tau + formOver(i, p, towards, slant);
    }
    return 1.0 - labPassed(tau, FORWARD);
}

// The lowest base and the highest top of the layers that are on.
fn formBounds() -> vec2f {
    var bounds = vec2f(1e9, -1e9);
    for (var i = 0u; i < FORM_LAYERS; i = i + 1u) {
        if (L[i].enabled > 0.5) {
            bounds = vec2f(min(bounds.x, L[i].base), max(bounds.y, L[i].base + L[i].depth));
        }
    }
    if (formUnderFront()) {
        bounds.x = min(bounds.x, L[0].base - SCUD_DROP);
    }
    return bounds;
}

@compute @workgroup_size(8, 8, 1)
fn formMarch(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(formOut);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let v = labRay(V, vec2f(id.xy) + 0.5, size);
    let o = vec3f(0.0, 0.0, V.planetRadius + V.observer);
    let sun = normalize(V.sun);
    let bounds = formBounds();
    var luminance = vec3f(0.0);
    var through = 1.0;
    if (bounds.x < bounds.y) {
        // The stretch of the ray between the lowest base and the highest top, short of the ground.
        let inner = labSphere(o, v, V.planetRadius + bounds.x);
        let outer = labSphere(o, v, V.planetRadius + bounds.y);
        let ground = labSphere(o, v, V.planetRadius);
        var t0 = 0.0;
        var t1 = outer.y;
        if (V.observer < bounds.x) {
            t0 = inner.y;
        } else if (V.observer > bounds.y) {
            t0 = max(outer.x, 0.0);
            t1 = select(outer.y, inner.x, inner.x > 0.0);
        } else if (inner.x > 0.0) {
            t1 = inner.x;
        }
        if (ground.x > 0.0) {
            t1 = min(t1, ground.x);
        }
        if (outer.x < 0.0 && outer.y < 0.0) {
            t1 = -1.0;
        }
        t1 = min(t1, t0 + F.reachKm);
        let cosTheta = dot(v, sun);
        let overhead = labAmbient(V, labSky(vec3f(0.0, 0.0, 1.0), sun));
        let around = labAmbient(V, labSky(normalize(vec3f(v.xy, 0.08)), sun));
        // How much of the air along the ray lies in the layers' shade, up to the ground or the layers' top: asked where
        // the air's light comes from, more of it near and low, at points jittered alike.
        let farthest = min(select(outer.y, ground.x, ground.x > 0.0), 4.0 * F.fadeKm);
        let lit = 1.0 - exp(-max(farthest, 0.0) / F.fadeKm);
        var shade = vec2f(0.0);
        for (var k = 0u; k < AIR_STEPS; k = k + 1u) {
            let part = (f32(k) + gwJitter(id.xy, u32(V.frame))) / f32(AIR_STEPS);
            let p = o + v * (-F.fadeKm * log(1.0 - part * lit));
            let thin = exp(-max(length(p) - V.planetRadius, 0.0) / 8.0);
            shade = shade + thin * vec2f(formShade(p, sun), 1.0);
        }
        let shaded = AIR_SHADED * shade.x / max(shade.y, 1e-6);
        // Shaded air is lit by the clouds over it and the ground under it: gray, and dim.
        let murk = AIR_UNDER * mix(around, vec3f(dot(around, vec3f(0.2126, 0.7152, 0.0722))), 0.7);
        let haze = mix(labAmbient(V, labAirFrom(V, v, sun)), murk, shaded);
        // Jittered by a whole stride, so the bands a fixed start would draw turn into grain.
        var t = t0 + gwJitter(id.xy, u32(V.frame)) * F.stepKm * (1.0 + max(t0, 0.0) * F.stepGrowth) * 2.5;
        // Striding through clear air; at the first cloud a stride back, and on in steps until the air has been clear
        // for a few of them.
        var striding = true;
        var clear = 0u;
        for (var i = 0u; i < u32(F.steps); i = i + 1u) {
            if (t >= t1 || through < 0.01) {
                break;
            }
            let step = F.stepKm * (1.0 + t * F.stepGrowth);
            let p = o + v * t;
            let here = formAt(p, true, FORM_LAYERS);
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
                tau = tau + formAt(p + sun * (reach * 1.5 - 0.06), k < 2u, FORM_LAYERS).x * reach;
                reach = reach * 2.0;
            }
            let altitude = length(p) - V.planetRadius;
            let light = labLight(V, dot(sun, p / length(p)), altitude);
            // The sun's light scattered once, and again and again as octaves, each through less cloud with a wider lobe.
            var orders = 0.0;
            var share = 1.0;
            var depth = 1.0;
            var lobe = 1.0;
            for (var k = 0u; k < 4u; k = k + 1u) {
                let phase = 0.8 * gwHenyeyGreenstein(cosTheta, 0.8 * lobe) + 0.2 * gwHenyeyGreenstein(cosTheta, -0.15 * lobe);
                orders = orders + share * exp(-tau * depth) * phase;
                share = share * F.multiple;
                depth = depth * max(F.multiple, 0.5);
                lobe = lobe * 0.5;
            }
            // Deep inside, the octaves die out long before the light does: it diffuses on, without a direction.
            orders = max(orders, F.multiple / (4.0 * LAB_PI * (1.0 + 0.15 * tau)));
            // The sky's light from above, through the cloud overhead, and the sunlit ground's from below.
            let gray = dot(overhead, vec3f(0.2126, 0.7152, 0.0722));
            let fromSky = mix(overhead, vec3f(gray), 0.5) * 0.6 * exp(-0.2 * here.y);
            let fromGround = labLight(V, sun.z, 0.0) * max(sun.z, 0.0) * 0.25 / LAB_PI * 0.35;
            let ambient = F.ambient * (fromSky + fromGround + around * 0.1);
            let source = light * orders + ambient;
            let passed = exp(-here.x * step);
            let near = exp(-t / F.fadeKm);
            luminance = luminance + through * (1.0 - passed) * (source * near + haze * (1.0 - near));
            through = through * passed;
            t = t + step;
        }
        // A march ends on a hundredth let through, and a sun behind would still shine through that: it counts as none.
        through = max(through - 0.01, 0.0) / 0.99;
        // The layers' shadow on the ground, where the ray ends there: what they let through of the sun's light on its
        // way down to that point, taken from what the ground sends back. The sky's light on it stays, and the air in
        // front hides the far ground's shadows as it hides the ground.
        if (ground.x > 0.0 && through > 0.0) {
            let at = o + v * ground.x;
            let rise = dot(sun, at / length(at));
            if (rise > 0.0) {
                let slant = 1.0 / max(rise, 0.05);
                // Jittered alike at every step: the box the frame is composed through evens that out.
                let offset = gwJitter(id.xy, u32(V.frame));
                var tau = 0.0;
                for (var i = 0u; i < FORM_LAYERS; i = i + 1u) {
                    // A flat layer by its column, which has no grain; towers and a front sampled up their height, so
                    // that their shadows are as long as they are tall.
                    if (L[i].enabled < 0.5 || u32(L[i].kind + 0.5) < 2u) {
                        tau = tau + formOver(i, at, sun, slant) * slant;
                        continue;
                    }
                    let deep = L[i].depth / f32(SHADOW_STEPS);
                    for (var k = 0u; k < SHADOW_STEPS; k = k + 1u) {
                        let altitude = L[i].base + (f32(k) + offset) * deep;
                        tau = tau + formAt(at + sun * altitude * slant, false, i).x * deep * slant;
                    }
                }
                let dark = LAB_SHADOW * smoothstep(0.0, 0.12, rise) * (1.0 - labPassed(tau, FORWARD)) * exp(-ground.x / F.fadeKm);
                through = through * (1.0 - dark);
            }
        }
        // What lies behind the layers is seen through the air under them: where that is shaded, less of the sky's or
        // the ground's own color arrives, and the shaded air's gray instead.
        let veiled = shaded * lit;
        luminance = luminance + through * veiled * murk;
        through = through * (1.0 - veiled);
    }
    textureStore(formOut, vec2i(id.xy), vec4f(luminance, through));
}

@compute @workgroup_size(8, 8, 1)
fn formCompose(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(formCanvas);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let sun = normalize(V.sun);
    // From above: every layer's column as a veil over the ground, north up, the observer in the middle.
    if (F.viewMode > 0.5) {
        let g = (vec2f(id.xy) - 0.5 * vec2f(size)) / f32(size.y) * F.mapKm * vec2f(1.0, -1.0) + V.flown;
        var color = vec3f(900.0, 1800.0, 3600.0);
        var shade = 0.0;
        if (formUnderFront()) {
            shade = formColumn(FORM_DEEP, g).b;
        }
        for (var i = 0u; i < FORM_LAYERS; i = i + 1u) {
            let l = L[i];
            if (l.enabled < 0.5) {
                continue;
            }
            let m = formColumn(i, g);
            let thinned = max(formCleared(g), select(0.0, SHADE_THINS * shade, i == 0u));
            let value = clamp((m.r - thinned) / max(1.0 - thinned, 1e-3), 0.0, 1.0);
            let span = formSpan(l.depth, value);
            let tau = l.extinction * l.depth * max(span.y - span.x, 0.0) * step(1e-3, value) + 3.0 * smoothstep(0.0, 0.12, m.g);
            let tint = mix(vec3f(17000.0), vec3f(7000.0, 7500.0, 8500.0), clamp(l.depth / 8.0, 0.0, 1.0));
            color = mix(color, tint, 1.0 - exp(-0.15 * tau));
        }
        let ring = abs(length(g - V.flown) - 0.012 * F.mapKm) < 0.003 * F.mapKm;
        textureStore(formCanvas, vec2i(id.xy), labDisplay(select(color, vec3f(20000.0, 6000.0, 2000.0), ring), V.exposure, V.headroom, V.curve));
        return;
    }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    // The clouds, marched at a share of the frame, from four taps two thirds of a texel of theirs out: a box three
    // texels wide, over which the march's jitter is even by design, so its grain goes.
    let apart = 2.0 / 3.0 / vec2f(textureDimensions(formClouds));
    var clouds = vec4f(0.0);
    for (var k = 0; k < 4; k = k + 1) {
        let corner = vec2f(f32(k & 1), f32(k >> 1)) * 2.0 - 1.0;
        clouds = clouds + 0.25 * textureSampleLevel(formClouds, formClamp, uv + corner * apart, 0.0);
    }
    let v = labRay(V, vec2f(id.xy) + 0.5, size);
    let ground = 1.0 + V.gridStrength * labGrid(V, vec2f(id.xy) + 0.5, size);
    textureStore(formCanvas, vec2i(id.xy), labDisplay(labSkyFrom(V, v, sun) * ground * clouds.a + clouds.rgb, V.exposure, V.headroom, V.curve));
}
