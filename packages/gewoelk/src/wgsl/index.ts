/**
 * The WGSL layer, exported as plain strings so a consumer can compose these snippets into their own shaders instead of
 * using this package's passes. `noise` and `params` are binding-free; the `.comp.wgsl` passes declare their bindings
 * at group 0 and take their output from `cloudOutput(format)` at group 1. Every identifier is prefixed `gw`/`GW_`.
 *
 * `camera` is dunstkreis' and `tonemap` helldunkel's, bundled at build time: one source, nothing else to install.
 */
import cloudmap from "./cloudmap.comp.wgsl";
import clouds from "./clouds.comp.wgsl";
import compose from "./compose.comp.wgsl";
import detail from "./detail.comp.wgsl";
import light from "./light.comp.wgsl";
import noise from "./noise.wgsl";
import params from "./params.wgsl";
import voxel from "./voxel.comp.wgsl";

export { camera } from "@himmelszelt/dunstkreis/wgsl";
export { tonemap } from "@himmelszelt/helldunkel/wgsl";
export { cloudOutput } from "./output.js";
export { cloudmap, clouds, compose, detail, light, noise, params, voxel };
