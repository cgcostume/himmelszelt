import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { PARAMS_SIZE, paramsData } from "../dist/index.js";
import { moonOrientation } from "../src/orientation.js";
import { moonOutput } from "../src/wgsl/output.js";
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
    moon: ["params", "camera", "surface", "tonemap", "moon"],
    mips: ["params", "surface", "mips"],
};

for (const [name, fragments] of Object.entries(PASSES)) {
    test(`the ${name} pass compiles from its declared fragments`, async () => {
        const device = await gpuDevice();
        test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
        if (!device) return;
        const errors = await compileWgsl(device, [moonOutput("rgba8unorm"), ...fragments.map(wgslSource)].join("\n"));
        expect(errors, `${name}:\n${errors.join("\n")}`).toEqual([]);
    });
}

test("the params pack to the uniform's size with the flags where the shader reads them", () => {
    const data = paramsData(
        {
            direction: [0, 1, 0],
            angularDiameter: 0.5,
            sunDirection: [1, 0, 0],
            sunIlluminance: 128_000,
            earthshine: 10,
            orientation: moonOrientation({
                direction: [0, 1, 0],
                libration: { longitude: 0, latitude: 0 },
                positionAngleOfAxis: 0,
                parallacticAngle: 0,
            }),
            transmittance: [1, 1, 1],
            inverseViewProjection: new Float32Array(16),
            projectionDistance: 0,
            ev100: 15,
            horizonZ: -1,
            albedoMap: true,
            relief: true,
            law: "lambert",
            eclipse: { axis: [0, 0, -1], moonCenterKm: [0, 0, 384_400], umbraKm: 4600, penumbraKm: 8200 },
            sunAngularDiameter: 0.533,
        },
        null,
    );
    expect(data.byteLength).toBe(PARAMS_SIZE);
    const u = new Uint32Array(data);
    const f = new Float32Array(data);
    // No maps: neither map flag, the eclipse alone; Lambert's law; the umbra's radius where the shader reads it.
    expect(u[56]).toBe(4);
    expect(u[57]).toBe(1);
    expect(f[47]).toBe(4600);
    expect(f[52]).toBeCloseTo(1 / (1.2 * 2 ** 15), 9);
});

/**
 * Renders a full Moon and a new Moon into a small target, linear, without a background, and reads it back: the full
 * Moon's disc is as bright at its limb as at its center, the mean over the disc the geometric albedo's share of the
 * Sun's light over pi, and the new Moon's disc is dark but for the earthshine.
 */
test("a full Moon is flat and as bright as its albedo says, a new Moon dark but for earthshine", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const { createMoonPass } = await import("../dist/index.js");
    const size = 64;
    const pass = await createMoonPass(device, { format: "rgba32float", toneMap: false, background: false });
    const target = device.createTexture({
        size: [size, size],
        format: "rgba32float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const staging = device.createBuffer({
        size: size * size * 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    // A camera looking north with a field of view just wider than the Moon, the Moon at its center, exposed at 1.
    const angularDiameter = 0.5;
    const half = Math.tan(((angularDiameter * 1.1) / 2) * (Math.PI / 180));
    const inverseViewProjection = new Float32Array([half, 0, 0, 0, 0, 0, half, 0, 0, 0, 0, 1, 0, 1, 0, 0]);
    const render = async (sunDirection: [number, number, number], earthshine: number) => {
        pass.update({
            direction: [0, 1, 0],
            angularDiameter,
            sunDirection,
            earthshine,
            inverseViewProjection,
            ev100: -Math.log2(1.2),
        });
        const encoder = device.createCommandEncoder();
        pass.encode(encoder, target);
        encoder.copyTextureToBuffer({ texture: target }, { buffer: staging, bytesPerRow: size * 16 }, [size, size]);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const pixels = new Float32Array(staging.getMappedRange()).slice();
        staging.unmap();
        return pixels;
    };
    const at = (pixels: Float32Array, x: number, y: number) => pixels[(y * size + x) * 4] ?? 0;
    const alpha = (pixels: Float32Array, x: number, y: number) => pixels[(y * size + x) * 4 + 3] ?? 0;

    // The Sun from behind the viewer, the Moon full: a Lambert disc of albedo 0.12 in 128,000 lux.
    const full = await render([0, -1, 0], 0);
    const expected = (0.12 * 128_000) / Math.PI;
    const center = at(full, 32, 32);
    expect(center).toBeGreaterThan(expected * 0.95);
    expect(center).toBeLessThan(expected * 1.05);
    // Near the limb, 90 % of the radius out, still as bright: Lommel-Seeliger, not Lambert.
    const limb = at(full, 32 + Math.round(29 * 0.9), 32);
    expect(limb).toBeGreaterThan(center * 0.95);
    expect(alpha(full, 32, 32)).toBe(1);
    expect(alpha(full, 1, 1)).toBe(0);

    // The Sun behind the Moon: its disc dark but for a full Earth's 13 lux.
    const dark = await render([0, 1, 0], 13);
    const night = at(dark, 32, 32);
    expect(night).toBeGreaterThan(0);
    expect(night).toBeLessThan(expected * 2e-4);
    expect(night).toBeCloseTo((0.12 * 13) / Math.PI, 1);

    for (const resource of [target, staging]) resource.destroy();
    pass.destroy();
});
