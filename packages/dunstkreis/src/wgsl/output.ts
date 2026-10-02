/**
 * The sky pass' output binding, which has to spell out the target's format: rgba8unorm or bgra8unorm for a display,
 * rgba16float or rgba32float without tone mapping or for an HDR canvas. bgra8unorm needs the device feature
 * "bgra8unorm-storage".
 */
export const skyOutput = (format: GPUTextureFormat) => `
@group(1) @binding(0) var dkOutput: texture_storage_2d<${format}, write>;
fn dkOutputSize() -> vec2u { return textureDimensions(dkOutput); }
fn dkOutputStore(pixel: vec2u, layer: u32, color: vec4f) { textureStore(dkOutput, vec2i(pixel), color); }
`;

/** The same for the six faces of a cube map, bound as a 2D array: rgba16float, or rgba32float with the sun disc. */
export const skyCubeOutput = (format: GPUTextureFormat) => `
@group(1) @binding(0) var dkOutput: texture_storage_2d_array<${format}, write>;
fn dkOutputSize() -> vec2u { return textureDimensions(dkOutput); }
fn dkOutputStore(pixel: vec2u, layer: u32, color: vec4f) { textureStore(dkOutput, vec2i(pixel), i32(layer), color); }
`;
