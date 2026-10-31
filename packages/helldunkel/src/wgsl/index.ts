/**
 * The WGSL layer, exported as plain strings. Every identifier is prefixed `hd` (or `HD_` for constants) so several
 * `@himmelszelt/*` fragments can share one shader module.
 */
import tonemap from "./tonemap.wgsl";

export { tonemap };
