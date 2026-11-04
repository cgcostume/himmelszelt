/**
 * The WGSL layer, exported as plain strings. `tonemap` and `glare` are binding-free, for a consumer's own shaders; `bloom`
 * and `meter` are the passes, with bindings of their own. Every identifier is prefixed `hd` (or `HD_` for constants) so several
 * `@himmelszelt/*` fragments can share one shader module.
 */
import bloom from "./bloom.comp.wgsl";
import glare from "./glare.wgsl";
import meter from "./meter.comp.wgsl";
import tonemap from "./tonemap.wgsl";

export { bloom, glare, meter, tonemap };

/** The bloom pass' output binding, which has to spell out the target's format. */
export const bloomOutput = (format: GPUTextureFormat) =>
    `@group(0) @binding(2) var hdBloomOutput: texture_storage_2d<${format}, write>;`;

/**
 * What the meter reads: the source's binding and its entry point, which counts every texel by the share of the sphere or
 * of the image it covers. After `meter`, whose functions it calls.
 */
export const meterSource = (kind: "cube" | "2d" | "equirectangular") =>
    kind === "cube"
        ? `@group(0) @binding(0) var hdMeterSource: texture_2d_array<f32>;
@compute @workgroup_size(16, 16)
fn hdMeter(@builtin(global_invocation_id) id: vec3u) {
    let texel = hdMeterTexel(id.xy);
    let size = textureDimensions(hdMeterSource).x;
    if (any(texel >= vec2u(size))) {
        return;
    }
    // The six faces in WebGPU's order, for a cube map's texel direction.
    let uv = (vec2f(texel) + 0.5) / f32(size) * 2.0 - 1.0;
    var direction: vec3f;
    switch id.z {
        case 0u: { direction = vec3f(1.0, -uv.y, -uv.x); }
        case 1u: { direction = vec3f(-1.0, -uv.y, uv.x); }
        case 2u: { direction = vec3f(uv.x, 1.0, uv.y); }
        case 3u: { direction = vec3f(uv.x, -1.0, -uv.y); }
        case 4u: { direction = vec3f(uv.x, -uv.y, 1.0); }
        default: { direction = vec3f(-uv.x, -uv.y, -1.0); }
    }
    // A texel's solid angle falls off towards a face's corners, to 0.19 of its center's.
    let solid = pow(1.0 + dot(uv, uv), -1.5);
    hdMeterCount(textureLoad(hdMeterSource, texel, id.z, 0).rgb, solid * hdMeterFocus(normalize(direction)));
}`
        : kind === "equirectangular"
          ? `@group(0) @binding(0) var hdMeterSource: texture_2d<f32>;
@group(0) @binding(3) var hdMeterMask: texture_2d<f32>;
fn hdMeterMasked(texel: vec2u) -> f32 {
    return textureLoad(hdMeterMask, texel * textureDimensions(hdMeterMask) / textureDimensions(hdMeterSource), 0).r;
}
@compute @workgroup_size(16, 16)
fn hdMeter(@builtin(global_invocation_id) id: vec3u) {
    let texel = hdMeterTexel(id.xy);
    let size = textureDimensions(hdMeterSource);
    if (any(texel >= size)) {
        return;
    }
    // From the zenith down and from north through east, ENU, as rundbild lays a panorama out.
    let polar = (f32(texel.y) + 0.5) / f32(size.y) * 3.141592653589793;
    let azimuth = (f32(texel.x) + 0.5) / f32(size.x) * 6.283185307179586;
    let direction = vec3f(sin(polar) * sin(azimuth), sin(polar) * cos(azimuth), cos(polar));
    hdMeterCount(textureLoad(hdMeterSource, texel, 0).rgb, sin(polar) * hdMeterFocus(direction) * hdMeterMasked(texel));
}`
          : `@group(0) @binding(0) var hdMeterSource: texture_2d<f32>;
@group(0) @binding(3) var hdMeterMask: texture_2d<f32>;
fn hdMeterMasked(texel: vec2u) -> f32 {
    return textureLoad(hdMeterMask, texel * textureDimensions(hdMeterMask) / textureDimensions(hdMeterSource), 0).r;
}
@compute @workgroup_size(16, 16)
fn hdMeter(@builtin(global_invocation_id) id: vec3u) {
    let texel = hdMeterTexel(id.xy);
    if (any(texel >= textureDimensions(hdMeterSource))) {
        return;
    }
    hdMeterCount(textureLoad(hdMeterSource, texel, 0).rgb, hdMeterMasked(texel));
}`;
