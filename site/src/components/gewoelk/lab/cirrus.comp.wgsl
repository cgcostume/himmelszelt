// The cirrus research figure: a sheet of high cloud as a map baked once, read once per pixel. The map is made in the
// wind's frame, x along the wind and y across, one tile of `tile` km: puffs in rows, cut into lanes by ripples, a veil
// with striations, ribs across a band, and trails combed out of all of it along the wind. Red holds the puffs as a
// height, not a density: the sky eats billows out of it and softens what is left, pixel by pixel, so both move for
// free. Green is the veil, alpha the billows' noise, and blue a broad field, read again at a larger scale and another
// angle for the patches and bands the sheet comes in, so the tile's repetition hides. Requires the research prelude,
// gewoelk's `noise.wgsl` and the `CirrusLab` struct.

@group(0) @binding(0) var<uniform> C: CirrusLab;
@group(0) @binding(1) var labOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var labIn: texture_2d<f32>;
@group(0) @binding(3) var labSampler: sampler;
@group(0) @binding(4) var<uniform> V: LabView;
@group(0) @binding(5) var labMap: texture_2d<f32>;
@group(1) @binding(0) var labCanvas: texture_storage_2d<rgba16float, write>;
@group(1) @binding(1) var labLayer: texture_storage_2d<rgba16float, write>;

const TAU: f32 = 6.283185307179586;
// The largest lumps of the billows' noise across the tile.
const BILLOW_CELLS: i32 = 32;
// How many levels of the map up the softest puffs are read from.
const SOFT_LEVELS: f32 = 3.5;
// The distance at which the air has hidden the ground's shadows to 1/e, in km, and the angle the sun's disc spans.
const GROUND_AIR_KM: f32 = 90.0;
const SUN_ANGLE: f32 = 0.0093;
// A puff's thickness over its width.
const LUMP: f32 = 0.35;

// Gradient noise that tiles over the map and loops with the evolution, every 8 of it.
fn cirrusNoise(p: vec2f, period: vec2i, seed: u32) -> f32 {
    return gwPerlin(vec3f(p, C.phase), vec3i(period, 8), seed);
}

// Whole lattice cells across the tile for features `km` wide.
fn cirrusCells(km: f32) -> i32 {
    return max(1, i32(round(C.tile / max(km, 1e-3))));
}

@compute @workgroup_size(8, 8, 1)
fn cirrusBake(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(labOut);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let seed = u32(C.seed);
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    // Rows bend: the point is moved by a slow field before anything is read at it, in tiles.
    let bend = vec2f(cirrusNoise(uv * 5.0, vec2i(5), seed + 1u), cirrusNoise(uv * 5.0, vec2i(5), seed + 2u));
    let wobble = vec2f(cirrusNoise(uv * 17.0, vec2i(17), seed + 3u), cirrusNoise(uv * 17.0, vec2i(17), seed + 4u));
    let q = uv + (C.curve * 1.6 * bend + (1.0 - C.rows) * 0.35 * wobble) * C.rippleKm / C.tile;

    // Puffs: bumps in a lattice bent out of shape at their own scale, their edges eaten into lumps, then a fine grain.
    let across = cirrusCells(C.cellKm);
    let along = cirrusCells(C.cellKm * C.elongation);
    let lattice = vec2i(along, across);
    let at = q * vec2f(lattice);
    let coarse = max(vec2i(vec2f(lattice) * 0.7 + 0.5), vec2i(1));
    let shove = vec2f(cirrusNoise(q * vec2f(coarse), coarse, seed + 5u), cirrusNoise(q * vec2f(coarse), coarse, seed + 6u));
    let shaped = at + (1.0 - 0.6 * C.rows) * 0.55 * shove;
    let mounds = gwBumps(shaped, lattice, 1.0 - 0.7 * C.rows, C.phase, seed + 10u);
    let lumps = gwLumps(shaped, lattice, C.phase, seed + 11u);
    let eaten = (1.0 - lumps) * C.grain;
    var puffs = clamp((mounds - eaten) / max(1.0 - eaten, 0.05), 0.0, 1.0);
    let fine = gwFbm(vec3f(uv * f32(across * 6), C.phase), vec3i(vec2i(across * 6), 8), 3u, seed + 14u);
    // Lower at the rim, where the fine grain frays it, and higher lump by lump towards the middle.
    puffs = clamp(puffs * (1.0 - 0.6 * C.grain * fine), 0.0, 1.0) * mix(1.0, 0.55 + 0.6 * lumps, C.grain);

    // Ripples: lanes of sky across the wind, between crests the puffs stay on.
    let crests = f32(cirrusCells(C.rippleKm));
    let wave = 0.5 + 0.5 * cos(TAU * q.x * crests);
    puffs = puffs * mix(1.0, smoothstep(0.08, 0.5, wave), C.ripples);

    // The veil: a smooth field, drawn into striations along the wind.
    let strands = cirrusCells(0.5);
    let lengths = max(1, i32(round(f32(strands) / max(C.stretch, 1.0))));
    let haze = gwFbm(vec3f(q * 6.0, C.phase), vec3i(6, 6, 8), 3u, seed + 20u);
    let fibers = gwFbm(vec3f(q * vec2f(f32(lengths), f32(strands)), C.phase), vec3i(lengths, strands, 8), 4u, seed + 21u);
    var veil = clamp(mix(haze, haze * (0.25 + 1.5 * fibers), C.striation) * 2.2 - 0.7, 0.0, 1.0);

    // Ribs: billows across a band, each with a sharp front and a tail that thins out behind it.
    let ribs = f32(cirrusCells(C.ribKm));
    let slow = cirrusNoise(uv * 3.0, vec2i(3), seed + 30u);
    let r = fract((q.x + 0.25 * slow * C.ribKm / C.tile) * ribs);
    let rib = smoothstep(0.0, 0.14, r) * pow(1.0 - r, 1.6) * 2.4;
    veil = veil * mix(1.0, rib, C.ribs);
    puffs = puffs * mix(1.0, clamp(rib, 0.0, 1.0), C.ribs * 0.6);

    // The broad field, for the patches: its own slow octaves.
    let broad = gwFbm(vec3f(uv * 4.0, C.phase * 0.5), vec3i(4, 4, 8), 4u, seed + 40u);
    // The billows' noise: 1 between lumps of three sizes, the largest a sixteenth of the tile, 0 on top of them.
    let billows = 1.0 - gwLumps(uv * f32(BILLOW_CELLS / 2), vec2i(BILLOW_CELLS / 2), C.phase, seed + 60u);
    textureStore(labOut, vec2i(id.xy), vec4f(clamp(C.cells * puffs, 0.0, 1.0), clamp(C.veil * veil, 0.0, 1.0), broad, billows));
}

// One step of combing: what lies upwind, fainter, wherever it is more than what is here. Step after step the puffs
// grow trails behind them, straight along the wind, or bent a little by a slow field.
@compute @workgroup_size(8, 8, 1)
fn cirrusComb(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(labOut);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    let here = textureSampleLevel(labIn, labSampler, uv, 0.0);
    let turn = C.bend * 1.2 * cirrusNoise(uv * 7.0, vec2i(7), u32(C.seed) + 50u);
    let upwind = uv + vec2f(cos(turn), sin(turn)) * C.combStep / f32(size.x);
    let trail = textureSampleLevel(labIn, labSampler, upwind, 0.0).rg * mix(0.8, 0.985, C.streaks);
    textureStore(labOut, vec2i(id.xy), vec4f(max(here.rg, trail), here.ba));
}

// The next level of the map: each texel the mean of the four under it.
@compute @workgroup_size(8, 8, 1)
fn cirrusMip(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(labOut);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let at = vec2i(id.xy) * 2;
    let sum = textureLoad(labIn, at, 0) + textureLoad(labIn, at + vec2i(1, 0), 0) + textureLoad(labIn, at + vec2i(0, 1), 0) + textureLoad(labIn, at + vec2i(1, 1), 0);
    textureStore(labOut, vec2i(id.xy), sum * 0.25);
}

// The sheet's density over a point of the ground `g`, km east and north of the observer, for a footprint of `lod`
// levels of the map: the tile read in the wind's frame, thinned to the patches of the broad field.
fn cirrusDensity(g: vec2f, lod: f32) -> f32 {
    let along = vec2f(sin(C.windTo), cos(C.windTo));
    let w = vec2f(dot(g, along), dot(g, vec2f(along.y, -along.x))) - vec2f(C.drift, 0.0);
    let detail = textureSampleLevel(labMap, labSampler, w / C.tile, lod);
    // The bands lie at their own angle to the wind, stretched along it.
    let c = cos(C.bandAngle);
    let s = sin(C.bandAngle);
    let b = vec2f((c * w.x + s * w.y) / C.bandStretch, -s * w.x + c * w.y) / (4.0 * C.patchKm);
    let field = textureSampleLevel(labMap, labSampler, b, max(lod - log2(4.0 * C.patchKm / C.tile), 0.0));
    let broad = clamp((field.b - 0.28) / 0.44, 0.0, 1.0);
    let soft = 0.02 + 0.3 * C.edge;
    let stays = smoothstep(1.0 - C.coverage - soft, 1.0 - C.coverage + soft, broad);
    // Softness: the puffs read from a coarser level of the map, a blur that spreads each one past its rim.
    let blurred = textureSampleLevel(labMap, labSampler, w / C.tile, lod + C.soft * SOFT_LEVELS).r * (1.0 + 0.8 * C.soft);
    // Towards a patch's edge the threshold rises: small puffs go first, large ones shrink, and the veil thins.
    let left = clamp((vec2f(blurred, detail.g) - (1.0 - stays)) / max(stays, 0.05), vec2f(0.0), vec2f(1.0)) * sqrt(stays);
    // Billows: the noise read twice, at two sizes and creeping two ways, so its lumps change as they go. It eats into
    // the puffs from their rims, as the detail noise erodes a volume's profile, and gives the blur its lumps back.
    let size = f32(BILLOW_CELLS) * C.billowKm;
    let fine = max(lod + log2(C.tile / size), 0.0);
    let creep = vec2f(0.8, 0.6) * C.billowShift;
    let one = textureSampleLevel(labMap, labSampler, (w + creep) / size, fine).a;
    let two = textureSampleLevel(labMap, labSampler, (vec2f(w.y, -w.x) + creep) / (size * 1.62), max(fine - 0.7, 0.0)).a;
    // The height becomes a density, level at the rim and in the middle, and the billows thin it lump by lump, the
    // more the nearer the rim: no threshold, so an edge stays as soft as the blur made it.
    let whole = left.x * left.x * (3.0 - 2.0 * left.x);
    let dense = whole * clamp(1.0 - 1.8 * C.billows * (0.6 * one + 0.4 * two) * (1.0 - whole), 0.0, 1.0);
    return clamp(dense + left.y * (1.0 - 0.6 * dense), 0.0, 1.0);
}

// How much of the sheet's coverage is left over the ground point `g`: less towards the clearing, as of the clouds under it.
fn cirrusKept(g: vec2f) -> f32 {
    if (C.clearing <= 0.0) {
        return 1.0;
    }
    return 1.0 - smoothstep(min(C.clearFrom, 0.99 * C.clearing), C.clearing, length(g - V.flown));
}

// How much of its light the ground at `at` loses to the sheet's shadow, seen along `v` from `far` km: the sheet read
// where the way to the sun crosses it, as blurred as the pixel's footprint and the sun's disc make it, for what a layer
// that scatters forwards lets through of the light on it.
fn cirrusShadow(at: vec3f, v: vec3f, far: f32) -> f32 {
    let sun = normalize(V.sun);
    let up = normalize(at);
    let rise = dot(sun, up);
    if (rise <= 0.0) {
        return 0.0;
    }
    let reach = labSphere(at, sun, V.planetRadius + C.altitude).y;
    let p = at + sun * reach;
    let g = labGround(normalize(p)) * (V.planetRadius + C.altitude) + V.flown;
    let wide = max(far * V.pixelAngle / max(abs(dot(v, up)), 0.03), reach * SUN_ANGLE);
    let tau = C.opticalDepth * cirrusDensity(g, max(log2(wide * C.mapSize / C.tile), 0.0)) * cirrusKept(g);
    let passed = labPassed(tau / max(rise, 0.05), C.forwardG);
    return LAB_SHADOW * smoothstep(0.0, 0.12, rise) * (1.0 - passed) * exp(-far / GROUND_AIR_KM);
}

// The sheet along the ray `v` through a pixel: its light in cd/m² as it reaches the eye, and what it lets through of
// what lies behind, 1 where there is none, less where its shadow lies on the ground.
fn cirrusSheet(v: vec3f) -> vec4f {
    let sun = normalize(V.sun);
    let o = vec3f(0.0, 0.0, V.planetRadius + V.observer);
    let shell = labSphere(o, v, V.planetRadius + C.altitude);
    let below = V.observer < C.altitude;
    let t = select(shell.x, shell.y, below);
    let ground = labSphere(o, v, V.planetRadius);
    // Where the ray ends on the ground, the sheet's shadow there takes from what the ground sends.
    var lit = 1.0;
    if (ground.x > 0.0) {
        lit = 1.0 - cirrusShadow(o + v * ground.x, v, ground.x);
    }
    if (t <= 0.0 || (ground.x > 0.0 && ground.x < t)) {
        return vec4f(0.0, 0.0, 0.0, lit);
    }
    let p = o + v * t;
    let up = normalize(p);
    // Where on the ground the point lies over, by the arc from the observer.
    let g = labGround(up) * (V.planetRadius + C.altitude) + V.flown;
    let mu = max(abs(dot(v, up)), 0.03);
    let texel = C.tile / C.mapSize;
    let lod = max(log2(t * V.pixelAngle / texel) + 0.5 * log2(1.0 / mu), 0.0);
    let density = cirrusDensity(g, lod) * cirrusKept(g);
    let tau = C.opticalDepth * density;
    let through = exp(-tau / mu);
    let sine = dot(sun, up);
    let mu0 = max(sine, 0.03);
    // A puff is a lump more than a slab: a low sun's light crosses no more of it than its width.
    let across = max(mu0, LUMP * sqrt(max(1.0 - sine * sine, 0.0)));
    let light = labLight(V, sine, C.altitude);
    // The cloud between the point and the sun, a puff's width on: its sunward neighbors shade it.
    let reach = min(sqrt(max(1.0 - mu0 * mu0, 0.0)) / mu0, 4.0) * 0.15;
    let toSun = normalize(sun.xy + vec2f(1e-9));
    let sunward = cirrusDensity(g + toSun * reach, lod + 1.0);
    // And lump by lump: brighter where the cloud falls away towards the sun, darker behind a lump. What the neighbors
    // let through is scattered light too, as under the sheet: a high cloud is thin, and has next to no shading.
    let slope = density - cirrusDensity(g + toSun * 0.05, lod);
    let shade = labPassed(C.relief * C.opticalDepth * sunward * min(reach / 0.15, 2.0), C.forwardG) * clamp(1.0 + C.relief * 0.9 * slope, 0.45, 1.7);
    // Light scattered once on its way through a thin layer, lit from above and seen from below or above.
    let phase = 0.78 * gwHenyeyGreenstein(dot(v, sun), C.forwardG) + 0.22 * gwHenyeyGreenstein(dot(v, sun), -0.2);
    let sameSide = (dot(v, up) > 0.0) == below;
    var once = tau / mu * through;
    if (abs(across - mu) > 1e-3) {
        once = across / (across - mu) * (exp(-tau / across) - through);
    }
    if (!sameSide) {
        once = across / (across + mu) * (1.0 - exp(-tau / across - tau / mu));
    }
    // And many times: what a thick puff still lets through, or sends back, as diffuse light.
    let passed = labPassed(tau, C.forwardG);
    let many = mu0 / LAB_PI * select(1.0 - passed, max(passed - exp(-tau / across), 0.0), sameSide);
    let sky = 0.6 * labAmbient(V, labSky(vec3f(0.0, 0.0, 1.0), sun)) + 0.4 * labAmbient(V, labSky(vec3f(v.xy, 0.05), sun));
    let cloud = light * shade * (phase * once + many) + sky * (1.0 - through) * 0.9;
    // The air in between takes the far sheet into the sky's color.
    let near = exp(-t / 220.0);
    return vec4f(cloud * near, (1.0 - (1.0 - through) * near) * lit);
}

@compute @workgroup_size(8, 8, 1)
fn cirrusSky(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(labCanvas);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let sun = normalize(V.sun);
    // The map itself, flat, a tile as tall as the view: what the bake made, and that it tiles.
    if (C.viewMode > 0.5) {
        let p = (vec2f(id.xy) - 0.5 * vec2f(size)) / f32(size.y) * C.tile;
        let d = cirrusDensity(vec2f(p.x, -p.y) + V.flown, log2(max(C.tile / f32(size.y) / (C.tile / C.mapSize), 1.0)));
        textureStore(labCanvas, vec2i(id.xy), labDisplay(mix(vec3f(700.0, 1700.0, 4600.0), vec3f(16000.0), d), V.exposure, V.headroom, V.curve));
        return;
    }
    let v = labRay(V, vec2f(id.xy) + 0.5, size);
    let sky = labSkyFrom(V, v, sun) * (1.0 + V.gridStrength * labGrid(V, vec2f(id.xy) + 0.5, size));
    let sheet = cirrusSheet(v);
    textureStore(labCanvas, vec2i(id.xy), labDisplay(sky * sheet.a + sheet.rgb, V.exposure, V.headroom, V.curve));
}

// The sheet alone, for a figure that composes it over a sky of its own.
@compute @workgroup_size(8, 8, 1)
fn cirrusLayer(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(labLayer);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    textureStore(labLayer, vec2i(id.xy), cirrusSheet(labRay(V, vec2f(id.xy) + 0.5, size)));
}
