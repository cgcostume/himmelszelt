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

    // The block's sixteen texels, their box and their mean.
    var texels: array<vec3f, 16>;
    var low = vec3f(1.0);
    var high = vec3f(0.0);
    var mean = vec3f(0.0);
    for (var i = 0u; i < 16u; i = i + 1u) {
        let texel = textureLoad(ngBlockSource, min(id.xy * 4u + vec2u(i & 3u, i >> 2u), size - 1u), 0).rgb;
        texels[i] = texel;
        low = min(low, texel);
        high = max(high, texel);
        mean = mean + texel / 16.0;
    }

    // The box's diagonal turned to follow the texels: red or blue falling as green rises runs the other way.
    var withGreen = vec3f(0.0);
    for (var i = 0u; i < 16u; i = i + 1u) {
        let offset = texels[i] - mean;
        withGreen = withGreen + offset * offset.g;
    }
    var first = high;
    var second = low;
    if (withGreen.r < 0.0) {
        first.r = low.r;
        second.r = high.r;
    }
    if (withGreen.b < 0.0) {
        first.b = low.b;
        second.b = high.b;
    }

    // Its ends, inset by a sixteenth, in 5:6:5: the larger first, for the four-color mode.
    let inset = (first - second) / 16.0;
    var color0 = ngPack565(first - inset);
    var color1 = ngPack565(second + inset);
    if (color0 < color1) {
        let swap = color0;
        color0 = color1;
        color1 = swap;
    }
    // Rows of blocks padded to 256 bytes, 32 blocks of 8, for the copy into the texture.
    let stride = (blocks.x * 8u + 255u) / 256u * 32u;
    let block = id.y * stride + id.x;
    let ends = color0 | (color1 << 16u);
    if (color0 == color1) {
        ngBlocks[block] = vec2u(ends, 0u);
        return;
    }

    // Each texel the nearest of the four colors on the line between the ends, two bits each.
    let end0 = ngUnpack565(color0);
    let end1 = ngUnpack565(color1);
    let palette = array<vec3f, 4>(end0, end1, mix(end0, end1, 1.0 / 3.0), mix(end0, end1, 2.0 / 3.0));
    var indices = 0u;
    for (var i = 0u; i < 16u; i = i + 1u) {
        var best = 0u;
        var nearest = 1e9;
        for (var k = 0u; k < 4u; k = k + 1u) {
            let offset = texels[i] - palette[k];
            let distance = dot(offset, offset);
            if (distance < nearest) {
                nearest = distance;
                best = k;
            }
        }
        indices = indices | (best << (2u * i));
    }
    ngBlocks[block] = vec2u(ends, indices);
}
