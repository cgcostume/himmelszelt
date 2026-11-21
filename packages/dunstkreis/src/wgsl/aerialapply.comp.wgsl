// The aerial perspective laid over a rendered scene: every pixel of a color texture seen through the air in front of
// it, as far away as its depth says. Requires `features.wgsl`, `frame.wgsl`, `whitebalance.wgsl` and
// `aerial.wgsl`, plus the output at group 1 from `skyOutput(format)`. A pass, so it declares its bindings.
//
// The color is linear light, white balanced and exposed as the sky pass does its own, with the sky behind the scene.
// Where the depth is still what it was cleared to, nothing was drawn, and the pixel stays as it is: the sky holds all of
// its air already.

@group(0) @binding(0) var<uniform> dkParams: DkSkyParams;
@group(0) @binding(1) var<storage, read> dkMetering: DkMetering;
@group(0) @binding(2) var dkAerialLuminance: texture_3d<f32>;
@group(0) @binding(3) var dkAerialTransmittance: texture_3d<f32>;
@group(0) @binding(4) var dkAerialSampler: sampler;
@group(0) @binding(5) var dkSceneColor: texture_2d<f32>;
@group(0) @binding(6) var dkSceneDepth: texture_depth_2d;

// The depth where nothing was drawn: 1, or 0 for a reversed depth buffer.
override DK_AERIAL_CLEAR_DEPTH: f32 = 1.0;
// Kilometers per unit of the space the matrix projects from: a thousandth for a scene in meters.
override DK_AERIAL_UNIT_KM: f32 = 0.001;

// What the air's light in cd/m² is multiplied by, as the sky pass' dkExposure.
fn dkAerialExposure() -> f32 {
    if (DK_AUTO_EXPOSURE) {
        let range = dkParams.autoExposureRange;
        let metered = dkMetering.log2Luminance + 3.0 - dkParams.exposureCompensation;
        return 1.0 / (1.2 * exp2(clamp(metered, range.x, range.y)));
    }
    return dkParams.exposure;
}

@compute @workgroup_size(8, 8)
fn dkApplyAerialPerspective(@builtin(global_invocation_id) id: vec3u) {
    let size = dkOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let color = textureLoad(dkSceneColor, id.xy, 0);
    let depth = textureLoad(dkSceneDepth, id.xy, 0);
    if (depth == DK_AERIAL_CLEAR_DEPTH) {
        dkOutputStore(id.xy, 0u, color);
        return;
    }
    // The point the pixel shows, from the eye, as dkUnproject finds a pixel's ray: any perspective, reversed or not.
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    let eye = dkParams.inverseViewProjection[2];
    let point = dkParams.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
    let distance = length(point.xyz / point.w - eye.xyz / eye.w) * DK_AERIAL_UNIT_KM;
    let air = dkAerialPerspective(dkAerialLuminance, dkAerialTransmittance, dkAerialSampler, uv, distance);
    dkOutputStore(id.xy, 0u, vec4f(color.rgb * air.transmittance + hdWhiteBalance(air.luminance, dkParams.whiteBalance) * dkAerialExposure(), color.a));
}
