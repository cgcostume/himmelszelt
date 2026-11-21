// The ground's grid over a figure's sky: the sky pass draws the ground, this brightens it along the grid's lines, before
// anything else is composed over it. TARGET_FORMAT is the target's format. Requires dunstkreis' `camera.wgsl` and `groundgrid.wgsl`.

struct GridView {
    inverseViewProjection: mat4x4f,
    projectionDistance: f32,
    // The observer's height and the planet's radius, in km, and how much brighter a line makes the ground.
    observer: f32,
    planetRadius: f32,
    strength: f32,
    offsets: array<vec4f, 4>,
}

@group(0) @binding(0) var<uniform> G: GridView;
@group(0) @binding(1) var gridSky: texture_2d<f32>;
@group(0) @binding(2) var gridOut: texture_storage_2d<TARGET_FORMAT, write>;

@compute @workgroup_size(8, 8, 1)
fn groundGrid(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(gridOut);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let sky = textureLoad(gridSky, vec2i(id.xy), 0);
    let lines = gridLines(G.inverseViewProjection, G.projectionDistance, G.observer, G.planetRadius, G.offsets, vec2f(id.xy) + 0.5, size);
    textureStore(gridOut, vec2i(id.xy), vec4f(sky.rgb * (1.0 + G.strength * lines), sky.a));
}
