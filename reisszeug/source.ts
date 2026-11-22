import { readFileSync } from "node:fs";
import { prefixed } from "./prefixed.js";

/** A chunk of reisszeug's WGSL read from disk under `prefix`: for the packages' tests, which read their shaders as files. */
export const reisszeugSource = (name: string, prefix: string): string =>
    prefixed(readFileSync(new URL(`./${name}.wgsl`, import.meta.url), "utf8"), prefix);
