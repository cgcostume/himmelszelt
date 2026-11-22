// Hashes for the GPU, binding-free: of three numbers and of four, and of a lattice cell, wrapped at an integer period so
// what is made from it tiles. reisszeug: every identifier is prefixed `rz`, which the package inlining it renames.

// Jarzynski and Olano's pcg3d, a hash of three numbers.
fn rzHash(v0: vec3u) -> u32 {
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
fn rzHash4(v0: vec4u) -> vec4u {
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
fn rzMix(v: vec4u) -> vec4u {
    var h = v;
    h = (h ^ (h >> vec4u(16u))) * 0x7FEB352Du;
    h = (h ^ (h >> vec4u(15u))) * 0x846CA68Bu;
    return h ^ (h >> vec4u(16u));
}

fn rzUnit(hash: u32) -> f32 {
    return f32(hash & 0xFFFFFFu) / 16777216.0;
}

// A lattice point wrapped into [0, period) per axis.
fn rzWrap(cell: vec3i, period: vec3i) -> vec3i {
    let m = cell % period;
    return select(m, m + period, m < vec3i(0));
}

fn rzWrap2(cell: vec2i, period: vec2i) -> vec2i {
    let m = cell % period;
    return select(m, m + period, m < vec2i(0));
}

// Four numbers in [0, 1) of a lattice cell, already wrapped, and of one of two dimensions, wrapped here.
fn rzCell(cell: vec3i, seed: u32) -> vec4f {
    return vec4f(rzHash4(vec4u(vec3u(cell), seed)) >> vec4u(8u)) / 16777216.0;
}

fn rzCell2(cell: vec2i, period: vec2i, seed: u32) -> vec4f {
    return rzCell(vec3i(rzWrap2(cell, period), 0), seed);
}
