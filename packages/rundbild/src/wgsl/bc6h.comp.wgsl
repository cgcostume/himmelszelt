// Encodes a texture into BC6H blocks (bc6h-rgb-ufloat), sixteen bytes for four by four texels, a row of blocks padded to
// 256 bytes for the copy into the texture. Ported from Krzysztof Narkowicz's GPURealTimeBC6H (bin/compress.hlsl):
// mode 11, one line of 10-bit endpoints with 4-bit indices, and with RB_BC6H_QUALITY also the best of the 32 two-line
// partitions, by how far the texels lie off each subset's line, in modes 2 (7.6) and 6 (9.5) with 3-bit indices,
// whichever has the smaller error in log2 space weighted by luminance.
//
// MIT License
//
// Copyright (c) 2015 Krzysztof Narkowicz
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

@group(0) @binding(0) var rbBc6hSource: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> rbBc6hBlocks: array<vec4u>;

/** Whether to try the two-line partitions too: slower, but better at edges. */
override RB_BC6H_QUALITY: bool = true;

const RB_BC6H_HALF_MAX = 65504.0;
// The largest finite half as bits, where the original clamps the bits to 65504 and so lets them reach NaN.
const RB_BC6H_HALF_MAX_BITS = 31743.0;

// The 32 two-subset partitions, a bit per texel for its subset, two to a word.
const RB_BC6H_PATTERNS = array<u32, 16>(
    2290666700u, 3972591342u, 4276930688u, 3967876808u, 4293707776u, 3892379264u, 4278255592u, 4026597360u,
    9369360u, 147747072u, 1930428556u, 2362323200u, 823134348u, 913073766u, 267393000u, 966553998u,
);

var<private> rbBc6hTexels: array<vec3f, 16>;

/** f32tof16: the half's bits as a number, which grows with the value. */
fn rbBc6hF16(x: vec3f) -> vec3f {
    let c = clamp(x, vec3f(0.0), vec3f(RB_BC6H_HALF_MAX));
    let xy = pack2x16float(c.xy);
    return vec3f(f32(xy & 0xFFFFu), f32(xy >> 16u), f32(pack2x16float(vec2f(c.z, 0.0)) & 0xFFFFu));
}

fn rbBc6hF16s(x: f32) -> f32 {
    return f32(pack2x16float(vec2f(clamp(x, 0.0, RB_BC6H_HALF_MAX), 0.0)) & 0xFFFFu);
}

/** f16tof32 of bits given as a number, truncated. */
fn rbBc6hF32(bits: vec3f) -> vec3f {
    let b = vec3u(clamp(bits, vec3f(0.0), vec3f(RB_BC6H_HALF_MAX_BITS)));
    return vec3f(unpack2x16float(b.x | (b.y << 16u)), unpack2x16float(b.z).x);
}

fn rbBc6hMsle(a: vec3f, b: vec3f) -> f32 {
    let delta = log2((b + 1.0) / (a + 1.0));
    return dot(delta * delta, vec3f(0.299, 0.587, 0.114));
}

fn rbBc6hFixup(p: u32) -> u32 {
    var fixup = 15u;
    if (((3441033216u >> p) & 1u) != 0u) {
        fixup = 2u;
    }
    if (((845414400u >> p) & 1u) != 0u) {
        fixup = 8u;
    }
    return fixup;
}

fn rbBc6hPattern(p: u32, i: u32) -> u32 {
    return (RB_BC6H_PATTERNS[p >> 1u] >> ((p & 1u) * 16u + i)) & 1u;
}

fn rbBc6hQuantize(x: vec3f, bits: f32) -> vec3f {
    return rbBc6hF16(x) * exp2(bits) / 31744.0;
}

fn rbBc6hUnquantize(x: vec3f, bits: f32) -> vec3f {
    return (x * 65536.0 + 32768.0) / exp2(bits);
}

fn rbBc6hFinishUnquantize(e0: vec3f, e1: vec3f, weight: f32) -> vec3f {
    return rbBc6hF32(floor((e0 * (64.0 - weight) + e1 * weight + 32.0) * (31.0 / 4096.0)));
}

// Equal ends would divide by zero, which the original leaves to D3D's rules: the last index above the end, else the first.
fn rbBc6hIndex3(t: f32, e0: f32, e1: f32) -> u32 {
    if (e1 == e0) {
        return select(0u, 7u, t > e0);
    }
    return u32(clamp((t - e0) / (e1 - e0) * 6.98182 + 0.00909 + 0.5, 0.0, 7.0));
}

fn rbBc6hIndex4(t: f32, e0: f32, e1: f32) -> u32 {
    if (e1 == e0) {
        return select(0u, 15u, t > e0);
    }
    return u32(clamp((t - e0) / (e1 - e0) * 14.93333 + 0.03333 + 0.5, 0.0, 15.0));
}

/** The direction from one end to the other over the sum of its components, zero where the ends meet. */
fn rbBc6hDirection(lo: vec3f, hi: vec3f) -> vec3f {
    let d = hi - lo;
    let sum = d.x + d.y + d.z;
    if (sum == 0.0) {
        return vec3f(0.0);
    }
    return d / sum;
}

fn rbBc6hSignExtend(v: vec3f, mask: i32, flag: i32) -> vec3f {
    let i = vec3i(v);
    return vec3f((i & vec3i(mask)) | select(vec3i(0), vec3i(flag), i < vec3i(0)));
}

/** ORs `value` into the block at bit `at`, across a word's end. */
fn rbBc6hPut(block: ptr<function, vec4u>, at: u32, value: u32) {
    let word = at >> 5u;
    let shift = at & 31u;
    (*block)[word] |= value << shift;
    if (shift != 0u && word < 3u) {
        (*block)[word + 1u] |= value >> (32u - shift);
    }
}

// The box inset in log2 space, by up to a 32nd of its span, toward the second smallest and largest texels.
fn rbBc6hInsetP1(lo: ptr<function, vec3f>, hi: ptr<function, vec3f>) {
    var refinedLo = *hi;
    var refinedHi = *lo;
    for (var i = 0u; i < 16u; i++) {
        let t = rbBc6hTexels[i];
        refinedLo = min(refinedLo, select(t, refinedLo, t == *lo));
        refinedHi = max(refinedHi, select(t, refinedHi, t == *hi));
    }
    let logRefinedHi = log2(refinedHi + 1.0);
    let logRefinedLo = log2(refinedLo + 1.0);
    var logHi = log2(*hi + 1.0);
    var logLo = log2(*lo + 1.0);
    let ext = (logHi - logLo) * (1.0 / 32.0);
    logLo += min(logRefinedLo - logLo, ext);
    logHi -= min(logHi - logRefinedHi, ext);
    *lo = exp2(logLo) - 1.0;
    *hi = exp2(logHi) - 1.0;
}

// Least squares ends for the indices the current ones give, in half bits; `subset` 2 takes every texel, as mode 11.
fn rbBc6hOptimize(pattern: u32, subset: u32, lo: ptr<function, vec3f>, hi: ptr<function, vec3f>) -> bool {
    let dir = rbBc6hDirection(*lo, *hi);
    let e0 = rbBc6hF16s(dot(*lo, dir));
    let e1 = rbBc6hF16s(dot(*hi, dir));
    var alphaTexelSum = vec3f(0.0);
    var betaTexelSum = vec3f(0.0);
    var alphaBetaSum = 0.0;
    var alphaSqSum = 0.0;
    var betaSqSum = 0.0;
    for (var i = 0u; i < 16u; i++) {
        if (subset != 2u && rbBc6hPattern(pattern, i) != subset) {
            continue;
        }
        let t = rbBc6hF16s(dot(rbBc6hTexels[i], dir));
        var beta: f32;
        if (subset == 2u) {
            beta = saturate(f32(rbBc6hIndex4(t, e0, e1)) / 15.0);
        } else {
            beta = saturate(f32(rbBc6hIndex3(t, e0, e1)) / 7.0);
        }
        let alpha = 1.0 - beta;
        let texel = rbBc6hF16(rbBc6hTexels[i]);
        alphaTexelSum += alpha * texel;
        betaTexelSum += beta * texel;
        alphaBetaSum += alpha * beta;
        alphaSqSum += alpha * alpha;
        betaSqSum += beta * beta;
    }
    let det = alphaSqSum * betaSqSum - alphaBetaSum * alphaBetaSum;
    if (abs(det) <= 0.00001) {
        return false;
    }
    let detRcp = 1.0 / det;
    *lo = rbBc6hF32(detRcp * (alphaTexelSum * betaSqSum - betaTexelSum * alphaBetaSum));
    *hi = rbBc6hF32(detRcp * (betaTexelSum * alphaSqSum - alphaTexelSum * alphaBetaSum));
    return true;
}

// Mode 11: one line through the block, 10-bit ends, 4-bit indices.
fn rbBc6hEncodeP1(block: ptr<function, vec4u>, blockMsle: ptr<function, f32>) {
    var lo = rbBc6hTexels[0];
    var hi = rbBc6hTexels[0];
    for (var i = 1u; i < 16u; i++) {
        lo = min(lo, rbBc6hTexels[i]);
        hi = max(hi, rbBc6hTexels[i]);
    }
    let loNonInset = lo;
    let hiNonInset = hi;
    rbBc6hInsetP1(&lo, &hi);
    if (rbBc6hOptimize(0u, 2u, &lo, &hi)) {
        lo = clamp(lo, loNonInset, hiNonInset);
        hi = clamp(hi, loNonInset, hiNonInset);
    }

    let dir = rbBc6hDirection(lo, hi);
    var endpoint0 = rbBc6hQuantize(lo, 10.0);
    var endpoint1 = rbBc6hQuantize(hi, 10.0);
    var e0 = rbBc6hF16s(dot(lo, dir));
    var e1 = rbBc6hF16s(dot(hi, dir));

    // The first texel's index has to have its top bit clear.
    if (rbBc6hIndex4(rbBc6hF16s(dot(rbBc6hTexels[0], dir)), e0, e1) > 7u) {
        let e = e0;
        e0 = e1;
        e1 = e;
        let endpoint = endpoint0;
        endpoint0 = endpoint1;
        endpoint1 = endpoint;
    }

    var indices: array<u32, 16>;
    for (var i = 0u; i < 16u; i++) {
        indices[i] = rbBc6hIndex4(rbBc6hF16s(dot(rbBc6hTexels[i], dir)), e0, e1);
    }

    let endpoint0Unq = rbBc6hUnquantize(endpoint0, 10.0);
    let endpoint1Unq = rbBc6hUnquantize(endpoint1, 10.0);
    var msle = 0.0;
    for (var i = 0u; i < 16u; i++) {
        let weight = floor(f32(indices[i]) * 64.0 / 15.0 + 0.5);
        msle += rbBc6hMsle(rbBc6hTexels[i], rbBc6hFinishUnquantize(endpoint0Unq, endpoint1Unq, weight));
    }

    *blockMsle = msle;
    let a = vec3u(endpoint0);
    let b = vec3u(endpoint1);
    var out = vec4u(3u, 0u, 0u, 0u);
    out.x |= (a.x << 5u) | (a.y << 15u) | (a.z << 25u);
    out.y |= (a.z >> 7u) | (b.x << 3u) | (b.y << 13u) | (b.z << 23u);
    out.z |= b.z >> 9u;
    rbBc6hPut(&out, 65u, indices[0]);
    for (var i = 1u; i < 16u; i++) {
        rbBc6hPut(&out, 64u + i * 4u, indices[i]);
    }
    *block = out;
}

fn rbBc6hDistToLineSq(onLine: vec3f, direction: vec3f, p: vec3f) -> f32 {
    let w = p - onLine;
    let x = w - dot(w, direction) * direction;
    return dot(x, x);
}

fn rbBc6hNormalize(v: vec3f) -> vec3f {
    let l = length(v);
    return select(vec3f(0.0), v / l, l > 0.0);
}

/** How well a partition fits the block: the squared distances of the texels from their subset's line. */
fn rbBc6hEvaluateP2(pattern: u32) -> f32 {
    var lo0 = vec3f(RB_BC6H_HALF_MAX);
    var hi0 = vec3f(0.0);
    var lo1 = vec3f(RB_BC6H_HALF_MAX);
    var hi1 = vec3f(0.0);
    for (var i = 0u; i < 16u; i++) {
        let t = rbBc6hTexels[i];
        if (rbBc6hPattern(pattern, i) == 0u) {
            lo0 = min(lo0, t);
            hi0 = max(hi0, t);
        } else {
            lo1 = min(lo1, t);
            hi1 = max(hi1, t);
        }
    }
    let dir0 = rbBc6hNormalize(hi0 - lo0);
    let dir1 = rbBc6hNormalize(hi1 - lo1);
    var distance = 0.0;
    for (var i = 0u; i < 16u; i++) {
        if (rbBc6hPattern(pattern, i) == 0u) {
            distance += rbBc6hDistToLineSq(lo0, dir0, rbBc6hTexels[i]);
        } else {
            distance += rbBc6hDistToLineSq(lo1, dir1, rbBc6hTexels[i]);
        }
    }
    return distance;
}

// Modes 2 (7.6) and 6 (9.5): two lines, a 7- or 9-bit end and deltas from it, 3-bit indices; kept if better than mode 11.
fn rbBc6hEncodeP2(block: ptr<function, vec4u>, blockMsle: ptr<function, f32>, pattern: u32) {
    var lo0 = vec3f(RB_BC6H_HALF_MAX);
    var hi0 = vec3f(0.0);
    var lo1 = vec3f(RB_BC6H_HALF_MAX);
    var hi1 = vec3f(0.0);
    for (var i = 0u; i < 16u; i++) {
        let t = rbBc6hTexels[i];
        if (rbBc6hPattern(pattern, i) == 0u) {
            lo0 = min(lo0, t);
            hi0 = max(hi0, t);
        } else {
            lo1 = min(lo1, t);
            hi1 = max(hi1, t);
        }
    }
    rbBc6hOptimize(pattern, 0u, &lo0, &hi0);
    rbBc6hOptimize(pattern, 1u, &lo1, &hi1);

    let dir0 = rbBc6hDirection(lo0, hi0);
    let dir1 = rbBc6hDirection(lo1, hi1);
    var p0e0 = rbBc6hF16s(dot(lo0, dir0));
    var p0e1 = rbBc6hF16s(dot(hi0, dir0));
    var p1e0 = rbBc6hF16s(dot(lo1, dir1));
    var p1e1 = rbBc6hF16s(dot(hi1, dir1));

    // Each subset's anchor texel has to have its index's top bit clear.
    let fixup = rbBc6hFixup(pattern);
    if (rbBc6hIndex3(rbBc6hF16s(dot(rbBc6hTexels[0], dir0)), p0e0, p0e1) > 3u) {
        let e = p0e0;
        p0e0 = p0e1;
        p0e1 = e;
        let l = lo0;
        lo0 = hi0;
        hi0 = l;
    }
    if (rbBc6hIndex3(rbBc6hF16s(dot(rbBc6hTexels[fixup], dir1)), p1e0, p1e1) > 3u) {
        let e = p1e0;
        p1e0 = p1e1;
        p1e1 = e;
        let l = lo1;
        lo1 = hi1;
        hi1 = l;
    }

    var indices: array<u32, 16>;
    for (var i = 0u; i < 16u; i++) {
        let t = rbBc6hTexels[i];
        if (rbBc6hPattern(pattern, i) == 0u) {
            indices[i] = rbBc6hIndex3(rbBc6hF16s(dot(t, dir0)), p0e0, p0e1);
        } else {
            indices[i] = rbBc6hIndex3(rbBc6hF16s(dot(t, dir1)), p1e0, p1e1);
        }
    }

    let endpoint760 = floor(rbBc6hQuantize(lo0, 7.0));
    var endpoint761 = floor(rbBc6hQuantize(hi0, 7.0)) - endpoint760;
    var endpoint762 = floor(rbBc6hQuantize(lo1, 7.0)) - endpoint760;
    var endpoint763 = floor(rbBc6hQuantize(hi1, 7.0)) - endpoint760;
    let endpoint950 = floor(rbBc6hQuantize(lo0, 9.0));
    var endpoint951 = floor(rbBc6hQuantize(hi0, 9.0)) - endpoint950;
    var endpoint952 = floor(rbBc6hQuantize(lo1, 9.0)) - endpoint950;
    var endpoint953 = floor(rbBc6hQuantize(hi1, 9.0)) - endpoint950;

    endpoint761 = clamp(endpoint761, vec3f(-31.0), vec3f(31.0));
    endpoint762 = clamp(endpoint762, vec3f(-31.0), vec3f(31.0));
    endpoint763 = clamp(endpoint763, vec3f(-31.0), vec3f(31.0));
    endpoint951 = clamp(endpoint951, vec3f(-15.0), vec3f(15.0));
    endpoint952 = clamp(endpoint952, vec3f(-15.0), vec3f(15.0));
    endpoint953 = clamp(endpoint953, vec3f(-15.0), vec3f(15.0));

    let endpoint760Unq = rbBc6hUnquantize(endpoint760, 7.0);
    let endpoint761Unq = rbBc6hUnquantize(endpoint760 + endpoint761, 7.0);
    let endpoint762Unq = rbBc6hUnquantize(endpoint760 + endpoint762, 7.0);
    let endpoint763Unq = rbBc6hUnquantize(endpoint760 + endpoint763, 7.0);
    let endpoint950Unq = rbBc6hUnquantize(endpoint950, 9.0);
    let endpoint951Unq = rbBc6hUnquantize(endpoint950 + endpoint951, 9.0);
    let endpoint952Unq = rbBc6hUnquantize(endpoint950 + endpoint952, 9.0);
    let endpoint953Unq = rbBc6hUnquantize(endpoint950 + endpoint953, 9.0);

    var msle76 = 0.0;
    var msle95 = 0.0;
    for (var i = 0u; i < 16u; i++) {
        let first = rbBc6hPattern(pattern, i) == 0u;
        let weight = floor(f32(indices[i]) * 64.0 / 7.0 + 0.5);
        let unc76 = rbBc6hFinishUnquantize(
            select(endpoint762Unq, endpoint760Unq, first),
            select(endpoint763Unq, endpoint761Unq, first),
            weight,
        );
        let unc95 = rbBc6hFinishUnquantize(
            select(endpoint952Unq, endpoint950Unq, first),
            select(endpoint953Unq, endpoint951Unq, first),
            weight,
        );
        msle76 += rbBc6hMsle(rbBc6hTexels[i], unc76);
        msle95 += rbBc6hMsle(rbBc6hTexels[i], unc95);
    }

    let p2Msle = min(msle76, msle95);
    if (p2Msle >= *blockMsle) {
        return;
    }
    *blockMsle = p2Msle;
    var out = vec4u(0u);
    if (p2Msle == msle76) {
        let e0 = vec3u(endpoint760);
        let e1 = vec3u(rbBc6hSignExtend(endpoint761, 0x1F, 0x20));
        let e2 = vec3u(rbBc6hSignExtend(endpoint762, 0x1F, 0x20));
        let e3 = vec3u(rbBc6hSignExtend(endpoint763, 0x1F, 0x20));
        out.x = 0x1u;
        out.x |= (e2.y & 0x20u) >> 3u;
        out.x |= (e3.y & 0x10u) >> 1u;
        out.x |= (e3.y & 0x20u) >> 1u;
        out.x |= e0.x << 5u;
        out.x |= (e3.z & 0x01u) << 12u;
        out.x |= (e3.z & 0x02u) << 12u;
        out.x |= (e2.z & 0x10u) << 10u;
        out.x |= e0.y << 15u;
        out.x |= (e2.z & 0x20u) << 17u;
        out.x |= (e3.z & 0x04u) << 21u;
        out.x |= (e2.y & 0x10u) << 20u;
        out.x |= e0.z << 25u;
        out.y |= (e3.z & 0x08u) >> 3u;
        out.y |= (e3.z & 0x20u) >> 4u;
        out.y |= (e3.z & 0x10u) >> 2u;
        out.y |= e1.x << 3u;
        out.y |= (e2.y & 0x0Fu) << 9u;
        out.y |= e1.y << 13u;
        out.y |= (e3.y & 0x0Fu) << 19u;
        out.y |= e1.z << 23u;
        out.y |= (e2.z & 0x07u) << 29u;
        out.z |= (e2.z & 0x08u) >> 3u;
        out.z |= e2.x << 1u;
        out.z |= e3.x << 7u;
    } else {
        let e0 = vec3u(endpoint950);
        let e1 = vec3u(rbBc6hSignExtend(endpoint951, 0xF, 0x10));
        let e2 = vec3u(rbBc6hSignExtend(endpoint952, 0xF, 0x10));
        let e3 = vec3u(rbBc6hSignExtend(endpoint953, 0xF, 0x10));
        out.x = 0xEu;
        out.x |= e0.x << 5u;
        out.x |= (e2.z & 0x10u) << 10u;
        out.x |= e0.y << 15u;
        out.x |= (e2.y & 0x10u) << 20u;
        out.x |= e0.z << 25u;
        out.y |= e0.z >> 7u;
        out.y |= (e3.z & 0x10u) >> 2u;
        out.y |= e1.x << 3u;
        out.y |= (e3.y & 0x10u) << 4u;
        out.y |= (e2.y & 0x0Fu) << 9u;
        out.y |= e1.y << 13u;
        out.y |= (e3.z & 0x01u) << 18u;
        out.y |= (e3.y & 0x0Fu) << 19u;
        out.y |= e1.z << 23u;
        out.y |= (e3.z & 0x02u) << 27u;
        out.y |= e2.z << 29u;
        out.z |= (e2.z & 0x08u) >> 3u;
        out.z |= e2.x << 1u;
        out.z |= (e3.z & 0x04u) << 4u;
        out.z |= e3.x << 7u;
        out.z |= (e3.z & 0x08u) << 9u;
    }
    out.z |= pattern << 13u;

    // Indices from bit 82, three bits each but for the two anchors' two.
    var at = 82u;
    for (var i = 0u; i < 16u; i++) {
        rbBc6hPut(&out, at, indices[i]);
        at += select(3u, 2u, i == 0u || i == fixup);
    }
    *block = out;
}

@compute @workgroup_size(8, 8, 1)
fn rbEncodeBc6h(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(rbBc6hSource);
    let blocks = (size + 3u) / 4u;
    if (id.x >= blocks.x || id.y >= blocks.y) {
        return;
    }

    // Row by row, clamped to the edge; BC6H unsigned holds no negative values, nor any above the largest half.
    for (var i = 0u; i < 16u; i++) {
        let texel = textureLoad(rbBc6hSource, min(id.xy * 4u + vec2u(i & 3u, i >> 2u), size - 1u), 0).rgb;
        rbBc6hTexels[i] = clamp(texel, vec3f(0.0), vec3f(RB_BC6H_HALF_MAX));
    }

    var block = vec4u(0u);
    var blockMsle = 0.0;
    rbBc6hEncodeP1(&block, &blockMsle);

    if (RB_BC6H_QUALITY) {
        var bestPattern = 0u;
        var bestScore = rbBc6hEvaluateP2(0u);
        for (var p = 1u; p < 32u; p++) {
            let score = rbBc6hEvaluateP2(p);
            if (score < bestScore) {
                bestPattern = p;
                bestScore = score;
            }
        }
        rbBc6hEncodeP2(&block, &blockMsle, bestPattern);
    }

    // Rows of blocks padded to 256 bytes, 16 blocks of 16, for the copy into the texture.
    let stride = (blocks.x + 15u) / 16u * 16u;
    rbBc6hBlocks[id.y * stride + id.x] = block;
}
