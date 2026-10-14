// The tables alone, and what a user's own shader needs to render the sky from them, as the sky pass composes it.
import {
    atmosphereUniformData,
    DEFAULT_ATMOSPHERE_MODEL,
    DEFAULT_TEXTURE_CONFIG,
    pipelineConstants,
    precomputeAtmosphere,
    wgsl,
} from "../dist/index.js";

export const tables = (device) => precomputeAtmosphere(device);
export const uniforms = atmosphereUniformData(DEFAULT_ATMOSPHERE_MODEL);
export const constants = pipelineConstants(DEFAULT_TEXTURE_CONFIG);
export const display = [
    wgsl.quality,
    wgsl.features,
    wgsl.atmosphere,
    wgsl.common,
    wgsl.lut,
    wgsl.sampling,
    wgsl.raymarch,
    wgsl.sun,
    wgsl.tonemap,
].join("\n");
