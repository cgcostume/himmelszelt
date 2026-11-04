// Nubis3's voxel lighting: for every cloud voxel, the density summed along a ray to the sun, stored once per sun rather
// than marched per pixel and step, and how much of the sky's and the ground's light gets through, once per cloudscape. The profile
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
@group(0) @binding(6) var gwAmbientOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(7) var gwLightIn: texture_3d<f32>;
@group(0) @binding(8) var gwAmbientIn: texture_3d<f32>;
@group(0) @binding(9) var<storage, read_write> gwDeckOut: array<f32>;

// Steps towards the sun, each this much longer than the one before: a voxel's height first, 400 km after 64.
override GW_LIGHT_STEPS: u32 = 64u;
const GW_LIGHT_GROWTH: f32 = 1.105;

var<workgroup> gwPartial: array<f32, 256>;
var<workgroup> gwPartialSky: array<f32, 256>;

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

// How much of the sky's light and of the ground's reaches a voxel through the clouds: each hemisphere's cosine-weighted
// share on a ring of rays 60° and one 30° off the local horizon, up and down, each diffused as gwDiffused has it. A wall
// under an overhang sees the sky beside it, not only the cloud above. Once per cloudscape and density.
@compute @workgroup_size(4, 4, 4)
fn gwAmbient(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(gwAmbientOut);
    if (any(id >= size)) {
        return;
    }
    let volume = gwParams.cloudscape;
    let at = (vec3f(id) + 0.5) / vec3f(size);
    var open = vec2f(0.0);
    for (var ring = 0u; ring < 2u; ring = ring + 1u) {
        // Each ring stands for half the cosine-weighted hemisphere, its rays offset from the other's.
        let elevation = select(radians(30.0), radians(60.0), ring == 0u);
        let count = 4u + 2u * ring;
        for (var k = 0u; k < count; k = k + 1u) {
            let azimuth = 2.0 * GW_PI * (f32(k) + 0.5 * f32(ring)) / f32(count);
            let heading = vec2f(sin(azimuth), cos(azimuth));
            let up = gwDiffused(volume.extinction * gwSummedToSun(at, heading, elevation), volume.forwardG);
            let down = gwDiffused(volume.extinction * gwSummedToSun(at, heading, -elevation), volume.forwardG);
            open = open + vec2f(up, down) * 0.5 / f32(count);
        }
    }
    textureStore(gwAmbientOut, vec3i(id), vec4f(open, 0.0, 0.0));
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

// What the deck lets through to the ground on average, over its base: of the sun's light at the observer's elevation,
// and of the sky's from the ambient grid's bottom layer, both diffused as gwDiffused has it. The light it leaves the clouds' undersides.
@compute @workgroup_size(256, 1, 1)
fn gwDeck(@builtin(local_invocation_index) index: u32) {
    let volume = gwParams.cloudscape;
    let size = textureDimensions(gwLightIn);
    let span = volume.lightElevations;
    let elevation = asin(clamp(normalize(gwParams.sunDirection).z, -1.0, 1.0));
    let slice = clamp((elevation - span.x) / max(span.y - span.x, 1e-6), 0.0, 1.0) * 3.0;
    let weights = max(1.0 - abs(slice - vec4f(0.0, 1.0, 2.0, 3.0)), vec4f(0.0));
    var sun = 0.0;
    var sky = 0.0;
    for (var i = index; i < size.x * size.y; i = i + 256u) {
        let at = vec3u(i % size.x, i / size.x, 0u);
        sun = sun + gwDiffused(volume.extinction * dot(textureLoad(gwLightIn, at, 0), weights), volume.forwardG);
        sky = sky + textureLoad(gwAmbientIn, at * textureDimensions(gwAmbientIn) / size, 0).r;
    }
    gwPartial[index] = sun;
    gwPartialSky[index] = sky;
    workgroupBarrier();
    for (var stride = 128u; stride > 0u; stride = stride >> 1u) {
        if (index < stride) {
            gwPartial[index] = gwPartial[index] + gwPartial[index + stride];
            gwPartialSky[index] = gwPartialSky[index] + gwPartialSky[index + stride];
        }
        workgroupBarrier();
    }
    if (index == 0u) {
        gwDeckOut[0] = gwPartial[0] / f32(size.x * size.y);
        gwDeckOut[1] = gwPartialSky[0] / f32(size.x * size.y);
    }
}
