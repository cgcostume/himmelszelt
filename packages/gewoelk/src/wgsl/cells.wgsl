// The cell patterns the layers' and the high sheet's maps are drawn from, and the jitter a march starts its rays by.
// Requires reisszeug's `hash.wgsl` and `noise.wgsl`, which `wgsl.noise` holds with this, under the prefix `gw`. Every
// identifier is prefixed `gw`.

// Bumps: one per lattice cell, its center off the middle by `jitter` of the cell, its size its own, both swelling and
// fading as `evolution` runs through 8, neighbors melting into one another. At `p`, in cells: 0 outside all of them.
fn gwBumps(p: vec2f, period: vec2i, jitter: f32, evolution: f32, seed: u32) -> f32 {
    let cell = vec2i(floor(p));
    let f = p - floor(p);
    var sum = 0.0;
    for (var j = -1; j <= 1; j = j + 1) {
        for (var i = -1; i <= 1; i = i + 1) {
            let o = vec2i(i, j);
            let r = gwCell2(cell + o, period, seed).xyz;
            let life = 0.5 + 0.5 * sin(6.283185307179586 * (evolution / 8.0 * (1.0 + floor(r.z * 3.0)) + r.x));
            let center = vec2f(o) + 0.5 + (r.xy - 0.5) * jitter;
            let radius = mix(0.45, 0.95, r.z * r.z) * (0.65 + 0.35 * life);
            let d = length(f - center) / radius;
            // A smooth maximum: where two bumps meet they join instead of creasing.
            sum = sum + pow(max(1.0 - d * d, 0.0), 6.0);
        }
    }
    return pow(sum, 1.0 / 6.0);
}

// Lumps: bumps of three sizes, each half the last, for a puff's cauliflower surface.
fn gwLumps(p: vec2f, period: vec2i, evolution: f32, seed: u32) -> f32 {
    return 0.55 * gwBumps(p * 2.0, period * 2, 1.0, evolution, seed) +
        0.3 * gwBumps(p * 4.0, period * 4, 1.0, evolution, seed + 1u) +
        0.15 * gwBumps(p * 8.0, period * 8, 1.0, evolution, seed + 2u);
}

// Pillows that touch, as the cells of a closed deck do: one per lattice cell, each a dome of its own height, with a
// crease where it meets its neighbors.
fn gwPillows(p: vec2f, period: vec2i, seed: u32) -> f32 {
    let cell = vec2i(floor(p));
    let f = p - floor(p);
    // The nearest point's distance, the second nearest's, and the nearest's own height.
    var near = vec3f(8.0, 8.0, 0.0);
    for (var j = -1; j <= 1; j = j + 1) {
        for (var i = -1; i <= 1; i = i + 1) {
            let o = vec2i(i, j);
            let r = gwCell2(cell + o, period, seed);
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
// flanks and rounded on top, y the skirt of a tall one's anvil, an ellipse carried and stretched by `reach` cells,
// round without a wind. With `column` 0 or more, only the cells of that column have towers: a row of them.
fn gwTowers(p: vec2f, period: vec2i, share: f32, reach: vec2f, column: i32, seed: u32) -> vec2f {
    let cell = vec2i(floor(p));
    let f = p - floor(p);
    let far = length(reach);
    let along = select(vec2f(1.0, 0.0), reach / max(far, 1e-4), far > 1e-4);
    var best = vec2f(0.0);
    for (var j = -2; j <= 2; j = j + 1) {
        for (var i = -2; i <= 2; i = i + 1) {
            let o = vec2i(i, j);
            let r = gwCell2(cell + o, period, seed);
            if (r.w > share || (column >= 0 && cell.x + i != column)) {
                continue;
            }
            let rel = f - (vec2f(o) + 0.5 + (r.xy - 0.5) * 0.8);
            let tall = 0.45 + 0.55 * r.z;
            let q = length(rel) / (0.3 + 0.14 * r.z);
            let body = sqrt(max(1.0 - q * q * q * q, 0.0)) * (1.0 - 0.25 * q * q) * tall;
            let off = rel - reach * 0.5;
            let e = vec2f(dot(off, along) / (0.5 + 0.6 * far), dot(off, vec2f(-along.y, along.x)) / 0.5);
            let skirt = max(1.0 - dot(e, e), 0.0) * smoothstep(0.8, 0.95, tall);
            best = max(best, vec2f(body, skirt));
        }
    }
    return best;
}

// A march's jitter for a pixel, in [0, 1): Jimenez's interleaved gradient noise (2014), another frame of it each frame.
fn gwJitter(pixel: vec2u, frame: u32) -> f32 {
    let p = vec2f(pixel) + 5.588238 * f32(frame % 64u);
    return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}
