// The ground's grid over a sky: the sky pass draws the ground, this brightens it along the grid's lines, before anything
// else is composed over it. Requires `camera.wgsl`, `groundgrid.wgsl` and the output binding `dkGroundGridOutput`,
// group 1, binding 0, a write-only storage texture of the target's format.

struct DkGroundGridView {
    inverseViewProjection: mat4x4f,
    projectionDistance: f32,
    // The observer's height and the planet's radius, in km, and how much brighter a line makes the ground.
    observer: f32,
    planetRadius: f32,
    strength: f32,
    offsets: array<vec4f, 4>,
}

@group(0) @binding(0) var<uniform> dkGroundGridView: DkGroundGridView;
@group(0) @binding(1) var dkGroundGridSky: texture_2d<f32>;

@compute @workgroup_size(8, 8, 1)
fn dkGroundGridPass(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(dkGroundGridOutput);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let sky = textureLoad(dkGroundGridSky, vec2i(id.xy), 0);
    let lines = dkGroundGrid(
        dkGroundGridView.inverseViewProjection,
        dkGroundGridView.projectionDistance,
        dkGroundGridView.observer,
        dkGroundGridView.planetRadius,
        dkGroundGridView.offsets,
        vec2f(id.xy) + 0.5,
        size,
    );
    textureStore(dkGroundGridOutput, vec2i(id.xy), vec4f(sky.rgb * (1.0 + dkGroundGridView.strength * lines), sky.a));
}
