// Nubis3's voxel lighting: for every cloud voxel, the density summed along a ray to the sun, to the sky above and to the
// ground below, out to the volume's top or bottom, stored once per sun rather than marched per pixel and step. The
// profile is the density here, smooth and cheap; the march adds two detailed samples next to each point.
// Requires `params.wgsl`.

@group(0) @binding(0) var<uniform> gwParams: GwParams;
@group(0) @binding(1) var gwModeling: texture_3d<f32>;
@group(0) @binding(2) var gwVolumeSampler: sampler;
@group(0) @binding(3) var gwLightOut: texture_storage_3d<rgba16float, write>;

override GW_LIGHT_STEPS: u32 = 48u;

// The optical length of full density along `direction` from `start`, both in the volume's unit cube, to its top or
// bottom, in km times density.
fn gwSummedDensity(start: vec3f, direction: vec3f) -> f32 {
    let volume = gwParams.cloudscape;
    let dz = direction.z;
    if (abs(dz) < 1e-4) {
        return 0.0;
    }
    // To the face the ray leaves through, in unit-cube z, and in km along the ray.
    let span = select(start.z, 1.0 - start.z, dz > 0.0) / abs(dz);
    let km = span * length(direction * vec3f(volume.extent, volume.extent, volume.height));
    let step = span / f32(GW_LIGHT_STEPS);
    var sum = 0.0;
    for (var i = 0u; i < GW_LIGHT_STEPS; i = i + 1u) {
        let at = start + direction * (f32(i) + 0.5) * step;
        let m = textureSampleLevel(gwModeling, gwVolumeSampler, vec3f(fract(at.xy), at.z), 0.0);
        sum = sum + m.r * m.b;
    }
    return sum * km / f32(GW_LIGHT_STEPS);
}

@compute @workgroup_size(4, 4, 4)
fn gwLight(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(gwLightOut);
    if (any(id >= size)) {
        return;
    }
    let at = (vec3f(id) + 0.5) / vec3f(size);
    let m = textureLoad(gwModeling, vec3i(id), 0);
    if (m.r <= 0.0) {
        textureStore(gwLightOut, vec3i(id), vec4f(0.0));
        return;
    }
    let volume = gwParams.cloudscape;
    // The sun's direction in the unit cube: km per axis differ.
    let sun = gwParams.sunDirection / vec3f(volume.extent, volume.extent, volume.height);
    // From below as well, around sunset; never quite level, where the sum would never end.
    let toSun = normalize(vec3f(sun.xy, select(sun.z, 0.03 * sign(sun.z + 1e-6), abs(sun.z) < 0.03)));
    let summed = vec3f(
        gwSummedDensity(at, toSun),
        gwSummedDensity(at, vec3f(0.0, 0.0, 1.0)),
        gwSummedDensity(at, vec3f(0.0, 0.0, -1.0)),
    );
    textureStore(gwLightOut, vec3i(id), vec4f(summed, 0.0));
}
