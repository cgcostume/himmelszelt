// Noise, binding-free and tileable: every lattice is wrapped at an integer period, so a texture made from it repeats
// without a seam. Perlin's gradient noise (2002) in three dimensions and in two, its octaves, its slope analytically
// after Quilez, the curl field of three, SideFX's alligator noise and Nubis3's curly alligator noise. A lattice is
// wrapped once per call, not per corner, and a cell's corners are hashed together. Requires `hash.wgsl`. reisszeug:
// every identifier is prefixed `rz`, which the package inlining it renames. gewoelk's research/noise measures it.

// Perlin's gradient at a corner dotted with the offset to it, by four bits of its hash, as his reference does.
fn rzGrad(h: u32, p: vec3f) -> f32 {
    let u = select(p.y, p.x, h < 8u);
    let v = select(select(p.z, p.x, h == 12u || h == 14u), p.y, h < 4u);
    return select(-u, u, (h & 1u) == 0u) + select(-v, v, (h & 2u) == 0u);
}

// The same gradient as a vector.
fn rzGradient(h: u32) -> vec3f {
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
struct RzCorners {
    lo: vec4u,
    hi: vec4u,
    f: vec3f,
}

fn rzCorners(p: vec3f, period: vec3i, seed: u32) -> RzCorners {
    let cell = floor(p);
    let at = rzWrap(vec3i(cell), period);
    let next = select(at + 1, vec3i(0), at + 1 == period);
    let kx = vec2u(vec2i(at.x, next.x)) * 0x8DA6B343u;
    let ky = vec2u(vec2i(at.y, next.y)) * 0xD8163841u;
    let kz = vec2u(vec2i(at.z, next.z)) * 0xCB1AB31Fu + seed * 0x9E3779B9u;
    let xy = kx.xyxy + ky.xxyy;
    return RzCorners(rzMix(xy + kz.x), rzMix(xy + kz.y), p - cell);
}

// Gradient noise in about [-1, 1], tiling every `period` lattice cells.
fn rzPerlin(p: vec3f, period: vec3i, seed: u32) -> f32 {
    let c = rzCorners(p, period, seed);
    let f = c.f;
    let g = f - 1.0;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let lo = c.lo >> vec4u(28u);
    let hi = c.hi >> vec4u(28u);
    let x0 = mix(rzGrad(lo.x, f), rzGrad(lo.y, vec3f(g.x, f.y, f.z)), u.x);
    let x1 = mix(rzGrad(lo.z, vec3f(f.x, g.y, f.z)), rzGrad(lo.w, vec3f(g.x, g.y, f.z)), u.x);
    let x2 = mix(rzGrad(hi.x, vec3f(f.x, f.y, g.z)), rzGrad(hi.y, vec3f(g.x, f.y, g.z)), u.x);
    let x3 = mix(rzGrad(hi.z, vec3f(f.x, g.y, g.z)), rzGrad(hi.w, g), u.x);
    return mix(mix(x0, x1, u.y), mix(x2, x3, u.y), u.z);
}

// Octaves of rzPerlin summed with halving weights, in about [0, 1]: `p` in lattice cells of the first octave, which
// tiles every `period`; each octave doubles both.
fn rzFbm(p: vec3f, period: vec3i, octaves: u32, seed: u32) -> f32 {
    var sum = 0.0;
    var weight = 1.0;
    var total = 0.0;
    var q = p;
    var cells = period;
    for (var o = 0u; o < octaves; o = o + 1u) {
        sum = sum + weight * rzPerlin(q, cells, seed + o);
        total = total + weight;
        weight = weight * 0.5;
        q = q * 2.0;
        cells = cells * 2;
    }
    return clamp(0.5 + 0.5 * sum / total, 0.0, 1.0);
}

// One of sixteen directions evenly around the circle dotted with the offset `p`, by the top four bits of the hash,
// and a height of the corner's own from its low bits.
const RZ_PERLIN2_HEIGHT: f32 = 0.35;
fn rzGrad2(hash: u32, p: vec2f) -> f32 {
    let d = select(vec2f(0.98078528, 0.19509032), vec2f(0.83146961, 0.55557023), (hash & 0x80000000u) != 0u);
    let e = select(d, d.yx, (hash & 0x40000000u) != 0u);
    let slope = select(-e.x, e.x, (hash & 0x10000000u) == 0u) * p.x + select(-e.y, e.y, (hash & 0x20000000u) == 0u) * p.y;
    return slope + RZ_PERLIN2_HEIGHT * (f32(hash & 0xFFFFu) / 32767.5 - 1.0);
}

// Gradient noise of two dimensions in about [-1, 1], tiling every `period` lattice cells: half rzPerlin's corners,
// for what has no third coordinate to move along. Plain gradient noise is 0 at every lattice point, which pins the
// creases of its absolute value to the lattice; a slice of rzPerlin is not, as each corner's gradient lifts it by its
// third component. So each corner has a height of its own, as much as spreads it as widely as rzPerlin's slices.
fn rzPerlin2(p: vec2f, period: vec2i, seed: u32) -> f32 {
    let cell = floor(p);
    let f = p - cell;
    let g = f - 1.0;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let at = rzWrap2(vec2i(cell), period);
    let next = select(at + 1, vec2i(0), at + 1 == period);
    let kx = vec2u(vec2i(at.x, next.x)) * 0x8DA6B343u;
    let ky = vec2u(vec2i(at.y, next.y)) * 0xD8163841u + seed * 0x9E3779B9u;
    let h = rzMix(kx.xyxy + ky.xxyy);
    let x0 = mix(rzGrad2(h.x, f), rzGrad2(h.y, vec2f(g.x, f.y)), u.x);
    let x1 = mix(rzGrad2(h.z, vec2f(f.x, g.y)), rzGrad2(h.w, g), u.x);
    return mix(x0, x1, u.y);
}

// Alligator noise after SideFX's reference: one point per cell with a random strength, a smooth kernel to a radius
// of one cell, and the largest contribution less the second largest, which draws the ridges between cells. In [0, 1).
fn rzAlligator(p: vec3f, period: vec3i, seed: u32) -> f32 {
    let cell = floor(p);
    let f = p - cell;
    let at = rzWrap(vec3i(cell), period);
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
        let r = rzCell(vec3i(xs[k.x], ys[k.y], zs[k.z]), seed);
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
fn rzSlope(lo: vec4u, hi: vec4u, f: vec3f, u: vec3f, du: vec3f) -> vec3f {
    let g = f - 1.0;
    let ga = rzGradient(lo.x);
    let gb = rzGradient(lo.y);
    let gc = rzGradient(lo.z);
    let gd = rzGradient(lo.w);
    let ge = rzGradient(hi.x);
    let gf = rzGradient(hi.y);
    let gg = rzGradient(hi.z);
    let gh = rzGradient(hi.w);
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

// The slope of rzPerlin at `p`, analytically.
fn rzPerlinSlope(p: vec3f, period: vec3i, seed: u32) -> vec3f {
    let c = rzCorners(p, period, seed);
    let f = c.f;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    return rzSlope(c.lo >> vec4u(28u), c.hi >> vec4u(28u), f, u, du);
}

// The curl of three gradient noises, a divergence-free field that swirls: from their slopes, analytically, the three
// taking their gradients from other bits of the same corners' hashes.
fn rzCurl(p: vec3f, period: vec3i, seed: u32) -> vec3f {
    let c = rzCorners(p, period, seed);
    let f = c.f;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    let x = rzSlope(c.lo >> vec4u(28u), c.hi >> vec4u(28u), f, u, du);
    let y = rzSlope((c.lo >> vec4u(22u)) & vec4u(15u), (c.hi >> vec4u(22u)) & vec4u(15u), f, u, du);
    let z = rzSlope((c.lo >> vec4u(16u)) & vec4u(15u), (c.hi >> vec4u(16u)) & vec4u(15u), f, u, du);
    return vec3f(z.y - y.z, x.z - z.x, y.x - x.y);
}

// Nubis3's curly-alligator noise: alligator noise inverted into webs, read at a position swirled by a curl field.
// Wrapping holds since the curl field tiles too, but the swirl moves a point across a tile's edge: `strength` stays
// small next to the period.
fn rzCurlyAlligator(p: vec3f, period: vec3i, seed: u32, strength: f32) -> f32 {
    let swirled = p + rzCurl(p / 2.0, max(period / 2, vec3i(1)), seed + 101u) * strength;
    return 1.0 - rzAlligator(swirled, period, seed);
}
