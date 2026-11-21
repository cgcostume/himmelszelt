/**
 * The WGSL layer, exported as plain strings so a consumer can compose these snippets into their own shaders instead of
 * using this package's passes. `noise` and `params` are binding-free; the `.comp.wgsl` passes declare their bindings
 * at group 0 and take their output from `cloudOutput(format)` at group 1. Every identifier is prefixed `gw`/`GW_`.
 *
 * `camera` and `aerial` are dunstkreis' and `tonemap` and `whitebalance` helldunkel's, bundled at build time: one source, nothing else to
 * install. `airLookup` is dunstkreis' too, what `sunlight` reads its transmittance table with.
 */
import { atmosphere, common, lut, sampling } from "@himmelszelt/dunstkreis/wgsl";
import cloudmap from "./cloudmap.comp.wgsl";
import clouds from "./clouds.comp.wgsl";
import compose from "./compose.comp.wgsl";
import detail from "./detail.comp.wgsl";
import highmap from "./highmap.comp.wgsl";
import highsheet from "./highsheet.comp.wgsl";
import layered from "./layered.comp.wgsl";
import layermap from "./layermap.comp.wgsl";
import layers from "./layers.comp.wgsl";
import light from "./light.comp.wgsl";
import morph from "./morph.comp.wgsl";
import noise from "./noise.wgsl";
import params from "./params.wgsl";
import sheet from "./sheet.wgsl";
import sunlight from "./sunlight.comp.wgsl";
import voxel from "./voxel.comp.wgsl";

export { aerial, camera } from "@himmelszelt/dunstkreis/wgsl";
export { tonemap, whitebalance } from "@himmelszelt/helldunkel/wgsl";
export { cloudOutput } from "./output.js";
// The layered model's passes: a layer's map, the layers' march, the high sheet's map and its read, and their composition.
export {
    cloudmap,
    clouds,
    compose,
    detail,
    highmap,
    highsheet,
    layered,
    layermap,
    layers,
    light,
    morph,
    noise,
    params,
    sheet,
    sunlight,
    voxel,
};

export const airLookup = [atmosphere, common, lut, sampling].join("\n");
