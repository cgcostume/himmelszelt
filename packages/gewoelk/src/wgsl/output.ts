/** The output binding of the cloud and compose passes, which has to spell out the target's format. */
export const cloudOutput = (format: GPUTextureFormat) => `
@group(1) @binding(0) var gwOutput: texture_storage_2d<${format}, write>;
fn gwOutputSize() -> vec2u { return textureDimensions(gwOutput); }
fn gwOutputStore(pixel: vec2u, color: vec4f) { textureStore(gwOutput, vec2i(pixel), color); }
`;
