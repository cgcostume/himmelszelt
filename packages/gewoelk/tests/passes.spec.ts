import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { cloudOutput } from "../src/wgsl/output.js";
import { compileWgsl, gpuDevice } from "./gpu.js";

/** A shader by name, this package's or one of the fragments it bundles from the packages that own them. */
function wgslSource(name: string): string {
    const owner = { camera: "../../dunstkreis/src/wgsl", tonemap: "../../helldunkel/src/wgsl" }[name] ?? "../src/wgsl";
    const read = (file: string) => readFileSync(new URL(`${owner}/${file}`, import.meta.url), "utf8");
    try {
        return read(`${name}.wgsl`);
    } catch {
        return read(`${name}.comp.wgsl`);
    }
}

// Each pass with exactly the fragments its header names, so none grows a dependency it does not declare.
const PASSES: Record<string, readonly string[]> = {
    cloudmap: ["noise", "params", "cloudmap"],
    voxel: ["params", "voxel"],
    detail: ["noise", "detail"],
    light: ["params", "light"],
    clouds: ["params", "camera", "clouds"],
    compose: ["params", "tonemap", "compose"],
};
const OUTPUTS: Record<string, string> = { clouds: cloudOutput("rgba16float"), compose: cloudOutput("rgba8unorm") };

for (const [name, fragments] of Object.entries(PASSES)) {
    test(`the ${name} pass compiles from its declared fragments`, async () => {
        const device = await gpuDevice();
        test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
        if (!device) return;
        const errors = await compileWgsl(device, [OUTPUTS[name] ?? "", ...fragments.map(wgslSource)].join("\n"));
        expect(errors, `${name}:\n${errors.join("\n")}`).toEqual([]);
    });
}
