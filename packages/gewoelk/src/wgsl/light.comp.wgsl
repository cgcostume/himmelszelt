// Nubis3's voxel lighting: for every cloud voxel, the density summed along a ray to the sun, stored once per sun rather
// than marched per pixel and step, and to the sky above and the ground below, stored once per cloudscape. The profile
// is the density here, smooth and cheap; the march adds two detailed samples next to each point.
//
// The slab is a shell around the planet, so the sun stands higher over clouds towards it and lower over clouds away
// from it, by a degree every 111 km: four slices of the sun's light hold four elevations above the local horizon,
// which the march interpolates between. Their rays run straight through the curved slab, out of its top or its base.
// Requires `params.wgsl`.

@group(0) @binding(0) var<uniform> gwParams: GwParams;
@group(0) @binding(1) var gwModeling: texture_3d<f32>;
@group(0) @binding(2) var gwVolumeSampler: sampler;
@group(0) @binding(3) var gwLightOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(4) var<storage, read_write> gwCoverageOut: array<f32>;
@group(0) @binding(5) var<storage, read> gwCoverage: array<f32>;
@group(0) @binding(6) var gwAmbientOut: texture_storage_3d<rgba8unorm, write>;

// Steps towards the sun, each this much longer than the one before: a voxel's height first, 400 km after 64.
override GW_LIGHT_STEPS: u32 = 64u;
const GW_LIGHT_GROWTH: f32 = 1.105;
override GW_AMBIENT_STEPS: u32 = 32u;

var<workgroup> gwPartial: array<f32, 256>;

// The mean density of each layer of voxels, which far steps towards the sun take instead of one voxel's.
@compute @workgroup_size(256, 1, 1)
fn gwCoverageMean(@builtin(local_invocation_index) index: u32, @builtin(workgroup_id) layer: vec3u) {
    let size = textureDimensions(gwModeling);
    var sum = 0.0;
    for (var i = index; i < size.x * size.y; i = i + 256u) {
        let m = textureLoad(gwModeling, vec3u(i % size.x, i / size.x, layer.x), 0);
        sum = sum + m.r * m.b;
    }
    gwPartial[index] = sum;
    workgroupBarrier();
    for (var stride = 128u; stride > 0u; stride = stride >> 1u) {
        if (index < stride) {
            gwPartial[index] = gwPartial[index] + gwPartial[index + stride];
        }
        workgroupBarrier();
    }
    if (index == 0u) {
        gwCoverageOut[layer.x] = gwPartial[0] / f32(size.x * size.y);
    }
}

// The density summed straight up or down from `start` to the slab's top or bottom, over the slab's height.
fn gwSummedVertical(start: vec3f, up: bool) -> f32 {
    let span = select(start.z, 1.0 - start.z, up);
    var sum = 0.0;
    for (var i = 0u; i < GW_AMBIENT_STEPS; i = i + 1u) {
        let along = (f32(i) + 0.5) / f32(GW_AMBIENT_STEPS) * span;
        let m = textureSampleLevel(gwModeling, gwVolumeSampler, vec3f(start.xy, start.z + select(-along, along, up)), 0.0);
        sum = sum + m.r * m.b;
    }
    return sum * span / f32(GW_AMBIENT_STEPS);
}

@compute @workgroup_size(4, 4, 4)
fn gwAmbient(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(gwAmbientOut);
    if (any(id >= size)) {
        return;
    }
    let at = (vec3f(id) + 0.5) / vec3f(size);
    textureStore(gwAmbientOut, vec3i(id), vec4f(gwSummedVertical(at, true), gwSummedVertical(at, false), 0.0, 0.0));
}

// The density summed from `start` in the unit cube towards the sun, `heading` east and north, at `elevation` above the
// local horizon: in km times density, near voxels read one by one, far stretches by their layer's mean.
fn gwSummedToSun(start: vec3f, heading: vec2f, elevation: f32) -> f32 {
    let volume = gwParams.cloudscape;
    let ground = gwParams.planetRadius;
    let size = textureDimensions(gwModeling);
    let r0 = ground + volume.base + start.z * volume.height;
    let rise = sin(elevation);
    let run = cos(elevation);
    let cell = volume.extent / f32(size.x);
    var s = 0.0;
    var step = volume.height / f32(size.z);
    var sum = 0.0;
    for (var i = 0u; i < GW_LIGHT_STEPS; i = i + 1u) {
        let mid = s + 0.5 * step;
        let vertical = r0 + mid * rise;
        let across = mid * run;
        let r = sqrt(vertical * vertical + across * across);
        if (r < ground) {
            break;
        }
        // Past the clearing, the way to the sun is clear: the farthest a voxel in sight can lie from its edge.
        if (volume.clearing > 0.0 && ground * atan2(across, vertical) > volume.clearing) {
            break;
        }
        let z = (r - ground - volume.base) / volume.height;
        // Out of the top, or out of the base towards a sun below the local horizon, whose light then arrives under
        // the deck: the deck does not reach on past the horizon for it, as real ones end somewhere.
        if ((z > 1.0 && vertical * rise + across * run > 0.0) || z < 0.0) {
            break;
        }
        if (z >= 0.0 && z <= 1.0) {
            let shift = heading * ground * atan2(across, vertical) / volume.extent;
            let m = textureSampleLevel(gwModeling, gwVolumeSampler, vec3f(fract(start.xy + shift), z), 0.0);
            let mean = gwCoverage[min(u32(z * f32(size.z)), size.z - 1u)];
            sum = sum + mix(mean, m.r * m.b, clamp(2.0 * cell / step, 0.0, 1.0)) * step;
        }
        s = s + step;
        step = step * GW_LIGHT_GROWTH;
    }
    return sum;
}

@compute @workgroup_size(4, 4, 4)
fn gwLight(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(gwLightOut);
    if (any(id >= size)) {
        return;
    }
    // Every voxel, cloud or not: the air under the deck is shaded by it too.
    let at = (vec3f(id) + 0.5) / vec3f(size);
    let sun = gwParams.sunDirection;
    let heading = select(vec2f(0.0, 1.0), normalize(sun.xy), length(sun.xy) > 1e-6);
    let span = gwParams.cloudscape.lightElevations;
    var summed = vec4f(0.0);
    for (var k = 0u; k < 4u; k = k + 1u) {
        summed[k] = gwSummedToSun(at, heading, mix(span.x, span.y, f32(k) / 3.0));
    }
    textureStore(gwLightOut, vec3i(id), summed);
}
