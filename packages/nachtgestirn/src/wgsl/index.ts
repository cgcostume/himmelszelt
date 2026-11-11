/**
 * The WGSL layer, exported as plain strings so a consumer can compose these snippets into their own shaders instead of
 * using this package's pass. `params`, `surface` and the laws are binding-free: `reflectance`, Hapke's 2012 model, which
 * the pass uses, and `hapke1963`, his law of 1963, to compare it with, as `MoonPassOptions.reflectance`. The
 * `.comp.wgsl` passes declare their bindings at group 0 and take their output from `moonOutput(format)` at group 1.
 * Every identifier is prefixed `ng`/`NG_`, for nachtgestirn.
 *
 * `camera` is dunstkreis' and `tonemap` and `vision` helldunkel's, bundled at build time: one source, nothing else to
 * install.
 */
import bc1 from "./bc1.comp.wgsl";
import hapke1963 from "./hapke1963.wgsl";
import mips from "./mips.comp.wgsl";
import moon from "./moon.comp.wgsl";
import params from "./params.wgsl";
import reflectance from "./reflectance.wgsl";
import relief from "./relief.comp.wgsl";
import shadow from "./shadow.comp.wgsl";
import shimmer from "./shimmer.comp.wgsl";
import surface from "./surface.wgsl";

export { camera } from "@himmelszelt/dunstkreis/wgsl";
export { tonemap, vision } from "@himmelszelt/helldunkel/wgsl";
export { moonOutput } from "./output.js";
export { bc1, hapke1963, mips, moon, params, reflectance, relief, shadow, shimmer, surface };
