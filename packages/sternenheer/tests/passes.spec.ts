import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { airTable, PARAMS_SIZE, paramsData } from "../dist/index.js";
import { starsOutput } from "../src/wgsl/output.js";
import { compileWgsl, gpuDevice } from "./gpu.js";

/** A shader by name, this package's or one of the fragments it bundles from the packages that own them. */
function wgslSource(name: string): string {
    const helldunkel = "../../helldunkel/src/wgsl";
    const owner =
        { camera: "../../dunstkreis/src/wgsl", glare: helldunkel, tonemap: helldunkel, vision: helldunkel }[name] ??
        "../src/wgsl";
    const read = (file: string) => readFileSync(new URL(`${owner}/${file}`, import.meta.url), "utf8");
    try {
        return read(`${name}.wgsl`);
    } catch {
        return read(`${name}.comp.wgsl`);
    }
}

// Each pass with exactly the fragments its header names, so none grows a dependency it does not declare.
const PASSES: Record<string, readonly string[]> = {
    bin: ["params", "camera", "glare", "bin", "stars"],
    compose: ["params", "camera", "glare", "tonemap", "vision", "compose", "stars"],
};

for (const [name, fragments] of Object.entries(PASSES)) {
    test(`the ${name} pass compiles from its declared fragments`, async () => {
        const device = await gpuDevice();
        test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
        if (!device) return;
        const errors = await compileWgsl(device, [starsOutput("rgba8unorm"), ...fragments.map(wgslSource)].join("\n"));
        expect(errors, `${name}:\n${errors.join("\n")}`).toEqual([]);
    });
}

test("the params pack to the uniform's size with the flags and the air where the shader reads them", () => {
    const air = airTable(
        (a) => (a < -0.5 ? null : 0.5 / (a + 1)),
        (a) => (a < -0.5 ? null : [0.8, 0.7, 0.6]),
    );
    const data = paramsData(
        {
            skyRotation: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
            years: 26,
            inverseViewProjection: new Float32Array(16),
            projectionDistance: 0,
            ev100: -6,
            horizonZ: -0.01,
            air,
            psfPixels: 0.8,
            scintillation: 1,
            time: 0,
            glare: 1,
            viewerFov: 30,
            starLight: 1,
            milkyWay: 1,
            magnitudeLimit: 6.5,
            heightM: 0,
            pupilCm: 0.7,
            threshold: 1 / 2048,
            maxRadius: 256,
        },
        { width: 640, height: 480, tileSize: 16, capacity: 64, stars: true, milkyWay: 1.7e-3 },
    );
    expect(data.byteLength).toBe(PARAMS_SIZE);
    const u = new Uint32Array(data);
    const f = new Float32Array(data);
    expect(u[40]).toBe(7);
    expect(u[42]).toBe(40);
    expect(u[48]).toBe(640);
    expect(f[28]).toBeCloseTo(1 / (1.2 * 2 ** -6), 4);
    expect(f[32]).toBeCloseTo((air.horizon * Math.PI) / 180, 6);
    expect(f[52]).toBeCloseTo((air.bends[0] ?? 0) * (Math.PI / 180), 6);
    expect(f[180 + 127 * 4 + 2]).toBeCloseTo(0.6, 6);
});
