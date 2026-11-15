import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { cloudOutput } from "../src/wgsl/output.js";
import { compileWgsl, gpuDevice } from "./gpu.js";

/** A shader by name, this package's or one of the fragments it bundles from the packages that own them. */
function wgslSource(name: string): string {
    const dunstkreis = "../../dunstkreis/src/wgsl";
    const owners: Record<string, string> = {
        camera: dunstkreis,
        atmosphere: dunstkreis,
        common: dunstkreis,
        lut: dunstkreis,
        sampling: dunstkreis,
        tonemap: "../../helldunkel/src/wgsl",
    };
    const owner = owners[name] ?? "../src/wgsl";
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
    voxel: ["noise", "params", "voxel"],
    detail: ["noise", "detail"],
    light: ["params", "light"],
    clouds: ["noise", "params", "camera", "sheet", "clouds"],
    compose: ["noise", "params", "camera", "sheet", "tonemap", "compose"],
    sunlight: ["atmosphere", "common", "lut", "sampling", "sunlight"],
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

test("with dunstkreis' tables, the pass computes its sunlight table on the GPU without a validation error", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const { precomputeAtmosphere } = await import("@himmelszelt/dunstkreis");
    const { createCloudPass, DEFAULT_CLOUD_PARAMS } = await import("../dist/index.js");
    const luts = await precomputeAtmosphere(device);
    device.pushErrorScope("validation");
    const pass = await createCloudPass(device, { format: "rgba16float", background: false, atmosphere: luts });
    pass.update({ ...DEFAULT_CLOUD_PARAMS, sunDirection: [0, 0.9986, 0.0523] });
    pass.update({ sunlight: null });
    expect(await device.popErrorScope()).toBeNull();
    pass.destroy();
    luts.destroy();
});
