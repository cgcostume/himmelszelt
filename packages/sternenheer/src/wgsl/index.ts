/**
 * The WGSL layer, exported as plain strings so a consumer can compose these snippets into their own shaders instead of
 * using this package's pass. `params` and `stars` are binding-free but for the `shParams` and `shCatalog` bindings
 * the passes declare; `bin` and `compose` declare theirs at group 0, and `compose` takes its output from
 * `starsOutput(format)` at group 1. Every identifier is prefixed `sh`/`SH_`.
 *
 * `camera` is dunstkreis' and `glare`, `tonemap`, `vision` and `bloom`, whose chain spreads the halos, helldunkel's,
 * bundled at build time: one source, nothing else to install. `halo` fills that chain's first level, and `lines` bins the
 * constellations' lines for `compose`.
 */
import bin from "./bin.comp.wgsl";
import compose from "./compose.comp.wgsl";
import halo from "./halo.comp.wgsl";
import lines from "./lines.comp.wgsl";
import params from "./params.wgsl";
import stars from "./stars.wgsl";

export { camera } from "@himmelszelt/dunstkreis/wgsl";
export { bloom, bloomOutput, glare, tonemap, vision } from "@himmelszelt/helldunkel/wgsl";
export { starsOutput } from "./output.js";
export { bin, compose, halo, lines, params, stars };
