// What the chapter's "What it costs" measures, the same list for the figure and for `scripts/bench.mjs helldunkel`, which
// writes the measures into bench.json.

/** The rows, in the figure's order: the tone curve and the bloom at two sizes, the meter over a sky's cube map and over
 *  an HDRI of 4K. */
export const COST_ROWS = ["tone1080", "tone2160", "bloom1080", "bloom2160", "meterCube", "meterHdri"] as const;
export type CostKey = (typeof COST_ROWS)[number];
