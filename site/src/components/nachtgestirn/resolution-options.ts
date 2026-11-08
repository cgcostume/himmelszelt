import type { IconName } from "../icons";

/** The close-ups' maps to choose from: the shipped 4K, or a strip of the southern highlands at 8K or 16K over it. */
export const STRIP_RESOLUTIONS: readonly (readonly [string, IconName, string])[] = [
    ["large", "res4k", "4K: the whole Moon 4096 texels around, the maps the package ships, 11.5 MB"],
    ["8k-strip", "res8k", "8K: the southern highlands at 8192 texels around, 6 MB more"],
    ["16k-strip", "res16k", "16K: the southern highlands at 16384 texels around, 22 MB more"],
];

/** The whole Moon's maps to choose from: the shipped 4K, 8K, or 16K with the 8K's heights. */
export const WHOLE_RESOLUTIONS: readonly (readonly [string, IconName, string])[] = [
    ["large", "res4k", "4K: 4096 texels around, the maps the package ships, 11.5 MB"],
    ["8k", "res8k", "8K: 8192 texels around, 43 MB, and some 600 MB on the GPU"],
    ["16k", "res16k", "16K: 16382 texels around, the heights at 8K, 51 MB, and over a gigabyte on the GPU"],
];
