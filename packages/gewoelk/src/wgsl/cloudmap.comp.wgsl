// The cloud map: the thesis' two-dimensional field, its value read as a height, from which the cloudscape is voxelized
// and a sheet is read directly. One layer of the map array per model. Requires `noise.wgsl` and `params.wgsl`.
//
// Octaves of gradient noise, summed as osgHimmel's HighCloudLayerGeode did, then shaped: what lies below 1 - coverage
// is sky, the rest stretched to [0, 1] and raised to 1 - sharpness, so the edges harden as sharpness grows. The green
// channel keeps a second field of the same kind, which decides between wispy and billowy detail; the alpha channel a
// third, broader one, shaped by the towers' coverage, where clouds grow tall.

@group(0) @binding(0) var<uniform> gwModel: GwModel;
@group(0) @binding(1) var gwMapOut: texture_storage_2d_array<rgba16float, write>;

fn gwShape(n: f32, coverage: f32, sharpness: f32) -> f32 {
    if (coverage <= 0.0) {
        return 0.0;
    }
    let c = coverage;
    let lifted = clamp((n - (1.0 - c)) / c, 0.0, 1.0);
    return pow(lifted, max(1.0 - sharpness, 0.05));
}

@compute @workgroup_size(8, 8, 1)
fn gwCloudMap(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(gwMapOut);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    let cells = i32(gwModel.cells);
    // Evolution wraps every 8 lattice cells of the first octave, so the map loops and f32 never drifts.
    let period = vec3i(cells, cells, 8);
    let p = vec3f(uv * f32(cells), gwModel.evolution);
    // The octaves' sum crowds around the middle: stretched, so the coverage means about that share of the sky, softly,
    // never to 1, so no plateau stays cloud at the least coverage.
    let n = 0.5 + 0.5 * tanh((gwFbm(p, period, gwModel.octaves, gwModel.seed) - 0.5) * 4.8);
    let kind = gwFbm(p * 0.5 + vec3f(3.7, 1.3, 0.0), max(period / 2, vec3i(1)), 3u, gwModel.seed + 977u);
    let shaped = gwShape(n, gwModel.coverage, gwModel.sharpness);
    let tall = gwFbm(p * 0.5 + vec3f(1.9, 6.1, 0.0), max(period / 2, vec3i(1)), 3u, gwModel.seed + 1777u);
    let tower = gwShape(0.5 + 0.5 * tanh((tall - 0.5) * 4.8), gwModel.towers, 0.3);
    textureStore(gwMapOut, vec2i(id.xy), i32(gwModel.layer), vec4f(shaped, kind, n, tower));
}
