/**
 * The WGSL layer, exported as plain strings so a consumer can compose these snippets into their own shaders instead of
 * using this package's pass. `params` and `stars` are binding-free but for the `shParams` and `shCatalog` bindings
 * the passes declare; `bin` and `compose` declare theirs at group 0, and `compose` takes its output from
 * `starsOutput(format)` at group 1. Every identifier is prefixed `sh`/`SH_`.
 *
 * `camera`, `air` and `seeing` are dunstkreis', the camera's rays, the air table's lookups and a star's flicker, and
 * `glare`, `whitebalance`, `tonemap` and `vision` helldunkel's, bundled at build time: one source, nothing else to
 * install. The passes bind the air table as `shAir` at binding 15. `halo` spreads the halos' grid into their profile,
 * and `lines` bins the constellations' lines for `compose`.
 */
import bin from "./bin.comp.wgsl";
import compose from "./compose.comp.wgsl";
import halo from "./halo.comp.wgsl";
import lines from "./lines.comp.wgsl";
import params from "./params.wgsl";
import stars from "./stars.wgsl";

export { air, camera, seeing } from "@himmelszelt/dunstkreis/wgsl";
export { glare, tonemap, vision, whitebalance } from "@himmelszelt/helldunkel/wgsl";
export { starsOutput } from "./output.js";
export { bin, compose, halo, lines, params, stars };
