// The cloudscape voxelized from its cloud map, and its signed distance field by jump flooding, into one texture of
// modeling data, as Nubis3's NVDFs hold it: the dimensional profile, the detail type, the density scale, and the
// distance outside, in `GW_SDF_RANGE` km over 8 bits, rounded down so a step never overshoots. Requires `params.wgsl`.
//
// A voxel is cloud where its height lies within the column the map's value spans: bottoms dip below the base level by
// the offset times the value, tops rise by the rest of it, as the thesis' DubeCloudLayer did. The grid wraps east and
// north, like the map, so the flood and the distances wrap too; above and below it is sky.

@group(0) @binding(0) var<uniform> gwModel: GwModel;
@group(0) @binding(1) var gwMap: texture_2d_array<f32>;
@group(0) @binding(2) var gwMapSampler: sampler;
@group(0) @binding(3) var gwFloodIn: texture_3d<u32>;
@group(0) @binding(4) var gwFloodOut: texture_storage_3d<r32uint, write>;
@group(0) @binding(5) var<uniform> gwFloodStep: vec4u;
@group(0) @binding(6) var<uniform> gwVolume: GwCloudscape;
@group(0) @binding(7) var gwModelingOut: texture_storage_3d<rgba8unorm, write>;

const GW_NO_SEED: u32 = 0xFFFFFFFFu;

fn gwPack(v: vec3u) -> u32 {
    return v.x | (v.y << 10u) | (v.z << 20u);
}

fn gwUnpack(packed: u32) -> vec3u {
    return vec3u(packed & 1023u, (packed >> 10u) & 1023u, (packed >> 20u) & 1023u);
}

// The map's value over a voxel column, and whether the voxel at `z` of `depth` is cloud.
fn gwColumn(cell: vec2u, size: vec2u) -> vec4f {
    let uv = (vec2f(cell) + 0.5) / vec2f(size);
    return textureSampleLevel(gwMap, gwMapSampler, uv, i32(gwModel.layer), 0.0);
}

fn gwInside(n: f32, z: u32, depth: u32) -> bool {
    if (n < 0.02) {
        return false;
    }
    let u = (f32(z) + 0.5) / f32(depth);
    let o = clamp(gwModel.offset, 0.0, 0.9);
    let lo = o * (1.0 - n);
    let hi = o + n * (1.0 - o);
    return u > lo && u < hi;
}

// Seeds the flood: a cloud voxel with sky next to it carries its own position, every other voxel none.
@compute @workgroup_size(4, 4, 4)
fn gwFloodInit(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(gwFloodOut);
    if (any(id >= size)) {
        return;
    }
    let n = gwColumn(id.xy, size.xy).r;
    var seed = GW_NO_SEED;
    if (gwInside(n, id.z, size.z)) {
        var surface = false;
        for (var k = 0u; k < 6u; k = k + 1u) {
            let axis = k / 2u;
            let sign = select(-1, 1, (k & 1u) == 1u);
            var at = vec3i(id);
            at[axis] = at[axis] + sign;
            if (at.z < 0 || at.z >= i32(size.z)) {
                surface = true;
                continue;
            }
            let wrapped = vec2u((at.xy + vec2i(size.xy)) % vec2i(size.xy));
            if (!gwInside(gwColumn(wrapped, size.xy).r, u32(at.z), size.z)) {
                surface = true;
            }
        }
        if (surface) {
            seed = gwPack(id);
        }
    }
    textureStore(gwFloodOut, vec3i(id), vec4u(seed, 0u, 0u, 0u));
}

// The distance between two voxels in km, the grid wrapping east and north.
fn gwVoxelDistance(a: vec3u, b: vec3u, size: vec3u) -> f32 {
    let d = abs(vec3i(a) - vec3i(b));
    let wrapped = min(d.xy, vec2i(size.xy) - d.xy);
    let cell = vec3f(gwVolume.extent / f32(size.x), gwVolume.extent / f32(size.y), gwVolume.height / f32(size.z));
    return length(vec3f(vec2f(wrapped), f32(d.z)) * cell);
}

// One jump of the flood: of the 27 voxels a step away, the nearest seed any of them knows is kept.
@compute @workgroup_size(4, 4, 4)
fn gwFloodJump(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(gwFloodOut);
    if (any(id >= size)) {
        return;
    }
    let step = i32(gwFloodStep.x);
    var best = GW_NO_SEED;
    var bestDistance = 1e30;
    for (var c = 0u; c < 27u; c = c + 1u) {
        let offset = (vec3i(i32(c % 3u), i32((c / 3u) % 3u), i32(c / 9u)) - 1) * step;
        var at = vec3i(id) + offset;
        if (at.z < 0 || at.z >= i32(size.z)) {
            continue;
        }
        at = vec3i((at.xy + vec2i(size.xy) * 4) % vec2i(size.xy), at.z);
        let seed = textureLoad(gwFloodIn, at, 0).x;
        if (seed == GW_NO_SEED) {
            continue;
        }
        let distance = gwVoxelDistance(id, gwUnpack(seed), size);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = seed;
        }
    }
    textureStore(gwFloodOut, vec3i(id), vec4u(best, 0u, 0u, 0u));
}

// The modeling data from the flooded grid: the profile from the depth inside, the distance outside, the type and
// the density scale from the map's other fields.
@compute @workgroup_size(4, 4, 4)
fn gwModeling(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(gwModelingOut);
    if (any(id >= size)) {
        return;
    }
    let column = gwColumn(id.xy, size.xy);
    let inside = gwInside(column.r, id.z, size.z);
    let seed = textureLoad(gwFloodIn, vec3i(id), 0).x;
    var distance = gwVolume.sdfRange;
    if (seed != GW_NO_SEED) {
        distance = gwVoxelDistance(id, gwUnpack(seed), size);
    }
    let cell = gwVolume.height / f32(size.z);
    var profile = 0.0;
    var outside = 0.0;
    if (inside) {
        // Half a voxel in at the surface, so the surface voxels are cloud too.
        profile = clamp((distance + 0.5 * cell) / max(gwVolume.profileDepth, 1e-3), 0.0, 1.0);
    } else {
        // Rounded down to the 8-bit step below, so a march never steps past a surface.
        outside = floor(clamp(distance / gwVolume.sdfRange, 0.0, 1.0) * 255.0) / 255.0;
    }
    let kind = column.g;
    // Thinner where the map is thin, as the thesis' wisps were.
    let scale = mix(0.6, 1.0, smoothstep(0.0, 0.5, column.r));
    textureStore(gwModelingOut, vec3i(id), vec4f(profile, kind, scale, outside));
}
