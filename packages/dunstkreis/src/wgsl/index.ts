/**
 * The WGSL layer, exported as plain strings so a consumer can compose these snippets into their own shader
 * instead of using this package's passes at all.
 *
 * The snippets are deliberately binding-free: `common` takes the `DkAtmosphere` struct from `atmosphere` by
 * value rather than reading a `var<uniform>`, so composing is concatenation plus declaring the binding yourself,
 * and nothing here can collide with your own group/binding indices.
 * Fill the uniform buffer with `atmosphereUniformData()`. Sample counts are separate again: `quality` holds
 * WGSL `override` declarations, set at pipeline creation via `pipelineConstants()`, so that loop bounds stay
 * compile-time constants. `features` holds the passes' switches the same way, so an unused feature compiles out
 * rather than branching. `common` declares one override of its own, `DK_REFRACTION`, on by default.
 *
 * The passes that sum over a workgroup take `workgroupSum(threads, subgroups)` first, with subgroup operations where the
 * device has the "subgroups" feature and workgroup memory where it has not.
 *
 * Every identifier is prefixed `dk` (or `DK_` for constants) so several `@himmelszelt/*` fragments can share one
 * shader module.
 */
import atmosphere from "./atmosphere.wgsl";
import common from "./common.wgsl";
import cube from "./cube.wgsl";
import exposure from "./exposure.comp.wgsl";
import features from "./features.wgsl";
import frame from "./frame.wgsl";
import irradiance from "./irradiance.comp.wgsl";
import lut from "./lut.wgsl";
import mipmap from "./mipmap.comp.wgsl";
import multiscattering from "./multiscattering.comp.wgsl";
import quality from "./quality.wgsl";
import raymarch from "./raymarch.wgsl";
import sampling from "./sampling.wgsl";
import sky from "./sky.comp.wgsl";
import skyview from "./skyview.comp.wgsl";
import sun from "./sun.wgsl";
import tonemap from "./tonemap.wgsl";
import transmittance from "./transmittance.comp.wgsl";

export { skyCubeOutput, skyOutput } from "./output.js";
export { workgroupSum } from "./reduce.js";

export {
    atmosphere,
    common,
    cube,
    exposure,
    features,
    frame,
    irradiance,
    lut,
    mipmap,
    multiscattering,
    quality,
    raymarch,
    sampling,
    sky,
    skyview,
    sun,
    tonemap,
    transmittance,
};

/** The composable pieces, in the order WGSL needs them declared. No bindings, no entry points. */
export const scattering = [atmosphere, common, lut, sampling, raymarch].join("\n");

/** `scattering` plus the sample counts, which the passes below additionally need. */
export const scatteringWithQuality = [quality, scattering].join("\n");
