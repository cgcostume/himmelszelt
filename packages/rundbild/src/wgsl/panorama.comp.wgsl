// A cube map laid out as a panorama, in the units it holds. Requires `cube.wgsl` and `panorama.wgsl`, first, plus the
// output at group 1, `rbOutput`, declared by whoever builds the pipeline since its format has to be spelled out. A pass,
// so it declares its source.

@group(0) @binding(0) var rbSource: texture_cube<f32>;
@group(0) @binding(1) var rbSourceSampler: sampler;

// One of the projections of panorama.wgsl, the azimuth turned in radians, as there.
override RB_PROJECTION: u32 = 1u;
override RB_AZIMUTH_OFFSET: f32 = 0.0;
// Lookups per texel, spread over it.
override RB_SAMPLES: u32 = 1u;
// Whether the source cube map is cubified, see cube.wgsl.
override RB_SOURCE_CUBIFIED: bool = false;

fn rbSourceAt(d: vec3f) -> vec3f {
    let lookup = select(d, rbCubeFromSphere(d), RB_SOURCE_CUBIFIED);
    return textureSampleLevel(rbSource, rbSourceSampler, lookup, 0.0).rgb;
}

// Offsets within a texel, in [-0.5, 0.5): eight at a time, each a point of Roberts' R2 sequence in its eight mirror
// images, so that they are centered on the texel. One alone takes the center.
fn rbTexelOffset(i: u32) -> vec2f {
    if (RB_SAMPLES == 1u) {
        return vec2f(0.0);
    }
    let p = fract(vec2f(0.5) + f32(i / 8u + 1u) * vec2f(0.7548776662466927, 0.5698402909980532)) - 0.5;
    let k = i % 8u;
    let q = select(p, p.yx, (k & 4u) != 0u);
    return q * vec2f(select(1.0, -1.0, (k & 1u) != 0u), select(1.0, -1.0, (k & 2u) != 0u));
}

// A texel: the mean of its lookups, and in alpha the share of them within the projection, 1 but around the fisheye's and
// the sphere map's circle. Beyond the circle, the lookups are those of its rim, as rbPanoramaDirection takes them: the
// horizon at their azimuth for the fisheye, the nadir for the sphere map, so a lookup filtered across the rim blends into
// what lies there. The fisheye's top left corner texel alone holds the nadir, where rbFisheyeUv sends every direction
// below the horizon.
fn rbPanoramaTexel(texel: vec2u, size: vec2u) -> vec4f {
    if (RB_PROJECTION == RB_FISHEYE && all(texel == vec2u(0u))) {
        return vec4f(rbSourceAt(vec3f(0.0, 0.0, -1.0)), 0.0);
    }
    let round = RB_PROJECTION == RB_FISHEYE || RB_PROJECTION == RB_SPHERE_MAP;
    var color = vec3f(0.0);
    var inside = 0u;
    for (var i = 0u; i < RB_SAMPLES; i = i + 1u) {
        let uv = (vec2f(texel) + 0.5 + rbTexelOffset(i)) / vec2f(size);
        color = color + rbSourceAt(rbPanoramaDirection(RB_PROJECTION, uv, RB_AZIMUTH_OFFSET));
        inside = inside + select(1u, 0u, round && length(uv * 2.0 - 1.0) > 1.0);
    }
    return vec4f(color / f32(RB_SAMPLES), f32(inside) / f32(RB_SAMPLES));
}

@compute @workgroup_size(8, 8, 1)
fn rbPanorama(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(rbOutput);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    textureStore(rbOutput, vec2i(id.xy), rbPanoramaTexel(id.xy, size));
}
