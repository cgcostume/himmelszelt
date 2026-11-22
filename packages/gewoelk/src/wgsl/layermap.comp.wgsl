// A layer's map for the layered model, baked when its shape changes and read by `layers.comp.wgsl` at every step of its
// march: heaps or a deck from the thesis' field, towers one per lattice cell, or a front drawn with its leading edge at
// the left and its back at the right. Red holds how tall a column of cloud is, as a share of the layer's depth, green
// the skirt a tall tower's anvil spreads over, blue how far a front shades what lies under it, and alpha how steep the
// columns' tops are, per km. One layer of the map array per layer of cloud. Requires `noise.wgsl`.

// What a map is made from: a change of any of it is a new bake.
struct GwLayerModel {
    // 0 heaps or a deck, 2 towers, 3 a front, and the layer of the map array this model fills.
    kind: u32,
    layer: u32,
    seed: u32,
    // Clouds across the map: lattice cells of the first octave.
    cells: u32,
    coverage: f32,
    sharpness: f32,
    // How deep the cells on top cut, 0 to 1.
    lumps: f32,
    // The map's third coordinate, which evolves its shape and loops every 8.
    evolution: f32,
    // How far the anvils reach downwind, in the map's cells.
    anvil: vec2f,
    // What the map spans over the ground, in km: a tile, or a front from its edge to its back and a tile along it.
    extent: vec2f,
    // The anvils' reach as it is set, in towers' spacings, whatever the wind: none at 0, and in full from 0.1 on.
    anvils: f32,
}

@group(0) @binding(0) var<uniform> gwLayerModel: GwLayerModel;
@group(0) @binding(1) var gwLayerMapOut: texture_storage_2d_array<rgba16float, write>;

// A front's wall of towers, as a share of the way from its leading edge to its back: where it stands and how wide.
const GW_LAYER_WALL_AT: f32 = 0.09;
const GW_LAYER_WALL_WIDE: f32 = 0.06;

fn gwLayerMapRandom(cell: vec2i, period: vec2i, seed: u32) -> vec4f {
    let h = gwLattice(vec3i(cell, 0), vec3i(period, 1), seed);
    return vec4f(gwUnit(h), gwUnit(gwHash(vec3u(h, 1u, 2u))), gwUnit(gwHash(vec3u(h, 3u, 4u))), gwUnit(gwHash(vec3u(h, 5u, 6u))));
}

// Pillows that touch, as the cells of a closed deck do: one per lattice cell, each a dome of its own height, with a
// crease where it meets its neighbors.
fn gwLayerMapPillows(p: vec2f, period: vec2i, seed: u32) -> f32 {
    let cell = vec2i(floor(p));
    let f = p - floor(p);
    // The nearest point's distance, the second nearest's, and the nearest's own height.
    var near = vec3f(8.0, 8.0, 0.0);
    for (var j = -1; j <= 1; j = j + 1) {
        for (var i = -1; i <= 1; i = i + 1) {
            let o = vec2i(i, j);
            let r = gwLayerMapRandom(cell + o, period, seed);
            let d = length(vec2f(o) + 0.5 + (r.xy - 0.5) * 0.9 - f);
            if (d < near.x) {
                near = vec3f(d, near.x, r.z);
            } else if (d < near.y) {
                near.y = d;
            }
        }
    }
    return (0.55 + 0.45 * near.z) * (1.0 - 0.5 * near.x * near.x) * mix(0.35, 1.0, smoothstep(0.0, 0.3, near.y - near.x));
}

// Towers, one per lattice cell where `share` of the cells have one: x the tallest tower's height at `p`, steep at its
// flanks and rounded on top, y the skirt of a tall one's anvil, an ellipse carried and stretched by `reach` cells, round
// without a wind and none without a reach set.
// With `column` 0 or more, only the cells of that column have towers: a row of them.
fn gwLayerMapTowers(p: vec2f, period: vec2i, share: f32, reach: vec2f, column: i32, seed: u32) -> vec2f {
    let cell = vec2i(floor(p));
    let f = p - floor(p);
    let far = length(reach);
    let along = select(vec2f(1.0, 0.0), reach / max(far, 1e-4), far > 1e-4);
    var best = vec2f(0.0);
    for (var j = -2; j <= 2; j = j + 1) {
        for (var i = -2; i <= 2; i = i + 1) {
            let o = vec2i(i, j);
            let r = gwLayerMapRandom(cell + o, period, seed);
            if (r.w > share || (column >= 0 && cell.x + i != column)) {
                continue;
            }
            let rel = f - (vec2f(o) + 0.5 + (r.xy - 0.5) * 0.8);
            let tall = 0.45 + 0.55 * r.z;
            let q = length(rel) / (0.3 + 0.14 * r.z);
            let body = sqrt(max(1.0 - q * q * q * q, 0.0)) * (1.0 - 0.25 * q * q) * tall;
            let off = rel - reach * 0.5;
            let e = vec2f(dot(off, along) / (0.5 + 0.6 * far), dot(off, vec2f(-along.y, along.x)) / 0.5);
            let skirt = max(1.0 - dot(e, e), 0.0) * smoothstep(0.8, 0.95, tall) * smoothstep(0.0, 0.1, gwLayerModel.anvils);
            best = max(best, vec2f(body, skirt));
        }
    }
    return best;
}

// The map at `uv`: x a column's value, y the skirt of an anvil, z how far a front shades what lies under it.
fn gwLayerMapValue(uv: vec2f) -> vec3f {
    let seed = gwLayerModel.seed;
    let cells = i32(gwLayerModel.cells);
    let coverage = gwLayerModel.coverage;
    let lumps = gwLayerModel.lumps;
    let evolution = gwLayerModel.evolution;
    let p = uv * f32(cells);
    let field = gwFbm(vec3f(p, evolution), vec3i(cells, cells, 8), 5u, seed);
    let spread = clamp((field - 0.5) * 2.4 + 0.5, 0.0, 1.0);
    // Two more fields pull the lattices out of true, so that no outline is a circle.
    let twice = vec3i(2 * cells, 2 * cells, 8);
    let pull = vec2f(gwFbm(vec3f(p * 2.0, evolution), twice, 3u, seed + 31u), gwFbm(vec3f(p * 2.0, evolution), twice, 3u, seed + 37u)) - 0.5;
    let kind = gwLayerModel.kind;
    let reach = gwLayerModel.anvil;
    if (kind <= 1u) {
        // The thesis' map: what the coverage leaves of the field, its edges hardened by the sharpness.
        var value = pow(clamp((spread - (1.0 - coverage)) / max(coverage, 1e-3), 0.0, 1.0), 1.0 - 0.8 * gwLayerModel.sharpness);
        // Rounded on top: a column grows fast near a cloud's edge and levels off towards its middle.
        value = 1.0 - (1.0 - value) * (1.0 - value);
        // Cells on top, of two sizes: the turrets of a heap, the pillows of a deck.
        let q = p + pull * 0.6;
        let tops = gwLayerMapPillows(q * 2.0, vec2i(2 * cells), seed + 7u) * (0.75 + 0.25 * gwLayerMapPillows(q * 5.0, vec2i(5 * cells), seed + 8u));
        return vec3f(value * (1.0 - lumps * (1.0 - tops)), 0.0, 0.0);
    }
    // A front, x from its leading edge to its back, y along it, its line swaying with the field: its towers are those
    // of one column of twelve, which the wall stands on.
    let x = uv.x + (field - 0.5) * 0.12;
    var at = p;
    var period = vec2i(cells);
    if (kind == 3u) {
        at = vec2f((x - GW_LAYER_WALL_AT) * 12.0 + 1.5, uv.y * f32(cells));
        period = vec2i(12, cells);
    }
    let q = at + pull * 0.35;
    let towers = gwLayerMapTowers(q, period, select(coverage, 0.9, kind == 3u), reach, select(-1, 1, kind == 3u), seed + 9u);
    // Turrets on a tower, of two sizes, the taller ones towards its middle.
    let turrets = gwLayerMapPillows(q * 4.0, 4 * period, seed + 12u) * (0.65 + 0.35 * gwLayerMapPillows(q * 10.0, 10 * period, seed + 13u));
    let tower = towers.x * (0.8 + 0.4 * spread) * (1.0 - 0.45 * lumps * (1.0 - turrets));
    // An anvil is drawn out into fibers along the wind, a field averaged along it: they thin it, and fray its rim.
    let far = length(reach);
    var streaks = 0.0;
    for (var k = -3; k <= 3; k = k + 1) {
        let along = at + reach / max(far, 1e-4) * f32(k) * 0.12;
        streaks = streaks + gwFbm(vec3f(along * 10.0, evolution), vec3i(10 * period, 8), 3u, seed + 41u) / 7.0;
    }
    let fibers = clamp((streaks - 0.35) * 4.0, 0.0, 1.0);
    let frayed = clamp(towers.y * (0.5 + 0.5 * fibers) - 0.3 * (1.0 - fibers) * (1.0 - towers.y), 0.0, 1.0);
    if (kind == 2u) {
        return vec3f(clamp(tower, 0.0, 1.0), frayed, 0.0);
    }
    // A wall of towers on a ridge behind the edge, and a shield of layered cloud thinning out to the rear.
    let lead = smoothstep(0.0, 0.05, x);
    let across = (x - GW_LAYER_WALL_AT) / GW_LAYER_WALL_WIDE;
    let wall = sqrt(max(1.0 - across * across * across * across, 0.0));
    let shield = lead * smoothstep(0.98, 0.5, x);
    let layered = shield * (0.3 + 0.25 * spread) * (0.4 + 0.6 * coverage);
    let value = max(layered, wall * max(0.35 + 0.2 * spread, tower));
    return vec3f(clamp(value, 0.0, 1.0), frayed, shield);
}

@compute @workgroup_size(8, 8, 1)
fn gwLayerMap(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(gwLayerMapOut).xy;
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    let texel = 1.0 / vec2f(size);
    let here = gwLayerMapValue(uv);
    // How steep the columns' tops are, per km: the march turns a height over a top into a distance from it.
    let km = gwLayerModel.extent * texel;
    let rise = vec2f(gwLayerMapValue(uv + vec2f(texel.x, 0.0)).x, gwLayerMapValue(uv + vec2f(0.0, texel.y)).x) - here.x;
    textureStore(gwLayerMapOut, vec2i(id.xy), i32(gwLayerModel.layer), vec4f(here, length(rise / km)));
}
