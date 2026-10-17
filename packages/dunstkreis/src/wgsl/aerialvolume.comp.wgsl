// Hillaire's aerial perspective volume, recomputed whenever the camera, the sun or the observer moves. Requires
// `atmosphere.wgsl`, `common.wgsl`, `lut.wgsl`, `sampling.wgsl`, `raymarch.wgsl`, `frame.wgsl` and `aerial.wgsl`. A
// pass, so it declares its bindings.
//
// One invocation per column of froxels, 32x32 by default: it marches its ray once from the camera out to the last
// slice, as dkRaymarchAerialPerspective would, and stores the light and the transmittance so far at each slice's center
// on the way. Each froxel marched on its own, as Hillaire does, would retrace the slices before it, some 8 times the
// steps for the same result, and with fewer of them, noisier from slice to slice.

@group(0) @binding(0) var<uniform> dkAtmosphere: DkAtmosphere;
@group(0) @binding(1) var<uniform> dkParams: DkSkyParams;
@group(0) @binding(2) var dkTransmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var dkMultiScatteringLut: texture_2d<f32>;
@group(0) @binding(4) var dkLutSampler: sampler;
// Luminance at the four wavelengths times skyViewScale, as the sky-view table; transmittance at the four wavelengths.
@group(0) @binding(5) var dkAerialLuminanceOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(6) var dkAerialTransmittanceOut: texture_storage_3d<rgba16float, write>;

// How far the last slice reaches, in km: 32 by Hillaire's account, enough for mountains on the horizon.
override DK_AERIAL_PERSPECTIVE_DISTANCE: f32 = 32.0;

// Steps per slice: the slices grow with the distance, the last of 32 slices some 2 km deep, so 0.5 km steps, of the
// aerosols' scale height.
const DK_AERIAL_PERSPECTIVE_STEPS: u32 = 4u;

// The ray through the center of a froxel column, as the camera's own projection would put it, without dkProjectRay's
// fisheye: geometry is drawn with the matrix alone.
fn dkFroxelRay(uv: vec2f) -> vec3f {
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let eye = dkParams.inverseViewProjection[2];
    let point = dkParams.inverseViewProjection * vec4f(ndc, 0.5, 1.0);
    return normalize(point.xyz / point.w - eye.xyz / eye.w);
}

fn dkStoreFroxel(texel: vec3u, ray: DkSkyRay) {
    let luminance = min(ray.luminance * dkParams.skyViewScale, vec4f(65504.0));
    textureStore(dkAerialLuminanceOut, texel, luminance);
    textureStore(dkAerialTransmittanceOut, texel, ray.transmittance);
}

@compute @workgroup_size(8, 8)
fn dkPrecomputeAerialPerspective(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(dkAerialLuminanceOut);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let a = dkAtmosphere;
    let top = a.Rt - a.Rg;
    let direction = dkFroxelRay((vec2f(id.xy) + 0.5) / vec2f(size.xy));
    let sunDirection = dkParams.sunDirection;

    var ray = DkSkyRay(vec4f(0.0), vec4f(1.0), direction, false, vec3f(0.0, 0.0, 1.0));
    // From where the ray enters the atmosphere, for an observer above it; nothing in the way of a point short of that.
    var up = vec3f(0.0, 0.0, 1.0);
    var h = max(dkParams.observerAltitude, 0.0);
    var offset = 0.0;
    if (h > top) {
        let entry = dkAtmosphereEntry(a, h, direction);
        if (entry.w < 0.0) {
            for (var z = 0u; z < size.z; z = z + 1u) {
                dkStoreFroxel(vec3u(id.xy, z), ray);
            }
            return;
        }
        up = entry.xyz;
        h = top;
        offset = entry.w;
    }

    let horizontal = dkPathHorizontal(up, direction);
    let mu = clamp(dot(direction, up), -1.0, 1.0);
    let hitsGround = dkIntersectsGround(a, h, mu);
    var path = dkPathStart(mu);
    // Where the straight ray leaves the atmosphere or meets the ground; the bent one aims anew at every step.
    let end = dkPathRemaining(a, h, path, hitsGround);
    var traveled = 0.0;
    for (var z = 0u; z < size.z; z = z + 1u) {
        let slice = dkAerialPerspectiveSliceDistance(z, size.z, DK_AERIAL_PERSPECTIVE_DISTANCE) - offset;
        for (var i = 0u; i < DK_AERIAL_PERSPECTIVE_STEPS; i = i + 1u) {
            var left = end - traveled;
            if (DK_REFRACTION) {
                left = dkPathRemaining(a, h, path, hitsGround);
            }
            let ds = max(min(slice - traveled, left), 0.0) / f32(DK_AERIAL_PERSPECTIVE_STEPS - i);
            traveled += ds;
            path = dkRaymarchStep(
                dkAtmosphere, dkTransmittanceLut, dkMultiScatteringLut, dkLutSampler, up, horizontal, h, sunDirection,
                path, ds, &ray,
            );
        }
        dkStoreFroxel(vec3u(id.xy, z), ray);
    }
}
