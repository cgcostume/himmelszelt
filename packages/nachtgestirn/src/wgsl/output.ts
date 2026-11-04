/** The output binding of the Moon and mip passes, which has to spell out the target's format. */
export const moonOutput = (format: GPUTextureFormat) => `
@group(1) @binding(0) var nbOutput: texture_storage_2d<${format}, write>;
fn nbOutputSize() -> vec2u { return textureDimensions(nbOutput); }
fn nbOutputStore(pixel: vec2u, color: vec4f) { textureStore(nbOutput, vec2i(pixel), color); }
`;
