// What the chapter's "What it costs" measures, the same list for the figure and for `scripts/bench.mjs dunstkreis`, which
// writes the measures into bench.json.

/** The rows, in the figure's order: the tables once per atmosphere, the sky view per move of the Sun, the sky pass per
 *  frame at two sizes, the cube map per move of the Sun, and the aerial perspective per move of the camera. */
export const COST_ROWS = ["tables", "skyView", "sky1080", "sky2160", "cube", "aerial"] as const;
/** Measured besides, for the text: the sky pass at 1920 by 1080 without the aureole. */
export const MEASURED = [...COST_ROWS, "skyBare"] as const;
export type CostKey = (typeof MEASURED)[number];

/** The cube map as the page lights its scenes with it: 512 texels a face, every mip level, eight samples a texel. */
export const CUBE_SIZE = 512;
