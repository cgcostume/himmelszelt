/**
 * The WGSL layer, exported as plain strings so a consumer can compose these snippets into their own shaders instead of
 * using this package's passes. `noise` and `params` are binding-free; the `.comp.wgsl` passes declare their bindings
 * at group 0 and take their output from `cloudOutput(format)` at group 1. Every identifier is prefixed `gw`/`GW_`.
 *
 * `noise` holds reisszeug's hashes and noise, the repository's shared shader math, inlined at build time under the
 * prefix `gw`, with this package's cell patterns.
 *
 * `camera` and `aerial` are dunstkreis' and `tonemap` and `whitebalance` helldunkel's, bundled at build time: one source, nothing else to
 * install. `airLookup` is dunstkreis' too, what `sunlight` reads its transmittance table with.
 */
import { atmosphere, common, lut, sampling } from "@himmelszelt/dunstkreis/wgsl";
import rzHash from "../../../../reisszeug/hash.wgsl";
import rzNoise from "../../../../reisszeug/noise.wgsl";
import rzPhase from "../../../../reisszeug/phase.wgsl";
import { prefixed } from "../../../../reisszeug/prefixed.js";
import cells from "./cells.wgsl";
import cloudmap from "./cloudmap.comp.wgsl";
import clouds from "./clouds.comp.wgsl";
import compose from "./compose.comp.wgsl";
import corona from "./corona.wgsl";
import detail from "./detail.comp.wgsl";
import godrays from "./godrays.comp.wgsl";
import highmap from "./highmap.comp.wgsl";
import highsheet from "./highsheet.comp.wgsl";
import layered from "./layered.comp.wgsl";
import layermap from "./layermap.comp.wgsl";
import layerpyramid from "./layerpyramid.comp.wgsl";
import layerread from "./layerread.wgsl";
import layers from "./layers.comp.wgsl";
import light from "./light.comp.wgsl";
import morph from "./morph.comp.wgsl";
import paramsSource from "./params.wgsl";
import rainbow from "./rainbow.wgsl";
import sheet from "./sheet.wgsl";
import sunlight from "./sunlight.comp.wgsl";
import voxel from "./voxel.comp.wgsl";

export { aerial, camera } from "@himmelszelt/dunstkreis/wgsl";
export { tonemap, whitebalance } from "@himmelszelt/helldunkel/wgsl";
export { cloudOutput } from "./output.js";
// The layered model's passes: a layer's map and its max pyramid, the layers' march, the high sheet's map and its read,
// and their composition.
export {
    cloudmap,
    clouds,
    compose,
    corona,
    detail,
    godrays,
    highmap,
    highsheet,
    layered,
    layermap,
    layerpyramid,
    layerread,
    layers,
    light,
    morph,
    rainbow,
    sheet,
    sunlight,
    voxel,
};

/** reisszeug's phase functions under the prefix `gw`, `gwHenyeyGreenstein`, alone: `params` holds them too. */
export const phase = prefixed(rzPhase, "gw");

/** What every pass reads, binding-free: the parameters' structs and the geometry, with `phase`. */
export const params = [phase, paramsSource].join("\n");

/** The noise, reisszeug's hashes and noises under the prefix `gw`, with the cell patterns the maps are drawn from and
 *  the jitter a march starts its rays by: `gwPerlin`, `gwPerlin2`, `gwFbm`, `gwAlligator`, `gwCurl`, `gwBumps`. */
export const noise = [prefixed(rzHash, "gw"), prefixed(rzNoise, "gw"), cells].join("\n");

export const airLookup = [atmosphere, common, lut, sampling].join("\n");
