import { expect, test } from "@playwright/test";
import {
    atmosphereTopRadiusKm,
    DEFAULT_ATMOSPHERE_MODEL,
    DEFAULT_TEXTURE_CONFIG,
    luminanceScale,
    spectrumToRgb,
} from "../src/model.js";
import { DEFAULT_QUALITY, featureConstants, pipelineConstants } from "../src/quality.js";
import { reflectanceAt } from "../src/spectral.js";
import { ATMOSPHERE_UNIFORM_SIZE, atmosphereUniformData } from "../src/uniforms.js";
import { evaluateWgsl, gpuDevice, wgslSource } from "./gpu.js";

const model = DEFAULT_ATMOSPHERE_MODEL;
const Rg = model.planet.groundRadiusKm;
const Rt = atmosphereTopRadiusKm(model);
const common = wgslSource("common");
// The struct declaration, then the functions that take it. The model arrives as a uniform, exactly as it
// does in a real pass, so these tests exercise the shipped path rather than a test-only one.
const source = `${wgslSource("atmosphere")}\n${common}`;
const uniform = atmosphereUniformData(model);

/** Runs a WGSL expression over the given inputs, returning only the first component of each result. */
async function evaluate(expression: string, inputs: readonly (readonly [number, number])[]): Promise<number[]> {
    const device = await gpuDevice();
    if (!device) return [];

    const results = await evaluateWgsl(
        device,
        source,
        expression,
        inputs.map(([a, b]) => [a, b, 0, 0] as [number, number, number, number]),
        { atmosphere: uniform },
    );
    return results.map((r) => r[0]);
}

test("the uniform packing matches the DkAtmosphere struct field for field", () => {
    // Nothing in the toolchain connects the WGSL struct to the TypeScript that fills its buffer, so the one
    // thing that would silently corrupt every shader is these two drifting apart. Parse the struct and check
    // the packing writes the expected value at each field's offset.
    const struct = wgslSource("atmosphere").slice(wgslSource("atmosphere").indexOf("struct DkAtmosphere"));
    const fields = [...struct.matchAll(/^\s{4}(\w+):\s*(vec4f|mat4x3f|f32),/gm)].map(
        (m) => [m[1] as string, m[2] as string] as const,
    );

    expect(fields.map(([name]) => name)).toEqual([
        "betaR",
        "betaMSca",
        "betaMEx",
        "betaOAbs",
        "solarIlluminance",
        "groundAlbedo",
        "toRgb",
        "Rg",
        "Rt",
        "mieG",
        "HR",
        "HM",
        "ozoneCenter",
        "ozoneHalfWidth",
        "refractivity",
    ]);

    const data = atmosphereUniformData(model);
    expect(data.byteLength).toBe(ATMOSPHERE_UNIFORM_SIZE);

    const matrix = spectrumToRgb(model);
    const expected: Record<string, number | readonly number[]> = {
        betaR: model.rayleigh.beta,
        betaMSca: model.mie.betaScattering,
        betaMEx: model.mie.betaExtinction,
        betaOAbs: model.ozone.betaAbsorption,
        solarIlluminance: model.solarSpectrum.map((e) => e * luminanceScale(model)),
        groundAlbedo: model.wavelengths.map((w) => reflectanceAt(model.groundAlbedo, w)),
        // Column-major, each column a vec3 padded to four floats.
        toRgb: [0, 1, 2, 3].flatMap((j) => [0, 1, 2].map((i) => matrix[i]?.[j] as number).concat(0)),
        Rg: model.planet.groundRadiusKm,
        Rt: atmosphereTopRadiusKm(model),
        mieG: model.mie.g,
        HR: model.rayleigh.scaleHeightKm,
        HM: model.mie.scaleHeightKm,
        ozoneCenter: model.ozone.centerAltitudeKm,
        ozoneHalfWidth: model.ozone.widthKm / 2,
        refractivity: model.refractivity,
    };

    // Walk the struct by WGSL's uniform layout: vec4f and mat4x3f align to 16 bytes, f32 to 4. Float32Array rounds the
    // f64 model values, and Math.fround is that exact rounding, so this is strict equality, not a tolerance.
    let offset = 0;
    for (const [name, type] of fields) {
        const length = { vec4f: 4, mat4x3f: 16, f32: 1 }[type] as number;
        if (type !== "f32") offset = Math.ceil(offset / 4) * 4;
        const values = [expected[name]].flat() as number[];
        values.forEach((v, c) => {
            expect(data[offset + c], `${name}.${c}`).toBe(Math.fround(v));
        });
        offset += length;
    }
    expect(offset).toBe(ATMOSPHERE_UNIFORM_SIZE / 4);
});

test("pipelineConstants names exactly the overrides quality.wgsl declares", () => {
    // Mismatched keys make pipeline creation fail at runtime, well after typechecking has passed, so the two
    // lists are pinned here instead.
    const declared = [...wgslSource("quality").matchAll(/^override\s+(\w+)\s*:/gm)].map((m) => m[1] as string);
    const provided = Object.keys(pipelineConstants(DEFAULT_TEXTURE_CONFIG));

    expect(new Set(provided)).toEqual(new Set(declared));
    expect(provided).toEqual(Object.keys(DEFAULT_QUALITY));
});

test("featureConstants names exactly the overrides features.wgsl declares", () => {
    const declared = [...wgslSource("features").matchAll(/^override\s+(\w+)\s*:/gm)].map((m) => m[1] as string);
    expect(new Set(Object.keys(featureConstants()))).toEqual(new Set(declared));
});

test("pipelineConstants carries the configured sample counts, featureConstants the switches", () => {
    const constants = pipelineConstants(DEFAULT_TEXTURE_CONFIG, { cube: 8 });

    expect(constants.DK_SAMPLES_TRANSMITTANCE).toBe(DEFAULT_TEXTURE_CONFIG.integralSamples.transmittance);
    expect(constants.DK_SAMPLES_SKY_VIEW).toBe(DEFAULT_TEXTURE_CONFIG.integralSamples.skyView);
    expect(constants.DK_SAMPLES_CUBE).toBe(8);
    expect(featureConstants().DK_DITHER).toBe(1);
    expect(featureConstants({ dither: false }).DK_DITHER).toBe(0);
});

test("ray-sphere distances are consistent from the ground and from the top", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;

    // Straight up from the ground is exactly the shell thickness; straight down from the top likewise.
    const [upFromGround, downFromTop, grazing] = await evaluate(
        "vec4f(dkDistanceToTopAtmosphereBoundary(atmosphere, input.x, input.y))",
        [
            [0, 1],
            [Rt - Rg, -1],
            [0, 0],
        ],
    );

    expect(upFromGround).toBeCloseTo(Rt - Rg, 2);
    // Straight down from the top is 2*Rt, the far intersection: this is pure ray-sphere geometry and knows
    // nothing about the ground being in the way, which is why callers check dkIntersectsGround first.
    expect(downFromTop).toBeCloseTo(2 * Rt, 0);
    // A horizontal ray at the ground travels much further than the vertical thickness: the airmass effect.
    expect(grazing as number).toBeGreaterThan((Rt - Rg) * 8);
    expect(grazing as number).toBeCloseTo(Math.sqrt(Rt * Rt - Rg * Rg), 1);
});

test("the horizon cosine and the ground-intersection test agree", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;

    // At the ground the horizon is exactly horizontal; higher up it dips below, by ~1 degree at 1 km, less the air's
    // bending: 0.90 degrees. Bouguer's invariant n r sin(z) in double precision gives it. Both take the altitude, which
    // f32 keeps exact down to a millimeter, where a radius near Rg resolves only ~0.5 m.
    const n = (h: number) => 1 + model.refractivity * Math.exp(-h / model.rayleigh.scaleHeightKm);
    const horizonMu = (h: number) => -Math.sqrt((n(h) * (Rg + h)) ** 2 - (n(0) * Rg) ** 2) / (n(h) * (Rg + h));
    const [atGround, at1km, at1mm] = await evaluate("vec4f(dkHorizonMu(atmosphere, input.x))", [
        [0, 0],
        [1, 0],
        [1e-6, 0],
    ]);
    expect(atGround).toBeCloseTo(0, 6);
    expect((Math.acos(at1km as number) * 180) / Math.PI - 90).toBeCloseTo(0.9, 1);
    expect(at1km).toBeCloseTo(horizonMu(1), 6);
    expect(at1mm).toBeCloseTo(horizonMu(1e-6), 9);

    // Just below the horizon hits ground, just above does not.
    const mu = at1km as number;
    const [below, above] = await evaluate("vec4f(select(0.0, 1.0, dkIntersectsGround(atmosphere, input.x, input.y)))", [
        [1, mu - 1e-4],
        [1, mu + 1e-4],
    ]);
    expect(below).toBe(1);
    expect(above).toBe(0);
});

test("density profiles follow their layers", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;

    const [rayleighGround, rayleighScale, mieGround, mieScale] = await evaluate(
        "vec4f(select(dkDensityRayleigh(atmosphere, input.x), dkDensityMie(atmosphere, input.x), input.y > 0.5))",
        [
            [0, 0],
            [model.rayleigh.scaleHeightKm, 0],
            [0, 1],
            [model.mie.scaleHeightKm, 1],
        ],
    );

    // Both are 1 at sea level and 1/e at their own scale height, which is the definition of a scale height.
    expect(rayleighGround).toBeCloseTo(1, 6);
    expect(mieGround).toBeCloseTo(1, 6);
    expect(rayleighScale).toBeCloseTo(Math.E ** -1, 5);
    expect(mieScale).toBeCloseTo(Math.E ** -1, 5);

    // Ozone is a tent, not an exponential: zero at the ground, peaking at its center altitude.
    const [ozoneGround, ozoneCenter, ozoneEdge] = await evaluate("vec4f(dkDensityOzone(atmosphere, input.x))", [
        [0, 0],
        [model.ozone.centerAltitudeKm, 0],
        [model.ozone.centerAltitudeKm + model.ozone.widthKm / 2, 0],
    ]);
    expect(ozoneGround).toBeCloseTo(0, 6);
    expect(ozoneCenter).toBeCloseTo(1, 6);
    expect(ozoneEdge).toBeCloseTo(0, 6);
});

test("both phase functions integrate to 1 over the sphere", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;

    // A phase function redistributes light, it does not create or destroy it, so its integral over all
    // outgoing directions must be exactly 1. This catches a dropped normalization factor in either one.
    const steps = 4000; // one dispatch, see MAX_INPUTS in gpu.ts; plenty for three decimal places
    const inputs = Array.from({ length: steps }, (_, i) => [-1 + (2 * (i + 0.5)) / steps, 0] as const);

    for (const [name, expression] of [
        ["Rayleigh", "vec4f(dkPhaseRayleigh(input.x))"],
        ["Mie", "vec4f(dkPhaseMie(atmosphere, input.x))"],
    ] as const) {
        const values = await evaluate(expression, inputs);
        const integral = values.reduce((sum, v) => sum + v, 0) * ((2 / steps) * 2 * Math.PI);

        expect(integral, `${name} phase function`).toBeCloseTo(1, 3);
    }
});

test("the Mie phase function is forward-biased and the Rayleigh one is symmetric", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;

    const [rayleighFwd, rayleighBack, mieFwd, mieBack, mieSide] = await evaluate(
        "vec4f(select(dkPhaseRayleigh(input.x), dkPhaseMie(atmosphere, input.x), input.y > 0.5))",
        [
            [1, 0],
            [-1, 0],
            [1, 1],
            [-1, 1],
            [0, 1],
        ],
    );

    expect(rayleighFwd).toBeCloseTo(rayleighBack as number, 6);
    // g = 0.8 puts most of the Mie energy in a tight forward lobe: the glow around the sun.
    expect(mieFwd as number).toBeGreaterThan((mieBack as number) * 100);
    expect(mieFwd as number).toBeGreaterThan((mieSide as number) * 10);
});

test("overrides reach the shader and specialize it", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;

    // Proves the override plumbing end to end: same module, two pipelines, different compiled-in values.
    // This is the mechanism the quality presets and the refraction switch ride on, so that loop bounds stay
    // compile-time constants and a disabled feature leaves no code behind rather than branching per pixel.
    const source = `${wgslSource("quality")}\n${wgslSource("features")}`;
    const expression = "vec4f(f32(DK_SAMPLES_SKY_VIEW), select(0.0, 1.0, DK_DITHER), 0.0, 0.0)";
    const input: [number, number, number, number] = [0, 0, 0, 0];

    const [on] = await evaluateWgsl(device, source, expression, [input], {
        constants: { ...pipelineConstants(DEFAULT_TEXTURE_CONFIG), ...featureConstants() },
    });
    const [off] = await evaluateWgsl(device, source, expression, [input], {
        constants: { ...pipelineConstants(DEFAULT_TEXTURE_CONFIG), ...featureConstants({ dither: false }) },
    });

    expect(on?.[0]).toBe(DEFAULT_TEXTURE_CONFIG.integralSamples.skyView);
    expect(on?.[1]).toBe(1);
    expect(off?.[1]).toBe(0);

    // And the declared defaults apply when nothing is passed.
    const [fallback] = await evaluateWgsl(device, source, expression, [input]);
    expect(fallback?.[0]).toBe(DEFAULT_QUALITY.DK_SAMPLES_SKY_VIEW);
});
