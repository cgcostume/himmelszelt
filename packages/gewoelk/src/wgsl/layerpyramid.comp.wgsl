// The max pyramid of a layer's map for the layered model's adaptive march, filled level by level when the map is baked:
// each texel holds the most that any texel of the level below holds, in its block of them and a ring of one around it,
// channel by channel as `layermap.comp.wgsl` has them. The first level's blocks are two texels of the map across, every
// further level's two of the level below. A block of level n so knows of every cloud within 2^n - 1 of the first level's
// blocks of any point in it, a bilinear read of the map included, and `layers.comp.wgsl` strides that far where the block
// holds none. A map repeats, and so does every level.

// The map, or the level below.
@group(0) @binding(0) var gwLayerPyramidBelow: texture_2d<f32>;
@group(0) @binding(1) var gwLayerPyramidOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn gwLayerPyramid(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(gwLayerPyramidOut);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let below = vec2i(textureDimensions(gwLayerPyramidBelow));
    let block = below / vec2i(size);
    var most = vec4f(0.0);
    for (var j = -1; j <= block.y; j = j + 1) {
        for (var i = -1; i <= block.x; i = i + 1) {
            most = max(most, textureLoad(gwLayerPyramidBelow, (vec2i(id.xy) * block + vec2i(i, j) + below) % below, 0));
        }
    }
    textureStore(gwLayerPyramidOut, vec2i(id.xy), most);
}
