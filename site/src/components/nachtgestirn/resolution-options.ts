import type { IconName } from "../icons";

/** The close-ups' maps to choose from: the shipped 1K or 4K, the site's 2K, or a strip of the southern highlands at 8K
 *  over the 4K. */
export const STRIP_RESOLUTIONS: readonly (readonly [string, IconName, string])[] = [
    ["medium", "res1k", "1K: the whole Moon 1024 texels around, the package's smaller maps, 840 KB"],
    ["2k", "res2k", "2K: the whole Moon 2048 texels around, 3 MB"],
    ["large", "res4k", "4K: the whole Moon 4096 texels around, the maps the package ships, 11.5 MB"],
    ["8k-strip", "res8k", "8K: the southern highlands at 8192 texels around, 6 MB more"],
];

/** The whole Moon's maps to choose from: the shipped 1K or 4K, or the site's 2K or 8K. */
export const WHOLE_RESOLUTIONS: readonly (readonly [string, IconName, string])[] = [
    ["medium", "res1k", "1K: 1024 texels around, the package's smaller maps, 840 KB"],
    ["2k", "res2k", "2K: 2048 texels around, 3 MB"],
    ["large", "res4k", "4K: 4096 texels around, the maps the package ships, 11.5 MB"],
    ["8k", "res8k", "8K: 8192 texels around, 43 MB, and some 600 MB on the GPU"],
];
