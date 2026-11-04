/** The output binding of the compose pass, which has to spell out the target's format. */
export const starsOutput = (format: GPUTextureFormat) => `
@group(1) @binding(0) var shOutput: texture_storage_2d<${format}, write>;
fn shOutputStore(pixel: vec2u, color: vec4f) { textureStore(shOutput, vec2i(pixel), color); }
`;
