import { expect, test } from "@playwright/test";
import { skyOutput } from "../src/wgsl/output.js";
import { compileWgsl, gpuDevice, wgslSource } from "./gpu.js";

// Each pass, with exactly the fragments it declares a dependency on in its header comment. Compiling them
// this way checks both that the WGSL is valid and that no pass has quietly grown a dependency it does not
// name, which would only surface when someone composed the pieces themselves.
const PASSES: Record<string, readonly string[]> = {
    transmittance: ["atmosphere", "common", "lut", "quality", "transmittance"],
    multiscattering: ["atmosphere", "common", "lut", "sampling", "quality", "multiscattering"],
    skyview: ["atmosphere", "common", "lut", "sampling", "raymarch", "quality", "skyview"],
    sky: ["atmosphere", "common", "lut", "sampling", "raymarch", "quality", "sky"],
    exposure: ["atmosphere", "common", "lut", "sampling", "raymarch", "exposure"],
};

for (const [name, fragments] of Object.entries(PASSES)) {
    test(`the ${name} pass compiles from its declared fragments`, async () => {
        const device = await gpuDevice();
        test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
        if (!device) return;

        const output = name === "sky" ? [skyOutput("rgba8unorm")] : [];
        const errors = await compileWgsl(device, [...output, ...fragments.map(wgslSource)].join("\n"));
        expect(errors, `${name}:\n${errors.join("\n")}`).toEqual([]);
    });
}

test("the composable fragments compile without any pass, binding or override", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;

    // The property that makes them droppable into someone else's shader: no bindings, no entry points, and
    // no dependency on the quality overrides.
    const composable = ["atmosphere", "common", "lut", "sampling", "raymarch"].map(wgslSource).join("\n");
    expect(await compileWgsl(device, composable)).toEqual([]);
});
