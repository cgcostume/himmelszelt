// Noise, binding-free and tileable: every lattice is wrapped at an integer period, so a texture made from it repeats
// without a seam. Perlin's gradient noise (2002) for the cloud map's shape, SideFX's alligator noise, a cellular noise
// whose value is the largest contribution less the second, for billows, and the same distorted by a curl field for
// wisps, as Nubis3 does. Every identifier is prefixed `gw`.

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

// A lattice point wrapped into [0, period) per axis, hashed with a seed.
fn gwLattice(cell: vec3i, period: vec3i, seed: u32) -> u32 {
    let wrapped = vec3u((cell % period + period) % period);
    return gwHash(wrapped + vec3u(seed * 0x9E3779B9u, seed * 0x85EBCA6Bu + 1u, seed * 0xC2B2AE35u + 2u));
}

fn gwUnit(hash: u32) -> f32 {
    return f32(hash & 0xFFFFFFu) / 16777216.0;
}

// Perlin's gradient at a corner dotted with the offset to it, from the hash's low bits, as his reference does.
fn gwGrad(hash: u32, p: vec3f) -> f32 {
    let h = hash & 15u;
    let u = select(p.y, p.x, h < 8u);
    let v = select(select(p.z, p.x, h == 12u || h == 14u), p.y, h < 4u);
    return select(-u, u, (h & 1u) == 0u) + select(-v, v, (h & 2u) == 0u);
}

// Gradient noise in about [-1, 1], tiling every `period` lattice cells.
fn gwPerlin(p: vec3f, period: vec3i, seed: u32) -> f32 {
    let i = vec3i(floor(p));
    let f = p - floor(p);
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    var n: array<f32, 8>;
    for (var c = 0u; c < 8u; c = c + 1u) {
        let corner = vec3i(i32(c & 1u), i32((c >> 1u) & 1u), i32((c >> 2u) & 1u));
        n[c] = gwGrad(gwLattice(i + corner, period, seed), f - vec3f(corner));
    }
    let x0 = mix(n[0], n[1], u.x);
    let x1 = mix(n[2], n[3], u.x);
    let x2 = mix(n[4], n[5], u.x);
    let x3 = mix(n[6], n[7], u.x);
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

// Alligator noise after SideFX's reference: one point per cell with a random strength, a smooth kernel to a radius
// of one cell, and the largest contribution less the second largest, which draws the ridges between cells. In [0, 1).
fn gwAlligator(p: vec3f, period: vec3i, seed: u32) -> f32 {
    let i = vec3i(floor(p));
    let f = p - floor(p);
    var first = 0.0;
    var second = 0.0;
    for (var c = 0u; c < 27u; c = c + 1u) {
        let offset = vec3i(i32(c % 3u), i32((c / 3u) % 3u), i32(c / 9u)) - 1;
        let hash = gwLattice(i + offset, period, seed);
        let center = vec3f(offset) + vec3f(gwUnit(hash), gwUnit(gwHash(vec3u(hash, 1u, 2u))), gwUnit(gwHash(vec3u(hash, 3u, 4u))));
        let strength = gwUnit(gwHash(vec3u(hash, 5u, 6u)));
        let d = length(f - center);
        if (d < 1.0) {
            let t = 1.0 - d;
            let value = strength * t * t * (3.0 - 2.0 * t);
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

// The curl of three gradient noises, a divergence-free field that swirls, by central differences.
fn gwCurl(p: vec3f, period: vec3i, seed: u32) -> vec3f {
    let e = 0.05;
    let dx = vec3f(e, 0.0, 0.0);
    let dy = vec3f(0.0, e, 0.0);
    let dz = vec3f(0.0, 0.0, e);
    let x = seed + 11u;
    let y = seed + 23u;
    let z = seed + 37u;
    let dzdy = gwPerlin(p + dy, period, z) - gwPerlin(p - dy, period, z);
    let dydz = gwPerlin(p + dz, period, y) - gwPerlin(p - dz, period, y);
    let dxdz = gwPerlin(p + dz, period, x) - gwPerlin(p - dz, period, x);
    let dzdx = gwPerlin(p + dx, period, z) - gwPerlin(p - dx, period, z);
    let dydx = gwPerlin(p + dx, period, y) - gwPerlin(p - dx, period, y);
    let dxdy = gwPerlin(p + dy, period, x) - gwPerlin(p - dy, period, x);
    return vec3f(dzdy - dydz, dxdz - dzdx, dydx - dxdy) / (2.0 * e);
}

// Nubis3's curly-alligator noise: alligator noise inverted into webs, read at a position swirled by a curl field.
// Wrapping holds since the curl field tiles too, but the swirl moves a point across a tile's edge: `strength` stays
// small next to the period.
fn gwCurlyAlligator(p: vec3f, period: vec3i, seed: u32, strength: f32) -> f32 {
    let swirled = p + gwCurl(p / 2.0, max(period / 2, vec3i(1)), seed + 101u) * strength;
    return 1.0 - gwAlligator(swirled, period, seed);
}
