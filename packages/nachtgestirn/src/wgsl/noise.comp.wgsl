// The roughness' noise, made once: gradient noise's gradient at the centers of a 3D texture's texels, NG_NOISE_TEXELS to
// a cell, periodic over the texture, scaled into 8-bit snorm by NG_NOISE_RANGE. The Moon pass reads it trilinearly, a
// tap an octave, rather than hashing the eight corners of a cell for every octave of every ray. Self-contained.

@group(0) @binding(0) var ngNoiseOut: texture_storage_3d<rgba8snorm, write>;

// Texels to a cell of the noise, and the largest component of its gradient, which 8-bit snorm scales to 1: as
// moon.comp.wgsl reads them.
const NG_NOISE_TEXELS: f32 = 4.0;
const NG_NOISE_RANGE: f32 = 2.26;

// A lattice point's gradient, each component in [-1, 1]: Jarzynski and Olano's pcg3d.
fn ngLatticeGradient(cell: vec3i) -> vec3f {
    var v = vec3u(cell) * 1664525u + 1013904223u;
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v ^= v >> vec3u(16u);
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    return vec3f(v) * (2.0 / 4294967296.0) - 1.0;
}

// Gradient noise's gradient at `p`, analytically, after Quílez: the quintic fade's derivative included, so it is the
// true slope of the noise and continuous across the cells. Its lattice repeats every `period` cells.
fn ngNoiseGradient(p: vec3f, period: i32) -> vec3f {
    let i = vec3i(floor(p));
    let f = p - floor(p);
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    let at = (i % period + period) % period;
    let next = (at + 1) % period;
    let ga = ngLatticeGradient(at);
    let gb = ngLatticeGradient(vec3i(next.x, at.y, at.z));
    let gc = ngLatticeGradient(vec3i(at.x, next.y, at.z));
    let gd = ngLatticeGradient(vec3i(next.x, next.y, at.z));
    let ge = ngLatticeGradient(vec3i(at.x, at.y, next.z));
    let gf = ngLatticeGradient(vec3i(next.x, at.y, next.z));
    let gg = ngLatticeGradient(vec3i(at.x, next.y, next.z));
    let gh = ngLatticeGradient(next);
    let va = dot(ga, f);
    let vb = dot(gb, f - vec3f(1.0, 0.0, 0.0));
    let vc = dot(gc, f - vec3f(0.0, 1.0, 0.0));
    let vd = dot(gd, f - vec3f(1.0, 1.0, 0.0));
    let ve = dot(ge, f - vec3f(0.0, 0.0, 1.0));
    let vf = dot(gf, f - vec3f(1.0, 0.0, 1.0));
    let vg = dot(gg, f - vec3f(0.0, 1.0, 1.0));
    let vh = dot(gh, f - vec3f(1.0, 1.0, 1.0));
    let k4 = -va + vb + vc - vd + ve - vf - vg + vh;
    return ga + u.x * (gb - ga) + u.y * (gc - ga) + u.z * (ge - ga) + u.x * u.y * (ga - gb - gc + gd) +
        u.y * u.z * (ga - gc - ge + gg) + u.z * u.x * (ga - gb - ge + gf) +
        u.x * u.y * u.z * (-ga + gb + gc - gd + ge - gf - gg + gh) +
        du * (vec3f(vb - va, vc - va, ve - va) + u.yzx * vec3f(va - vb - vc + vd, va - vc - ve + vg, va - vb - ve + vf) +
            u.zxy * vec3f(va - vb - ve + vf, va - vb - vc + vd, va - vc - ve + vg) + u.yzx * u.zxy * k4);
}

@compute @workgroup_size(4, 4, 4)
fn ngNoise(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(ngNoiseOut);
    if (any(id >= size)) {
        return;
    }
    let gradient = ngNoiseGradient((vec3f(id) + 0.5) / NG_NOISE_TEXELS, i32(f32(size.x) / NG_NOISE_TEXELS));
    textureStore(ngNoiseOut, vec3i(id), vec4f(clamp(gradient / NG_NOISE_RANGE, vec3f(-1.0), vec3f(1.0)), 0.0));
}
