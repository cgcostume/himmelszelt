import { readFileSync } from "node:fs";
import { DEFAULT_ATMOSPHERE_MODEL, lightThroughAir } from "@himmelszelt/dunstkreis";
import { MOON_WHITE, SUN_WHITE, whiteBalance } from "@himmelszelt/helldunkel";
import { expect, test } from "@playwright/test";
import { reisszeugSource } from "../../../reisszeug/source.js";
import { MOON_COLOR, PARAMS_SIZE, paramsData, TABLES_SIZE, tablesData } from "../dist/index.js";
import {
    moonOrientation,
    phaseLaw,
    type RefractionTable,
    refractionTable,
    SUN_COLOR,
    SUN_ILLUMINANCE,
} from "../src/orientation.js";
import { moonOutput } from "../src/wgsl/output.js";
import { compileWgsl, gpuDevice } from "./gpu.js";

/** A shader by name, this package's or one of the fragments it bundles from the packages that own them. */
function wgslSource(name: string): string {
    // Fragments composed with reisszeug's chunks, as `wgsl` composes them.
    const shared = { noise: ["hash", "noise"], shimmer: ["turbulence"] }[name];
    if (shared)
        return [
            ...shared.map((chunk) => reisszeugSource(chunk, "ng")),
            readFileSync(new URL(`../src/wgsl/${name}.comp.wgsl`, import.meta.url), "utf8"),
        ].join("\n");
    const helldunkel = "../../helldunkel/src/wgsl";
    const owner =
        {
            camera: "../../dunstkreis/src/wgsl",
            cube: "../../rundbild/src/wgsl",
            tonemap: helldunkel,
            vision: helldunkel,
            whitebalance: helldunkel,
        }[name] ?? "../src/wgsl";
    const read = (file: string) => readFileSync(new URL(`${owner}/${file}`, import.meta.url), "utf8");
    try {
        return read(`${name}.wgsl`);
    } catch {
        return read(`${name}.comp.wgsl`);
    }
}

// Each pass with exactly the fragments its header names, so none grows a dependency it does not declare.
// The Moon pass takes any law that defines `ngReflectance`: Hapke's of 2012, or of 1963.
const MOON = ["params", "surface", "reflectance", "camera", "whitebalance", "tonemap", "vision", "moon"];
const PASSES: Record<string, readonly string[]> = {
    moon: MOON,
    "moon with Hapke's law of 1963": MOON.map((name) => (name === "reflectance" ? "hapke1963" : name)),
    mips: ["surface", "mips"],
    bc1: ["bc1"],
    noise: ["noise"],
    relief: ["surface", "relief"],
    shadow: [...MOON, "shadow"],
    shimmer: [...MOON, "shimmer"],
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

test("the params and tables pack to the uniforms' sizes with the flags where the shader reads them", () => {
    const params = {
        direction: [0, 1, 0],
        angularDiameter: 0.5,
        sunDirection: [1, 0, 0],
        sunIlluminance: 128_000,
        sunColor: SUN_COLOR,
        whiteBalance: whiteBalance(MOON_WHITE),
        exposureCompensation: 0,
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
        shadows: true,
        roughness: false,
        mapColor: "tinted" as const,
        earthDirection: null,
        shimmer: null,
        // The Moon in the middle of Earth's shadow.
        eclipse: { axis: [0, 0, 1], moonCenterKm: [0, 0, 384_400], umbraKm: 4600, penumbraKm: 8200 },
        sunAngularDiameter: 0.533,
        refraction: refractionTable([0, 1, 0], 0.5, () => 0.5),
        distanceKm: 384_400,
    } satisfies Parameters<typeof paramsData>[0];
    const data = paramsData(params, null);
    expect(data.byteLength).toBe(PARAMS_SIZE);
    const u = new Uint32Array(data);
    const f = new Float32Array(data);
    // No maps: neither map flag; earthshine, the air and the eclipse; the penumbra's radius where the shader reads it.
    expect(u[61]).toBe(16 | 32 | 64);
    expect(f[87]).toBe(8200);
    expect(f[44]).toBeCloseTo(1 / (1.2 * 2 ** 15), 9);
    // Earth's center from the Moon due north on the horizon: south, a degree below.
    expect(f[37]).toBeCloseTo(-1, 3);
    expect(f[38]).toBeCloseTo(-6371 / 384_400, 3);
    // The Sun's color after the shimmer's rows, and the white balance a column to a row.
    expect([...f.subarray(100, 103)]).toEqual([...new Float32Array(SUN_COLOR)]);
    const balance = whiteBalance(MOON_WHITE);
    for (let col = 0; col < 3; col++)
        for (let row = 0; row < 3; row++) expect(f[104 + col * 4 + row]).toBeCloseTo(balance[col * 3 + row] ?? 0, 6);
    // Away from Earth's shadow the eclipse is left out.
    const away = paramsData({ ...params, eclipse: { ...params.eclipse, moonCenterKm: [30_000, 0, 384_400] } }, null);
    expect(new Uint32Array(away)[61]).toBe(16 | 32);
    // The air's table: its bends first.
    const tables = tablesData(params);
    expect(tables.byteLength).toBe(TABLES_SIZE);
    expect(new Float32Array(tables)[0]).toBeCloseTo(0.5 * (Math.PI / 180), 6);
});

test("the Sun's color is dunstkreis' and helldunkel's, and the Moon's white the Sun's as the Moon reflects it", () => {
    const luminance = ([r, g, b]: readonly number[]) => 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    expect(luminance(SUN_COLOR)).toBeCloseTo(1, 3);
    expect([...SUN_COLOR]).toEqual([...SUN_WHITE]);
    // Above the air, where dunstkreis' Sun is what its spectrum makes it.
    const above = lightThroughAir(DEFAULT_ATMOSPHERE_MODEL, [0, 0, 1], 200_000);
    for (const [i, c] of above.entries()) expect(c / SUN_ILLUMINANCE).toBeCloseTo(SUN_COLOR[i] ?? 0, 3);
    const moon = SUN_COLOR.map((c, i) => c * (MOON_COLOR[i] ?? 1));
    for (const [i, c] of moon.entries()) expect(c / luminance(moon)).toBeCloseTo(MOON_WHITE[i] ?? 0, 3);
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
    const { createMoonPass, wgsl } = await import("../dist/index.js");
    const size = 64;
    // The defaults: the Moon alone, linear, premultiplied.
    const pass = await createMoonPass(device, { format: "rgba32float" });
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
    const render = async (
        sunDirection: [number, number, number],
        earthshine: number,
        refraction: RefractionTable | null = null,
        through = pass,
        balance = whiteBalance([1, 1, 1]),
    ) => {
        through.update({
            refraction,
            whiteBalance: balance,
            direction: [0, 1, 0],
            angularDiameter,
            sunDirection,
            earthshine,
            inverseViewProjection,
            ev100: -Math.log2(1.2),
        });
        const encoder = device.createCommandEncoder();
        through.encode(encoder, target);
        encoder.copyTextureToBuffer({ texture: target }, { buffer: staging, bytesPerRow: size * 16 }, [size, size]);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const pixels = new Float32Array(staging.getMappedRange()).slice();
        staging.unmap();
        return pixels;
    };
    const channel = (pixels: Float32Array, x: number, y: number, c: number) => pixels[(y * size + x) * 4 + c] ?? 0;
    const alpha = (pixels: Float32Array, x: number, y: number) => channel(pixels, x, y, 3);
    const luminance = (pixels: Float32Array, x: number, y: number) =>
        0.2126 * channel(pixels, x, y, 0) + 0.7152 * channel(pixels, x, y, 1) + 0.0722 * channel(pixels, x, y, 2);
    const at = luminance;

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
    // Without maps a rock of the Moon's color in the Sun's; balanced on the Sun the Moon's own color, on the Moon gray,
    // both within a percent, as Bradford's adaptation is not a division per channel.
    const lum = (v: readonly number[]) => 0.2126 * (v[0] ?? 0) + 0.7152 * (v[1] ?? 0) + 0.0722 * (v[2] ?? 0);
    const tint = MOON_COLOR.map((c) => c / lum(MOON_COLOR));
    const lit = tint.map((t, c) => t * (SUN_COLOR[c] ?? 0));
    for (const c of [0, 1, 2]) expect(channel(full, 32, 32, c) / center).toBeCloseTo((lit[c] ?? 0) / lum(lit), 3);
    const onSun = await render([0, -1, 0], 0, null, pass, whiteBalance(SUN_WHITE));
    const sunCenter = at(onSun, 32, 32);
    for (const c of [0, 1, 2]) expect(channel(onSun, 32, 32, c) / sunCenter).toBeCloseTo(tint[c] ?? 0, 1);
    const onMoon = await render([0, -1, 0], 0, null, pass, whiteBalance(MOON_WHITE));
    const moonCenter = at(onMoon, 32, 32);
    for (const c of [0, 1, 2]) expect(channel(onMoon, 32, 32, c) / moonCenter).toBeCloseTo(1, 1);

    // The Sun behind the Moon: its disc dark but for a full Earth's 13 lux, bluer than sunlight, as bright.
    const dark = await render([0, 1, 0], 13);
    const night = luminance(dark, 32, 32);
    const blueOverRed = (pixels: Float32Array) => channel(pixels, 32, 32, 2) / channel(pixels, 32, 32, 0);
    expect(blueOverRed(dark)).toBeGreaterThan(blueOverRed(full));
    expect(night).toBeGreaterThan(0);
    expect(night).toBeLessThan(expected * 2e-4);
    expect(night).toBeCloseTo((0.12 * 13) / Math.PI, 1);

    // Squeezed by a refraction that bends rays a quarter of their altitude up: 0.8 of its height, as wide as before.
    const squeezed = await render(
        [0, -1, 0],
        0,
        refractionTable([0, 1, 0], angularDiameter, (a) => -0.25 * a),
    );
    const extent = (pixels: Float32Array, along: (i: number) => [number, number]) =>
        Array.from({ length: size }, (_, i) => alpha(pixels, ...along(i))).reduce((sum, a) => sum + a, 0);
    const wide = extent(squeezed, (i) => [i, 32]);
    expect(wide).toBeCloseTo(
        extent(full, (i) => [i, 32]),
        0,
    );
    expect(extent(squeezed, (i) => [32, i]) / wide).toBeCloseTo(0.8, 1);

    // With transmittances, each ray dimmed by its own: half at the lower limb, all at the upper, as the table says.
    const graded = await render(
        [0, -1, 0],
        0,
        refractionTable(
            [0, 1, 0],
            angularDiameter,
            () => 0,
            (a) => {
                const t = Math.min(Math.max(0.75 + a / angularDiameter, 0.5), 1);
                return [t, t, t];
            },
        ),
    );
    const rows = [5, 32, 58].map((y) => at(graded, 32, y) / at(full, 32, y));
    expect(rows[0]).toBeGreaterThan(0.9);
    expect(rows[1]).toBeCloseTo(0.75, 1);
    expect(rows[2]).toBeLessThan(0.6);

    // At the quarters the disc averages close to what the meter's phase law says, a tenth of the full Moon: 0.84 of
    // it under Hapke's law of 1963 after Jensen et al., falling a quarter of a stop faster than Allen's, a law that
    // takes the default's place as a snippet of its own.
    const mean = (pixels: Float32Array) => {
        let [sum, covered] = [0, 0];
        for (let i = 0; i < size * size; i++) {
            sum += pixels[i * 4 + 1] ?? 0;
            covered += pixels[i * 4 + 3] ?? 0;
        }
        return sum / covered;
    };
    const pass1963 = await createMoonPass(device, { format: "rgba32float", reflectance: wgsl.hapke1963 });
    const full1963 = await render([0, -1, 0], 0, null, pass1963);
    const quarter = mean(await render([1, 0, 0], 0, null, pass1963)) / mean(full1963);
    pass1963.destroy();
    expect(quarter / phaseLaw(90)).toBeGreaterThan(0.8);
    expect(quarter / phaseLaw(90)).toBeLessThan(0.9);

    // Hapke's 2012 model, the default: its full Moon as bright at the center as the albedo says, and its quarter a third
    // of a stop under Allen's, as the site's copy of the law integrates it over the disc (0.81).
    const full2012 = full;
    expect(at(full2012, 32, 32) / expected).toBeCloseTo(1, 1);
    const quarter2012 = mean(await render([1, 0, 0], 0)) / mean(full2012);
    expect(quarter2012 / phaseLaw(90)).toBeGreaterThan(0.76);
    expect(quarter2012 / phaseLaw(90)).toBeLessThan(0.86);

    for (const resource of [target, staging]) resource.destroy();
    pass.destroy();
});

test("the pass compiles with night vision", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const { createMoonPass } = await import("../dist/index.js");
    device.pushErrorScope("validation");
    const pass = await createMoonPass(device, { background: true, toneMap: "neutral", darkAdapted: true });
    expect(await device.popErrorScope()).toBeNull();
    pass.destroy();
});
