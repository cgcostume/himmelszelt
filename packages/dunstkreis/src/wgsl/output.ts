/**
 * The sky pass' output binding, which has to spell out the target's format: rgba8unorm or bgra8unorm for a display,
 * rgba16float or rgba32float without tone mapping. bgra8unorm needs the device feature "bgra8unorm-storage".
 */
export const skyOutput = (format: GPUTextureFormat) =>
    `@group(1) @binding(0) var dkOutput: texture_storage_2d<${format}, write>;`;
