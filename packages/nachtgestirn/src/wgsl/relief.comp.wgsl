// Turns a packed height map into the relief the Moon pass reads, at its full size: the height in km over the mean
// radius, and its slopes towards east and north, km per km, from the neighbours, wrapping around in longitude. The
// packed map holds LOLA's 16-bit half meters, offset by 20,000, red the high byte and green the low one. The smaller
// levels are its mean, from `mips.comp.wgsl`. Requires `params.wgsl`, `surface.wgsl` and the output binding from
// `moonOutput`.

@group(0) @binding(0) var nbHeightSource: texture_2d<f32>;

const NB_HEIGHT_RADIUS_KM: f32 = 1737.4;

fn nbHeightAt(texel: vec2i, size: vec2i) -> f32 {
    let at = vec2i((texel.x + size.x) % size.x, clamp(texel.y, 0, size.y - 1));
    let t = textureLoad(nbHeightSource, at, 0);
    let v = round(t.r * 255.0) * 256.0 + round(t.g * 255.0);
    return (v - 20000.0) * 0.0005;
}

@compute @workgroup_size(8, 8, 1)
fn nbRelief(@builtin(global_invocation_id) id: vec3u) {
    let size = vec2i(textureDimensions(nbHeightSource));
    let p = vec2i(id.xy);
    if (p.x >= size.x || p.y >= size.y) {
        return;
    }
    let latitude = (0.5 - (f32(p.y) + 0.5) / f32(size.y)) * NB_PI;
    let eastKm = 2.0 * NB_PI * NB_HEIGHT_RADIUS_KM * max(cos(latitude), 0.05) / f32(size.x);
    let northKm = NB_PI * NB_HEIGHT_RADIUS_KM / f32(size.y);
    let east = nbHeightAt(p + vec2i(1, 0), size) - nbHeightAt(p - vec2i(1, 0), size);
    // Rows run south, so north is up the image.
    let north = nbHeightAt(p - vec2i(0, 1), size) - nbHeightAt(p + vec2i(0, 1), size);
    nbOutputStore(id.xy, vec4f(nbHeightAt(p, size), east / (2.0 * eastKm), north / (2.0 * northKm), 0.0));
}
