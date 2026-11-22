/**
 * The WGSL layer, exported as plain strings so a consumer can compose these snippets into their own shaders instead of
 * using this package's pass. `params`, `surface` and the laws are binding-free: `reflectance`, Hapke's 2012 model, which
 * the pass uses, and `hapke1963`, his law of 1963, to compare it with, as `MoonPassOptions.reflectance`. The
 * `.comp.wgsl` passes declare their bindings at group 0 and take their output from `moonOutput(format)` at group 1,
 * but for `noise`, which writes the roughness' 3D texture at group 0 itself.
 * Every identifier is prefixed `ng`/`NG_`, for nachtgestirn.
 *
 * `camera` is dunstkreis' and `tonemap`, `vision` and `whitebalance` helldunkel's, bundled at build time: one source,
 * nothing else to install.
 */

import rzHash from "../../../../reisszeug/hash.wgsl";
import rzNoise from "../../../../reisszeug/noise.wgsl";
import { prefixed } from "../../../../reisszeug/prefixed.js";
import rzTurbulence from "../../../../reisszeug/turbulence.wgsl";
import bc1 from "./bc1.comp.wgsl";
import hapke1963 from "./hapke1963.wgsl";
import mips from "./mips.comp.wgsl";
import moon from "./moon.comp.wgsl";
import noiseComp from "./noise.comp.wgsl";
import params from "./params.wgsl";
import reflectance from "./reflectance.wgsl";
import relief from "./relief.comp.wgsl";
import shadow from "./shadow.comp.wgsl";
import shimmerSource from "./shimmer.comp.wgsl";
import surface from "./surface.wgsl";

export { camera } from "@himmelszelt/dunstkreis/wgsl";
export { tonemap, vision, whitebalance } from "@himmelszelt/helldunkel/wgsl";
export { moonOutput } from "./output.js";
export { bc1, hapke1963, mips, moon, params, reflectance, relief, shadow, surface };

/** The roughness' noise pass, with reisszeug's hashes and noise under the prefix `ng`, which it is made from. */
export const noise = [prefixed(rzHash, "ng"), prefixed(rzNoise, "ng"), noiseComp].join("\n");

/** The shimmer, with reisszeug's turbulence under the prefix `ng`, which it wanders an image by. */
export const shimmer = [prefixed(rzTurbulence, "ng"), shimmerSource].join("\n");
