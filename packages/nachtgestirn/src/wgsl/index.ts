/**
 * The WGSL layer, exported as plain strings so a consumer can compose these snippets into their own shaders instead of
 * using this package's pass. `params` and `surface` are binding-free; the `.comp.wgsl` passes declare their bindings
 * at group 0 and take their output from `moonOutput(format)` at group 1. Every identifier is prefixed `nb`/`NB_`.
 *
 * `camera` is dunstkreis' and `tonemap` helldunkel's, bundled at build time: one source, nothing else to install.
 */
import mips from "./mips.comp.wgsl";
import moon from "./moon.comp.wgsl";
import params from "./params.wgsl";
import surface from "./surface.wgsl";

export { camera } from "@himmelszelt/dunstkreis/wgsl";
export { tonemap } from "@himmelszelt/helldunkel/wgsl";
export { moonOutput } from "./output.js";
export { mips, moon, params, surface };
