// The roughness' noise, made once: gradient noise's slope at the centers of a 3D texture's texels, NG_NOISE_TEXELS to a
// cell, periodic over the texture, scaled into 8-bit snorm by NG_NOISE_RANGE. The Moon pass reads it trilinearly, a tap
// an octave, rather than hashing the eight corners of a cell for every octave of every ray. Requires reisszeug's
// `hash.wgsl` and `noise.wgsl` under the prefix `ng`, which `wgsl.noise` holds with this.

@group(0) @binding(0) var ngNoiseOut: texture_storage_3d<rgba8snorm, write>;

// Texels to a cell of the noise, and the largest component of its gradient, which 8-bit snorm scales to 1: as
// moon.comp.wgsl reads them.
const NG_NOISE_TEXELS: f32 = 4.0;
const NG_NOISE_RANGE: f32 = 2.66;

@compute @workgroup_size(4, 4, 4)
fn ngNoise(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(ngNoiseOut);
    if (any(id >= size)) {
        return;
    }
    let gradient = ngPerlinSlope((vec3f(id) + 0.5) / NG_NOISE_TEXELS, vec3i(i32(f32(size.x) / NG_NOISE_TEXELS)), 0u);
    textureStore(ngNoiseOut, vec3i(id), vec4f(clamp(gradient / NG_NOISE_RANGE, vec3f(-1.0), vec3f(1.0)), 0.0));
}
