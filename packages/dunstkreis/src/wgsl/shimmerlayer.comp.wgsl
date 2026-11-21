// The shimmer as a pass of its own: a linear layer in, the same layer as the air shows it out, for whatever draws
// over it next. Requires `camera.wgsl`, `air.wgsl`, `seeing.wgsl`, `shimmer.wgsl` and the output binding for the
// target's format, `dkShimmerOutput`.

struct DkShimmerParams {
    inverseViewProjection: mat4x4f,
    shimmer: DkShimmer,
    seeing: DkSeeing,
    projectionDistance: f32,
}

@group(0) @binding(0) var<uniform> dkShimmerParams: DkShimmerParams;
@group(0) @binding(1) var dkShimmerSource: texture_2d<f32>;
@group(0) @binding(2) var dkShimmerSampler: sampler;
@group(0) @binding(3) var dkShimmerAir: texture_2d<f32>;

// The ray through a point of the target, in pixels from its top left corner.
fn dkShimmerRay(position: vec2f, size: vec2u) -> vec3f {
    let uv = position / vec2f(size);
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let bent = clamp(dkShimmerParams.projectionDistance, 0.0, 1.0);
    return dkProjectRay(dkShimmerParams.inverseViewProjection, ndc, bent);
}

@compute @workgroup_size(8, 8, 1)
fn dkShimmerLayerPass(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(dkShimmerOutput);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let pixel = vec2f(id.xy) + 0.5;
    let ray = dkShimmerRay(pixel, size);
    let across = dkShimmerRay(pixel + vec2f(1.0, 0.0), size) - ray;
    let down = dkShimmerRay(pixel + vec2f(0.0, 1.0), size) - ray;
    let shimmered = dkShimmerLayer(
        dkShimmerSource,
        dkShimmerSampler,
        dkShimmerAir,
        dkShimmerParams.seeing,
        dkShimmerParams.shimmer,
        pixel,
        ray,
        across,
        down,
    );
    textureStore(dkShimmerOutput, vec2i(id.xy), shimmered);
}
