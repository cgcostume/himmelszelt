// Noise, binding-free and tileable: every lattice is wrapped at an integer period, so a texture made from it repeats
// without a seam. Perlin's gradient noise (2002) for the cloud map's shape, in three dimensions and in two; SideFX's
// alligator noise, a cellular noise whose value is the largest contribution less the second, for billows, and the
// same distorted by a curl field for wisps, as Nubis3 does; the cell patterns the layers' and the high sheet's maps
// are drawn from; and the jitter a march starts its rays by. Every identifier is prefixed `gw`.
//
// A lattice is wrapped once per call, not per corner, and the corners of a cell are hashed together. research/noise
// in the package measures each against what came before.

// Jarzynski and Olano's pcg3d, a hash of three numbers.
fn gwHash(v0: vec3u) -> u32 {
    var v = v0 * 1664525u + 1013904223u;
    v.x = v.x + v.y * v.z;
    v.y = v.y + v.z * v.x;
    v.z = v.z + v.x * v.y;
    v = v ^ (v >> vec3u(16u));
    v.x = v.x + v.y * v.z;
    v.y = v.y + v.z * v.x;
    v.z = v.z + v.x * v.y;
    return v.x;
}

// Their pcg4d: four numbers hashed into four.
fn gwHash4(v0: vec4u) -> vec4u {
    var v = v0 * 1664525u + 1013904223u;
    v.x = v.x + v.y * v.w;
    v.y = v.y + v.z * v.x;
    v.z = v.z + v.x * v.y;
    v.w = v.w + v.y * v.z;
    v = v ^ (v >> vec4u(16u));
    v.x = v.x + v.y * v.w;
    v.y = v.y + v.z * v.x;
    v.z = v.z + v.x * v.y;
    v.w = v.w + v.y * v.z;
    return v;
}

// Wellons' lowbias32, four at once: what a cell's corners are hashed by, each a sum of a product per axis.
fn gwMix(v: vec4u) -> vec4u {
    var h = v;
    h = (h ^ (h >> vec4u(16u))) * 0x7FEB352Du;
    h = (h ^ (h >> vec4u(15u))) * 0x846CA68Bu;
    return h ^ (h >> vec4u(16u));
}

fn gwUnit(hash: u32) -> f32 {
    return f32(hash & 0xFFFFFFu) / 16777216.0;
}

// A lattice point wrapped into [0, period) per axis.
fn gwWrap(cell: vec3i, period: vec3i) -> vec3i {
    let m = cell % period;
    return select(m, m + period, m < vec3i(0));
}

fn gwWrap2(cell: vec2i, period: vec2i) -> vec2i {
    let m = cell % period;
    return select(m, m + period, m < vec2i(0));
}

// Four numbers in [0, 1) of a lattice cell, already wrapped, and of one of two dimensions, wrapped here.
fn gwCell(cell: vec3i, seed: u32) -> vec4f {
    return vec4f(gwHash4(vec4u(vec3u(cell), seed)) >> vec4u(8u)) / 16777216.0;
}

fn gwCell2(cell: vec2i, period: vec2i, seed: u32) -> vec4f {
    return gwCell(vec3i(gwWrap2(cell, period), 0), seed);
}

// Perlin's gradient at a corner dotted with the offset to it, by four bits of its hash, as his reference does.
fn gwGrad(h: u32, p: vec3f) -> f32 {
    let u = select(p.y, p.x, h < 8u);
    let v = select(select(p.z, p.x, h == 12u || h == 14u), p.y, h < 4u);
    return select(-u, u, (h & 1u) == 0u) + select(-v, v, (h & 2u) == 0u);
}

// The same gradient as a vector.
fn gwGradient(h: u32) -> vec3f {
    let su = select(-1.0, 1.0, (h & 1u) == 0u);
    let sv = select(-1.0, 1.0, (h & 2u) == 0u);
    if (h < 4u) {
        return vec3f(su, sv, 0.0);
    }
    if (h < 8u) {
        return vec3f(su, 0.0, sv);
    }
    if (h == 12u || h == 14u) {
        return vec3f(sv, su, 0.0);
    }
    return vec3f(0.0, su, sv);
}

// The hashes of the eight corners of the cell `p` lies in, the lower four and the upper four, and `p` within it. A
// gradient takes four bits of a hash; the top four are the noise's, the others free for noises that share the cell.
struct GwCorners {
    lo: vec4u,
    hi: vec4u,
    f: vec3f,
}

fn gwCorners(p: vec3f, period: vec3i, seed: u32) -> GwCorners {
    let cell = floor(p);
    let at = gwWrap(vec3i(cell), period);
    let next = select(at + 1, vec3i(0), at + 1 == period);
    let kx = vec2u(vec2i(at.x, next.x)) * 0x8DA6B343u;
    let ky = vec2u(vec2i(at.y, next.y)) * 0xD8163841u;
    let kz = vec2u(vec2i(at.z, next.z)) * 0xCB1AB31Fu + seed * 0x9E3779B9u;
    let xy = kx.xyxy + ky.xxyy;
    return GwCorners(gwMix(xy + kz.x), gwMix(xy + kz.y), p - cell);
}

// Gradient noise in about [-1, 1], tiling every `period` lattice cells.
fn gwPerlin(p: vec3f, period: vec3i, seed: u32) -> f32 {
    let c = gwCorners(p, period, seed);
    let f = c.f;
    let g = f - 1.0;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let lo = c.lo >> vec4u(28u);
    let hi = c.hi >> vec4u(28u);
    let x0 = mix(gwGrad(lo.x, f), gwGrad(lo.y, vec3f(g.x, f.y, f.z)), u.x);
    let x1 = mix(gwGrad(lo.z, vec3f(f.x, g.y, f.z)), gwGrad(lo.w, vec3f(g.x, g.y, f.z)), u.x);
    let x2 = mix(gwGrad(hi.x, vec3f(f.x, f.y, g.z)), gwGrad(hi.y, vec3f(g.x, f.y, g.z)), u.x);
    let x3 = mix(gwGrad(hi.z, vec3f(f.x, g.y, g.z)), gwGrad(hi.w, g), u.x);
    return mix(mix(x0, x1, u.y), mix(x2, x3, u.y), u.z);
}

// Octaves of gwPerlin summed with halving weights, in about [0, 1]: `p` in lattice cells of the first octave, which
// tiles every `period`; each octave doubles both.
fn gwFbm(p: vec3f, period: vec3i, octaves: u32, seed: u32) -> f32 {
    var sum = 0.0;
    var weight = 1.0;
    var total = 0.0;
    var q = p;
    var cells = period;
    for (var o = 0u; o < octaves; o = o + 1u) {
        sum = sum + weight * gwPerlin(q, cells, seed + o);
        total = total + weight;
        weight = weight * 0.5;
        q = q * 2.0;
        cells = cells * 2;
    }
    return clamp(0.5 + 0.5 * sum / total, 0.0, 1.0);
}

// One of sixteen directions evenly around the circle dotted with the offset `p`, by the top four bits of the hash,
// and a height of the corner's own from its low bits.
const GW_PERLIN2_HEIGHT: f32 = 0.35;
fn gwGrad2(hash: u32, p: vec2f) -> f32 {
    let d = select(vec2f(0.98078528, 0.19509032), vec2f(0.83146961, 0.55557023), (hash & 0x80000000u) != 0u);
    let e = select(d, d.yx, (hash & 0x40000000u) != 0u);
    let slope = select(-e.x, e.x, (hash & 0x10000000u) == 0u) * p.x + select(-e.y, e.y, (hash & 0x20000000u) == 0u) * p.y;
    return slope + GW_PERLIN2_HEIGHT * (f32(hash & 0xFFFFu) / 32767.5 - 1.0);
}

// Gradient noise of two dimensions in about [-1, 1], tiling every `period` lattice cells: half gwPerlin's corners,
// for what has no third coordinate to move along. Plain gradient noise is 0 at every lattice point, which pins the
// creases of its absolute value to the lattice; a slice of gwPerlin is not, as each corner's gradient lifts it by its
// third component. So each corner has a height of its own, as much as spreads it as widely as gwPerlin's slices.
fn gwPerlin2(p: vec2f, period: vec2i, seed: u32) -> f32 {
    let cell = floor(p);
    let f = p - cell;
    let g = f - 1.0;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let at = gwWrap2(vec2i(cell), period);
    let next = select(at + 1, vec2i(0), at + 1 == period);
    let kx = vec2u(vec2i(at.x, next.x)) * 0x8DA6B343u;
    let ky = vec2u(vec2i(at.y, next.y)) * 0xD8163841u + seed * 0x9E3779B9u;
    let h = gwMix(kx.xyxy + ky.xxyy);
    let x0 = mix(gwGrad2(h.x, f), gwGrad2(h.y, vec2f(g.x, f.y)), u.x);
    let x1 = mix(gwGrad2(h.z, vec2f(f.x, g.y)), gwGrad2(h.w, g), u.x);
    return mix(x0, x1, u.y);
}

// Alligator noise after SideFX's reference: one point per cell with a random strength, a smooth kernel to a radius
// of one cell, and the largest contribution less the second largest, which draws the ridges between cells. In [0, 1).
fn gwAlligator(p: vec3f, period: vec3i, seed: u32) -> f32 {
    let cell = floor(p);
    let f = p - cell;
    let at = gwWrap(vec3i(cell), period);
    // The three cells along each axis, wrapped: the one before, this one, the next.
    let before = select(at - 1, period - 1, at == vec3i(0));
    let after = select(at + 1, vec3i(0), at + 1 == period);
    let xs = vec3i(before.x, at.x, after.x);
    let ys = vec3i(before.y, at.y, after.y);
    let zs = vec3i(before.z, at.z, after.z);
    // The squared distance from `f` to the nearest point of the cells before and after, per axis: a cell a radius or
    // more away holds no point that reaches `f`.
    let lo = f * f;
    let hi = (1.0 - f) * (1.0 - f);
    var first = 0.0;
    var second = 0.0;
    for (var c = 0u; c < 27u; c = c + 1u) {
        let k = vec3u(c % 3u, (c / 3u) % 3u, c / 9u);
        let away = select(select(hi.x, 0.0, k.x == 1u), lo.x, k.x == 0u) +
            select(select(hi.y, 0.0, k.y == 1u), lo.y, k.y == 0u) + select(select(hi.z, 0.0, k.z == 1u), lo.z, k.z == 0u);
        if (away >= 1.0) {
            continue;
        }
        let r = gwCell(vec3i(xs[k.x], ys[k.y], zs[k.z]), seed);
        let d = length(f - (vec3f(k) - 1.0 + r.xyz));
        if (d < 1.0) {
            let t = 1.0 - d;
            let value = r.w * t * t * (3.0 - 2.0 * t);
            if (value > first) {
                second = first;
                first = value;
            } else if (value > second) {
                second = value;
            }
        }
    }
    return first - second;
}

// Gradient noise's slope at `f` in a cell, analytically, after Quilez: from four bits of the hashes of its corners, the
// quintic fade `u` and its derivative `du`.
fn gwSlope(lo: vec4u, hi: vec4u, f: vec3f, u: vec3f, du: vec3f) -> vec3f {
    let g = f - 1.0;
    let ga = gwGradient(lo.x);
    let gb = gwGradient(lo.y);
    let gc = gwGradient(lo.z);
    let gd = gwGradient(lo.w);
    let ge = gwGradient(hi.x);
    let gf = gwGradient(hi.y);
    let gg = gwGradient(hi.z);
    let gh = gwGradient(hi.w);
    let va = dot(ga, f);
    let vb = dot(gb, vec3f(g.x, f.y, f.z));
    let vc = dot(gc, vec3f(f.x, g.y, f.z));
    let vd = dot(gd, vec3f(g.x, g.y, f.z));
    let ve = dot(ge, vec3f(f.x, f.y, g.z));
    let vf = dot(gf, vec3f(g.x, f.y, g.z));
    let vg = dot(gg, vec3f(f.x, g.y, g.z));
    let vh = dot(gh, g);
    let k4 = -va + vb + vc - vd + ve - vf - vg + vh;
    return ga + u.x * (gb - ga) + u.y * (gc - ga) + u.z * (ge - ga) + u.x * u.y * (ga - gb - gc + gd) +
        u.y * u.z * (ga - gc - ge + gg) + u.z * u.x * (ga - gb - ge + gf) +
        u.x * u.y * u.z * (-ga + gb + gc - gd + ge - gf - gg + gh) +
        du * (vec3f(vb - va, vc - va, ve - va) + u.yzx * vec3f(va - vb - vc + vd, va - vc - ve + vg, va - vb - ve + vf) +
            u.zxy * vec3f(va - vb - ve + vf, va - vb - vc + vd, va - vc - ve + vg) + u.yzx * u.zxy * k4);
}

// The curl of three gradient noises, a divergence-free field that swirls: from their slopes, analytically, the three
// taking their gradients from other bits of the same corners' hashes.
fn gwCurl(p: vec3f, period: vec3i, seed: u32) -> vec3f {
    let c = gwCorners(p, period, seed);
    let f = c.f;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    let x = gwSlope(c.lo >> vec4u(28u), c.hi >> vec4u(28u), f, u, du);
    let y = gwSlope((c.lo >> vec4u(22u)) & vec4u(15u), (c.hi >> vec4u(22u)) & vec4u(15u), f, u, du);
    let z = gwSlope((c.lo >> vec4u(16u)) & vec4u(15u), (c.hi >> vec4u(16u)) & vec4u(15u), f, u, du);
    return vec3f(z.y - y.z, x.z - z.x, y.x - x.y);
}

// Nubis3's curly-alligator noise: alligator noise inverted into webs, read at a position swirled by a curl field.
// Wrapping holds since the curl field tiles too, but the swirl moves a point across a tile's edge: `strength` stays
// small next to the period.
fn gwCurlyAlligator(p: vec3f, period: vec3i, seed: u32, strength: f32) -> f32 {
    let swirled = p + gwCurl(p / 2.0, max(period / 2, vec3i(1)), seed + 101u) * strength;
    return 1.0 - gwAlligator(swirled, period, seed);
}

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
