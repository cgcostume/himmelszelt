// Encodes one level of the color map into BC1 blocks, eight bytes for four by four texels, a row of blocks padded to
// 256 bytes for the copy into the texture: two colors in 5:6:5 and two bits a texel for which of the four on the line
// between them. The endpoints are the texels' box along their main direction, inset by a sixteenth of its span (van
// Waveren 2006), the sRGB-encoded values matched as they are. Needs nothing else.

@group(0) @binding(0) var ngBlockSource: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> ngBlocks: array<vec2u>;

fn ngPack565(c: vec3f) -> u32 {
    let q = vec3u(round(saturate(c) * vec3f(31.0, 63.0, 31.0)));
    return (q.r << 11u) | (q.g << 5u) | q.b;
}

fn ngUnpack565(v: u32) -> vec3f {
    return vec3f(f32((v >> 11u) & 31u) / 31.0, f32((v >> 5u) & 63u) / 63.0, f32(v & 31u) / 31.0);
}

@compute @workgroup_size(8, 8, 1)
fn ngEncodeBc1(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(ngBlockSource);
    let blocks = (size + 3u) / 4u;
    if (id.x >= blocks.x || id.y >= blocks.y) {
        return;
    }
    let stride = (blocks.x * 8u + 255u) / 256u * 32u;
    var texels: array<vec3f, 16>;
    var lo = vec3f(1.0);
    var hi = vec3f(0.0);
    var mean = vec3f(0.0);
    for (var i = 0u; i < 16u; i = i + 1u) {
        let t = textureLoad(ngBlockSource, min(id.xy * 4u + vec2u(i & 3u, i >> 2u), size - 1u), 0).rgb;
        texels[i] = t;
        lo = min(lo, t);
        hi = max(hi, t);
        mean = mean + t / 16.0;
    }
    // The box's diagonal turned to follow the texels: red or blue falling as green rises runs the other way.
    var along = vec3f(0.0);
    for (var i = 0u; i < 16u; i = i + 1u) {
        let d = texels[i] - mean;
        along = along + d * d.g;
    }
    var a = hi;
    var b = lo;
    if (along.r < 0.0) {
        a.r = lo.r;
        b.r = hi.r;
    }
    if (along.b < 0.0) {
        a.b = lo.b;
        b.b = hi.b;
    }
    let inset = (a - b) / 16.0;
    var c0 = ngPack565(a - inset);
    var c1 = ngPack565(b + inset);
    // The first color the larger, for the four-color mode.
    if (c0 < c1) {
        let swap = c0;
        c0 = c1;
        c1 = swap;
    }
    let at = id.y * stride + id.x;
    if (c0 == c1) {
        ngBlocks[at] = vec2u(c0 | (c1 << 16u), 0u);
        return;
    }
    let e0 = ngUnpack565(c0);
    let e1 = ngUnpack565(c1);
    let palette = array<vec3f, 4>(e0, e1, mix(e0, e1, 1.0 / 3.0), mix(e0, e1, 2.0 / 3.0));
    var indices = 0u;
    for (var i = 0u; i < 16u; i = i + 1u) {
        var best = 0u;
        var nearest = 1e9;
        for (var k = 0u; k < 4u; k = k + 1u) {
            let d = texels[i] - palette[k];
            let distance = dot(d, d);
            if (distance < nearest) {
                nearest = distance;
                best = k;
            }
        }
        indices = indices | (best << (2u * i));
    }
    ngBlocks[at] = vec2u(c0 | (c1 << 16u), indices);
}
