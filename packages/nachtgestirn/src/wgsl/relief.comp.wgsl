// Turns a packed height map into the relief the Moon pass reads, at its full size: the height in km over the mean
// radius, its slopes towards east and north, km per km, from the neighbours, wrapping around in longitude, and the
// height again in alpha, where the smaller levels keep the highest instead of the mean. The
// packed map holds LOLA's 16-bit half meters, offset by 20,000, red the high byte and green the low one. The smaller
// levels are its mean, from `mips.comp.wgsl`. Requires `surface.wgsl` and the output binding from `moonOutput`.

@group(0) @binding(0) var ngHeightSource: texture_2d<f32>;

const NG_HEIGHT_RADIUS_KM: f32 = 1737.4;
// Which part of the whole Moon the map holds, in the whole map's uv: its north edge, and its spans east and south. The
// whole map wraps around in longitude; a strip of it clamps at its edges.
override NG_RELIEF_NORTH: f32 = 0.0;
override NG_RELIEF_SPAN_U: f32 = 1.0;
override NG_RELIEF_SPAN_V: f32 = 1.0;

// The height at a texel of the packed map, in km: wrapped around in longitude for the whole map, clamped for a strip.
fn ngPackedHeight(texel: vec2i, size: vec2i) -> f32 {
    let x = select(clamp(texel.x, 0, size.x - 1), (texel.x + size.x) % size.x, NG_RELIEF_SPAN_U >= 1.0);
    let packed = textureLoad(ngHeightSource, vec2i(x, clamp(texel.y, 0, size.y - 1)), 0);
    let halfMeters = round(packed.r * 255.0) * 256.0 + round(packed.g * 255.0);
    return (halfMeters - 20000.0) * 0.0005;
}

@compute @workgroup_size(8, 8, 1)
fn ngRelief(@builtin(global_invocation_id) id: vec3u) {
    let size = vec2i(textureDimensions(ngHeightSource));
    let texel = vec2i(id.xy);
    if (texel.x >= size.x || texel.y >= size.y) {
        return;
    }

    // How far apart the texel's neighbours lie on the Moon, east to west narrower towards the poles.
    let latitude = (0.5 - NG_RELIEF_NORTH - (f32(texel.y) + 0.5) / f32(size.y) * NG_RELIEF_SPAN_V) * NG_PI;
    let eastKm = 2.0 * NG_PI * NG_HEIGHT_RADIUS_KM * max(cos(latitude), 0.05) * NG_RELIEF_SPAN_U / f32(size.x);
    let northKm = NG_PI * NG_HEIGHT_RADIUS_KM * NG_RELIEF_SPAN_V / f32(size.y);

    // The slopes from the differences across them; rows run south, so north is up the image.
    let east = ngPackedHeight(texel + vec2i(1, 0), size) - ngPackedHeight(texel - vec2i(1, 0), size);
    let north = ngPackedHeight(texel - vec2i(0, 1), size) - ngPackedHeight(texel + vec2i(0, 1), size);

    let height = ngPackedHeight(texel, size);
    ngOutputStore(id.xy, vec4f(height, east / (2.0 * eastKm), north / (2.0 * northKm), height));
}
