import type { MapFilter } from "@himmelszelt/nachtgestirn";

/** The maps' filters the sampling figure compares, a tile each after the disc: the filter, its name, and what it does. The
 *  B-spline the pass adds where the map is magnified is left out: at the close-up's scale a texel is about a pixel. */
export const FILTERS: readonly (readonly [MapFilter, string, string])[] = [
    ["nearest", "nearest", "a texel of the full size"],
    ["bilinear", "bilinear", "four texels of the full size"],
    ["trilinear", "trilinear", "and between two levels"],
    ["anisotropic", "anisotropic", "taps along the footprint, as the pass"],
];
