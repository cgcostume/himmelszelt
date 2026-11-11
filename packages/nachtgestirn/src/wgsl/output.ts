/** The output binding of the Moon and mip passes, which has to spell out the target's format. */
export const moonOutput = (format: GPUTextureFormat) => `
@group(1) @binding(0) var ngOutput: texture_storage_2d<${format}, write>;
fn ngOutputSize() -> vec2u { return textureDimensions(ngOutput); }
fn ngOutputStore(pixel: vec2u, color: vec4f) { textureStore(ngOutput, vec2i(pixel), color); }
`;
