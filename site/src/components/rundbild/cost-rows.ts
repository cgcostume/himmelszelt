// What the chapter's "What it costs" measures, the same list for the figure and for `scripts/bench.mjs rundbild`, which
// writes the measures into bench.json.

/** The rows, in the figure's order: an HDRI of 1K and of 4K into a cube map as sharp, and the 4K into one as small as
 *  lighting takes it, with every mip level; the coefficients and the irradiance of a cube map 512 a face, a fade of two
 *  such, and one laid out equirectangular. */
export const COST_ROWS = ["hdri1k", "hdri4k", "light4k", "irradiance", "blend", "panorama"] as const;
export type CostKey = (typeof COST_ROWS)[number];

/** The environment the last three rows work on, as dunstkreis' sky lights a scene with: 512 a face. */
export const CUBE_SIZE = 512;
