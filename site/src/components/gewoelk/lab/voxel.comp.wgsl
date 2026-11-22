// The voxel designer's two steps around gewoelk's voxel pass, which composes its clouds over a background itself: the
// sky as exposed, its ground drawn darker as a stage for the patch, and after the pass the tone curve. Requires the
// research prelude.

@group(0) @binding(0) var<uniform> V: LabView;
@group(0) @binding(1) var voxelFrom: texture_2d<f32>;
// What the frame's light is multiplied by before the tone curve, and what the ground's is before the clouds.
struct VoxelFrame {
    dimmed: f32,
    ground: f32,
}
@group(0) @binding(2) var<uniform> voxelFrame: VoxelFrame;
@group(1) @binding(0) var voxelTo: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn voxelStage(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(voxelTo);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    var behind = textureLoad(voxelFrom, vec2i(id.xy), 0).rgb;
    let o = vec3f(0.0, 0.0, V.planetRadius + V.observer);
    if (labSphere(o, labRay(V, vec2f(id.xy) + 0.5, size), V.planetRadius).x > 0.0) {
        behind = behind * voxelFrame.ground;
    }
    textureStore(voxelTo, vec2i(id.xy), vec4f(behind, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn voxelTone(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(voxelTo);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let composed = textureLoad(voxelFrom, vec2i(id.xy), 0).rgb;
    textureStore(voxelTo, vec2i(id.xy), vec4f(hdToneMapNeutralHdr(composed * voxelFrame.dimmed, V.headroom), 1.0));
}
