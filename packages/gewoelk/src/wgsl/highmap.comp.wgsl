// The high sheet's map, baked when its shape changes and read once per pixel by `highsheet.comp.wgsl`. It is made in the
// wind's frame, x along the wind and y across, one tile of `tile` km: puffs in rows, cut into lanes by ripples, a veil
// with striations, ribs across a band, and trails combed out of all of it along the wind. Red holds the puffs as a
// height, not a density: the sheet eats billows out of it and softens what is left, pixel by pixel, so both move for
// free. Green is the veil, alpha the billows' noise, and blue a broad field, read again at a larger scale and another
// angle for the patches and bands the sheet comes in, so the tile's repetition hides. Requires `wgsl.noise`.

// What the map is made from: a change of any of it is a new bake. Sizes in km.
struct GwHighModel {
    // One tile of the map, and the map's third coordinate, which evolves its shape.
    tile: f32,
    evolution: f32,
    seed: u32,
    // How far upwind a step of combing reaches, in texels.
    combStep: f32,
    // How much of the sheet is puffs, a puff's size across the wind, how many times as long along it, how regular the
    // puffs stand, 0 scattered to 1 in rows, and how far lumps and a fine grain break each.
    puffs: f32,
    puffSize: f32,
    elongation: f32,
    rows: f32,
    grain: f32,
    // How far lanes of sky across the wind cut the puffs into rows, from crest to crest, and how far the rows bend.
    ripples: f32,
    rippleSize: f32,
    curve: f32,
    // How far billows across a band break it into ribs, and their spacing.
    ribs: f32,
    ribSize: f32,
    // How much of the sheet is a veil, how far it is drawn into lines along the wind, and how long for their width.
    veil: f32,
    striation: f32,
    stretch: f32,
    // How slowly a combed trail fades, and how far it bends off the wind.
    trails: f32,
    trailBend: f32,
    pad: f32,
}

@group(0) @binding(0) var<uniform> gwHighModel: GwHighModel;
@group(0) @binding(1) var gwHighMapOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var gwHighMapIn: texture_2d<f32>;
@group(0) @binding(3) var gwHighMapSampler: sampler;

const GW_HIGH_TAU: f32 = 6.283185307179586;
// Lattice cells of the billows' noise across the tile: its largest lumps are half a cell.
const GW_HIGH_MAP_BILLOWS: i32 = 16;
// How far from a crack between two puffs each has risen to its full height, in cells.
const GW_HIGH_MAP_CRACK: f32 = 0.6;

// Gradient noise that tiles over the map and loops with the evolution, every 8 of it.
fn gwHighMapNoise(p: vec2f, period: vec2i, seed: u32) -> f32 {
    return gwPerlin(vec3f(p, gwHighModel.evolution), vec3i(period, 8), seed);
}

// Cells packed side by side: one per lattice cell about a center off the middle by `jitter` of the cell, each as tall
// as its own weight, which swells and fades with the evolution, and down to 0 along the cracks between neighbors. At
// `p`, in cells.
fn gwHighMapPacked(p: vec2f, period: vec2i, jitter: f32, seed: u32) -> f32 {
    let cell = vec2i(floor(p));
    let f = p - floor(p);
    var near = vec2f(8.0);
    var weight = 1.0;
    for (var j = -1; j <= 1; j = j + 1) {
        for (var i = -1; i <= 1; i = i + 1) {
            let o = vec2i(i, j);
            let r = gwCell2(cell + o, period, seed).xyz;
            let life = 0.5 + 0.5 * sin(GW_HIGH_TAU * (gwHighModel.evolution / 8.0 * (1.0 + floor(r.z * 3.0)) + r.x));
            let d = length(f - (vec2f(o) + 0.5 + (r.xy - 0.5) * jitter));
            if (d < near.x) {
                near = vec2f(d, near.x);
                weight = mix(0.7, 1.0, r.z) * (0.75 + 0.25 * life);
            } else if (d < near.y) {
                near.y = d;
            }
        }
    }
    let inside = 1.0 - clamp((near.y - near.x) / GW_HIGH_MAP_CRACK, 0.0, 1.0);
    return (1.0 - inside * inside) * weight;
}

// Whole lattice cells across the tile for features `km` wide.
fn gwHighMapCells(km: f32) -> i32 {
    return max(1, i32(round(gwHighModel.tile / max(km, 1e-3))));
}

@compute @workgroup_size(8, 8, 1)
fn gwHighMapBake(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(gwHighMapOut);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let seed = gwHighModel.seed;
    let evolution = gwHighModel.evolution;
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    // Rows bend: the point is moved by a slow field before anything is read at it, in tiles.
    let bend = vec2f(gwHighMapNoise(uv * 5.0, vec2i(5), seed + 1u), gwHighMapNoise(uv * 5.0, vec2i(5), seed + 2u));
    let wobble = vec2f(gwHighMapNoise(uv * 17.0, vec2i(17), seed + 3u), gwHighMapNoise(uv * 17.0, vec2i(17), seed + 4u));
    let q = uv + (gwHighModel.curve * 1.6 * bend + (1.0 - gwHighModel.rows) * 0.35 * wobble) * gwHighModel.rippleSize / gwHighModel.tile;

    // Puffs: cells packed in a lattice bent out of shape at their own scale, their edges eaten into lumps, then a fine grain.
    let across = gwHighMapCells(gwHighModel.puffSize);
    let along = gwHighMapCells(gwHighModel.puffSize * gwHighModel.elongation);
    let lattice = vec2i(along, across);
    let at = q * vec2f(lattice);
    let coarse = max(vec2i(vec2f(lattice) * 0.7 + 0.5), vec2i(1));
    let shove = vec2f(gwHighMapNoise(q * vec2f(coarse), coarse, seed + 5u), gwHighMapNoise(q * vec2f(coarse), coarse, seed + 6u));
    let shaped = at + (1.0 - 0.6 * gwHighModel.rows) * 0.55 * shove;
    let mounds = gwHighMapPacked(shaped, lattice, 1.0 - 0.4 * gwHighModel.rows, seed + 10u);
    let lumps = gwLumps(shaped, lattice, gwHighModel.evolution, seed + 11u);
    let eaten = 0.5 * (1.0 - lumps) * gwHighModel.grain;
    var puffs = clamp((mounds - eaten) / max(1.0 - eaten, 0.05), 0.0, 1.0);
    let fine = gwFbm(vec3f(uv * f32(across * 6), evolution), vec3i(vec2i(across * 6), 8), 3u, seed + 14u);
    // Lower at the rim, where the fine grain frays it, and higher lump by lump towards the middle.
    puffs = clamp(puffs * (1.0 - 0.4 * gwHighModel.grain * fine), 0.0, 1.0) * mix(1.0, 0.75 + 0.4 * lumps, gwHighModel.grain);

    // Ripples: lanes of sky across the wind, between crests the puffs stay on.
    let crests = f32(gwHighMapCells(gwHighModel.rippleSize));
    let wave = 0.5 + 0.5 * cos(GW_HIGH_TAU * q.x * crests);
    puffs = puffs * mix(1.0, smoothstep(0.0, 0.35, wave), gwHighModel.ripples);

    // The veil: a smooth field, drawn into striations along the wind.
    let strands = gwHighMapCells(0.5);
    let lengths = max(1, i32(round(f32(strands) / max(gwHighModel.stretch, 1.0))));
    let haze = gwFbm(vec3f(q * 6.0, evolution), vec3i(6, 6, 8), 3u, seed + 20u);
    let fibers = gwFbm(vec3f(q * vec2f(f32(lengths), f32(strands)), evolution), vec3i(lengths, strands, 8), 4u, seed + 21u);
    var veil = clamp(mix(haze, haze * (0.25 + 1.5 * fibers), gwHighModel.striation) * 2.2 - 0.7, 0.0, 1.0);

    // Ribs: billows across a band, each with a sharp front and a tail that thins out behind it.
    let ribs = f32(gwHighMapCells(gwHighModel.ribSize));
    let slow = gwHighMapNoise(uv * 3.0, vec2i(3), seed + 30u);
    let r = fract((q.x + 0.25 * slow * gwHighModel.ribSize / gwHighModel.tile) * ribs);
    let rib = smoothstep(0.0, 0.14, r) * pow(1.0 - r, 1.6) * 2.4;
    veil = veil * mix(1.0, rib, gwHighModel.ribs);
    puffs = puffs * mix(1.0, clamp(rib, 0.0, 1.0), gwHighModel.ribs * 0.6);

    // The broad field, for the patches: its own slow octaves.
    let broad = gwFbm(vec3f(uv * 4.0, evolution * 0.5), vec3i(4, 4, 8), 4u, seed + 40u);
    // The billows' noise: 1 between lumps of three sizes, the largest a sixteenth of the tile, 0 on top of them.
    let billows = 1.0 - gwLumps(uv * f32(GW_HIGH_MAP_BILLOWS), vec2i(GW_HIGH_MAP_BILLOWS), gwHighModel.evolution, seed + 60u);
    textureStore(gwHighMapOut, vec2i(id.xy), vec4f(clamp(gwHighModel.puffs * puffs, 0.0, 1.0), clamp(gwHighModel.veil * veil, 0.0, 1.0), broad, billows));
}

// One step of combing: what lies upwind, fainter, wherever it is more than what is here. Step after step the puffs
// grow trails behind them, straight along the wind, or bent a little by a slow field.
@compute @workgroup_size(8, 8, 1)
fn gwHighMapComb(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(gwHighMapOut);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    let here = textureSampleLevel(gwHighMapIn, gwHighMapSampler, uv, 0.0);
    let turn = gwHighModel.trailBend * 1.2 * gwHighMapNoise(uv * 7.0, vec2i(7), gwHighModel.seed + 50u);
    let upwind = uv + vec2f(cos(turn), sin(turn)) * gwHighModel.combStep / f32(size.x);
    let trail = textureSampleLevel(gwHighMapIn, gwHighMapSampler, upwind, 0.0).rg * mix(0.8, 0.985, gwHighModel.trails);
    textureStore(gwHighMapOut, vec2i(id.xy), vec4f(max(here.rg, trail), here.ba));
}

// The next level of the map: each texel the mean of the four under it.
@compute @workgroup_size(8, 8, 1)
fn gwHighMapMip(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(gwHighMapOut);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let at = vec2i(id.xy) * 2;
    let sum = textureLoad(gwHighMapIn, at, 0) + textureLoad(gwHighMapIn, at + vec2i(1, 0), 0) + textureLoad(gwHighMapIn, at + vec2i(0, 1), 0) + textureLoad(gwHighMapIn, at + vec2i(1, 1), 0);
    textureStore(gwHighMapOut, vec2i(id.xy), sum * 0.25);
}
