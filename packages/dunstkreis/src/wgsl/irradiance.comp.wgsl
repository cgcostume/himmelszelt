// Diffuse image-based lighting from any cube map in cd/m², the sky's or an HDR environment's. Requires `cube.wgsl`,
// `spiral.wgsl` and `workgroupSum(64, ...)` from `reduce.ts`, first. A pass, so it declares its bindings.
//
// Two entry points, run one after the other. `dkProjectSH` projects the cube map onto the nine real spherical
// harmonics up to order 2, from directions spread evenly over the sphere. `dkIrradianceCube` then writes, for every
// normal, the irradiance a surface facing it receives, from those nine coefficients: convolved with the cosine lobe,
// order 2 keeps all but a few percent of it (Ramamoorthi & Hanrahan 2001). Directions are ENU, like the cube map's.

@group(0) @binding(0) var dkSource: texture_cube<f32>;
@group(0) @binding(1) var dkSourceSampler: sampler;
// Nine coefficients of radiance, rgb each, padded to vec4f: cd/m² times the basis functions' normalization.
@group(0) @binding(2) var<storage, read_write> dkSH: array<vec4f, 9>;
@group(0) @binding(3) var dkIrradiance: texture_storage_2d_array<rgba16float, write>;

// Whether the source cube map is cubified, see cube.wgsl. The irradiance cube map it writes is a plain one either way.
override DK_SOURCE_CUBIFIED: bool = false;

const DK_SH_THREADS: u32 = 64u;
const DK_SH_SAMPLES: u32 = 64u;

// The real spherical harmonics up to order 2, in the order (l, m) = (0, 0), (1, -1), (1, 0), (1, 1), (2, -2) to (2, 2).
fn dkSHBasis(d: vec3f) -> array<f32, 9> {
    return array<f32, 9>(
        0.282095,
        0.488603 * d.y,
        0.488603 * d.z,
        0.488603 * d.x,
        1.092548 * d.x * d.y,
        1.092548 * d.y * d.z,
        0.315392 * (3.0 * d.z * d.z - 1.0),
        1.092548 * d.x * d.z,
        0.546274 * (d.x * d.x - d.y * d.y),
    );
}

@compute @workgroup_size(64)
fn dkProjectSH(@builtin(local_invocation_index) index: u32) {
    let total = f32(DK_SH_THREADS * DK_SH_SAMPLES);
    // The level whose faces hold about as many texels as there are samples, 6 x 26², or the finest there is.
    let levels = f32(textureNumLevels(dkSource) - 1u);
    let level = clamp(log2(f32(textureDimensions(dkSource).x) / 26.0), 0.0, levels);
    var sums: array<vec3f, 9>;
    for (var i = 0u; i < DK_SH_SAMPLES; i = i + 1u) {
        // A Fibonacci spiral over the whole sphere: even in solid angle.
        let j = index * DK_SH_SAMPLES + i;
        let k = f32(j) + 0.5;
        let z = 1.0 - 2.0 * k / total;
        let azimuth = dkGoldenAzimuth(j);
        let horizontal = sqrt(max(1.0 - z * z, 0.0));
        let d = vec3f(horizontal * cos(azimuth), horizontal * sin(azimuth), z);
        let radiance = textureSampleLevel(dkSource, dkSourceSampler, select(d, dkCubeFromSphere(d), DK_SOURCE_CUBIFIED), level).rgb;
        var basis = dkSHBasis(d);
        for (var c = 0u; c < 9u; c = c + 1u) {
            sums[c] = sums[c] + radiance * basis[c];
        }
    }
    // One coefficient at a time, so the sums need 1 KiB of workgroup memory rather than 9.
    for (var c = 0u; c < 9u; c = c + 1u) {
        let sum = dkWorkgroupSum(vec4f(sums[c], 0.0), index);
        if (index == 0u) {
            // Each sample stands for 4 pi / total of the sphere.
            dkSH[c] = vec4f(sum.rgb * (4.0 * 3.14159265358979 / total), 0.0);
        }
    }
}

// Irradiance in lux for a surface facing `normal`: the coefficients weighted by the cosine lobe's own, pi for order 0,
// 2 pi / 3 for order 1 and pi / 4 for order 2. A white Lambertian surface then shows it divided by pi, in cd/m².
fn dkIrradianceFromSH(normal: vec3f) -> vec3f {
    var basis = dkSHBasis(normal);
    var lobe = array<f32, 9>(3.141593, 2.094395, 2.094395, 2.094395, 0.785398, 0.785398, 0.785398, 0.785398, 0.785398);
    var irradiance = vec3f(0.0);
    for (var c = 0u; c < 9u; c = c + 1u) {
        irradiance = irradiance + lobe[c] * dkSH[c].rgb * basis[c];
    }
    return max(irradiance, vec3f(0.0));
}

@compute @workgroup_size(8, 8, 1)
fn dkIrradianceCube(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(dkIrradiance);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let normal = dkCubeDirection(id.z, id.xy, size.x);
    textureStore(dkIrradiance, vec2i(id.xy), i32(id.z), vec4f(dkIrradianceFromSH(normal), 1.0));
}
