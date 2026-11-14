import type { IconName } from "../icons";

/** The whole Moon's maps to choose from: the shipped 1K, 2K or 4K, or the site's 8K. */
export const WHOLE_RESOLUTIONS: readonly (readonly [string, IconName, string])[] = [
    ["1k", "res1k", "1K: 1024 texels around, 818 KiB"],
    ["2k", "res2k", "2K: 2048 texels around, 3.0 MiB"],
    ["4k", "res4k", "4K: 4096 texels around, the package's largest maps, 11.0 MiB"],
    ["8k", "res8k", "8K: 8192 texels around, 41 MiB, and some 520 MiB on the GPU"],
];
