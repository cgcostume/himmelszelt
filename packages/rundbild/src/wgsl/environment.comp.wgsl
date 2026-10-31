// Environments as cube maps: a panorama turned into one, two of them faded into each other, and mip levels. Requires
// `cube.wgsl`, `panorama.wgsl` and the output, `rbOutput`, first. A pass, so it declares its sources.

@group(0) @binding(0) var rbFrom: texture_2d<f32>;
@group(0) @binding(1) var rbSampler: sampler;
@group(0) @binding(2) var rbCubeA: texture_cube<f32>;
@group(0) @binding(3) var rbCubeB: texture_cube<f32>;
@group(0) @binding(5) var<uniform> rbFade: RbFade;

struct RbFade {
    // How far from a to b, and what each cube map's light is multiplied by first.
    t: f32,
    scaleA: f32,
    scaleB: f32,
    free: f32,
}

override RB_PROJECTION: u32 = 1u;
override RB_AZIMUTH_OFFSET: f32 = 0.0;
override RB_SAMPLES: u32 = 1u;
// Whether the cube map written is cubified, and each one read.
override RB_CUBIFY: bool = false;
override RB_A_CUBIFIED: bool = false;
override RB_B_CUBIFIED: bool = false;

fn rbTexelRay(face: u32, position: vec2f, size: u32) -> vec3f {
    let point = rbCubePointAt(face, position, size);
    return select(normalize(point), rbSphereFromCube(point), RB_CUBIFY);
}

// A panorama's texels spread over each of the written ones, by Roberts' R2 sequence.
@compute @workgroup_size(8, 8, 1)
fn rbCubeFromPanorama(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(rbOutput);
    if (any(id.xy >= size)) {
        return;
    }
    var sum = vec3f(0.0);
    for (var i = 0u; i < RB_SAMPLES; i = i + 1u) {
        let offset = select(fract(vec2f(0.5) + f32(i) * vec2f(0.7548776662466927, 0.5698402909980532)) - 0.5, vec2f(0.0), RB_SAMPLES == 1u);
        let d = rbTexelRay(id.z, vec2f(id.xy) + 0.5 + offset, size.x);
        sum = sum + textureSampleLevel(rbFrom, rbSampler, rbPanoramaUv(RB_PROJECTION, d, RB_AZIMUTH_OFFSET), 0.0).rgb;
    }
    textureStore(rbOutput, vec2i(id.xy), i32(id.z), vec4f(sum / f32(RB_SAMPLES), 1.0));
}

// Two environments faded by their light: the mean of two skies, not of their pictures.
@compute @workgroup_size(8, 8, 1)
fn rbBlend(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(rbOutput);
    if (any(id.xy >= size)) {
        return;
    }
    let d = rbTexelRay(id.z, vec2f(id.xy) + 0.5, size.x);
    let a = textureSampleLevel(rbCubeA, rbSampler, select(d, rbCubeFromSphere(d), RB_A_CUBIFIED), 0.0).rgb * rbFade.scaleA;
    let b = textureSampleLevel(rbCubeB, rbSampler, select(d, rbCubeFromSphere(d), RB_B_CUBIFIED), 0.0).rgb * rbFade.scaleB;
    textureStore(rbOutput, vec2i(id.xy), i32(id.z), vec4f(mix(a, b, rbFade.t), 1.0));
}

// One level from the one above: each texel the mean of four, read through the same cube's nearest texels.
@compute @workgroup_size(8, 8, 1)
fn rbCubeMip(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(rbOutput);
    if (any(id.xy >= size)) {
        return;
    }
    let above = textureDimensions(rbCubeA).x;
    var sum = vec4f(0.0);
    for (var k = 0u; k < 4u; k = k + 1u) {
        let texel = min(id.xy * 2u + vec2u(k & 1u, k >> 1u), vec2u(above - 1u));
        sum = sum + textureSampleLevel(rbCubeA, rbSampler, rbCubeDirection(id.z, texel, above), 0.0);
    }
    textureStore(rbOutput, vec2i(id.xy), i32(id.z), sum / 4.0);
}
