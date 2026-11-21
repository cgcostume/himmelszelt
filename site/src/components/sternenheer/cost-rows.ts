// What the chapter's "What it costs" measures, the same list for the figure and for `scripts/bench.mjs sternenheer`, which
// writes the measures into bench.json.

/** The rows, by their ids in budget-rows.ts: the catalog alone, the chapter's sky at three sizes, with everything on,
 *  and with the deep stars. */
export const COST_ROWS = ["catalog", "720p", "air", "2160p", "large", "deep"] as const;
export type CostKey = (typeof COST_ROWS)[number];
