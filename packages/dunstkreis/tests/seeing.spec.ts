import { expect, test } from "@playwright/test";
import { type AirTable, airAt, airTable } from "../src/air.js";
import { DEFAULT_ATMOSPHERE_MODEL } from "../src/model.js";
import {
    SEEING_UNIFORM_SIZE,
    type Seeing,
    scintillation,
    scintillationIndex,
    seeingUniformData,
    shimmerScales,
    type Turbulence,
    turbulenceStrength,
    turbulenceThrough,
    turbulenceWind,
    zenithScintillation,
    zenithTilt,
} from "../src/seeing.js";
import { evaluateWithAir } from "./airgpu.js";
import { gpuDevice, wgslSource } from "./gpu.js";

const model = DEFAULT_ATMOSPHERE_MODEL;
const DEG = Math.PI / 180;
const ARCSEC = Math.PI / 648_000;
const tables = new Map<number, AirTable>();
const tableAt = (heightM: number) => {
    const table = tables.get(heightM) ?? airTable(model, heightM);
    tables.set(heightM, table);
    return table;
};
const air = (heightM: number, altitude: number) => {
    const found = airAt(tableAt(heightM), altitude);
    if (!found) throw new Error(`${altitude}° is below the horizon from ${heightM} m`);
    return found;
};
const eye: Seeing = {};
const lens: Seeing = { aperture: 0.1 };

test("the profile is Hufnagel and Valley's 5/7: Fried's 5 cm and 7 µrad at 500 nm, and Bufton's wind", () => {
    let strength = 0;
    for (let h = 0.01; h < 30_000; h *= 1.01) strength += turbulenceStrength(h * 1.005) * h * 0.01;
    const k = (2 * Math.PI) / 500e-9;
    const r0 = (0.423 * k * k * strength) ** (-3 / 5);
    expect(r0).toBeCloseTo(0.05, 2);
    // The isoplanatic angle, 0.314 r0 over the turbulence's distance, which the table holds for a ray straight up.
    const distance = air(0, 90).seeing.distanceM;
    expect((0.314 * r0) / distance / 1e-6).toBeCloseTo(7, 0);
    expect(turbulenceStrength(40_000)).toBe(0);

    let squares = 0;
    for (let h = 5000; h < 20_000; h += 10) squares += turbulenceWind(h + 5) ** 2 * 10;
    expect(Math.sqrt(squares / 15_000)).toBeCloseTo(1, 2);
    expect(turbulenceWind(0)).toBeCloseTo(0.25, 2);
    expect(turbulenceWind(9400)).toBeCloseTo(1.52, 2);
});

test("straight up from sea level the table's turbulence is one, and the flat Earth's holds well above the horizon", () => {
    const zenith = air(0, 90);
    expect(zenith.seeing.amount).toBeCloseTo(1, 2);
    expect(zenith.scintillation.amount).toBeCloseTo(1, 2);
    // Most of the seeing comes from the first kilometers, most of the flicker from the tropopause.
    expect(zenith.seeing.distanceM).toBeGreaterThan(2000);
    expect(zenith.seeing.distanceM).toBeLessThan(2600);
    expect(zenith.scintillation.distanceM).toBeGreaterThan(6500);
    expect(zenith.scintillation.distanceM).toBeLessThan(8500);
    expect(zenith.scintillation.wind).toBeGreaterThan(2 * zenith.seeing.wind);
    for (const altitude of [30, 60]) {
        const traced = air(0, altitude);
        const flat = turbulenceThrough(traced.airmass);
        for (const part of ["seeing", "scintillation"] as const) {
            expect(Math.abs(traced[part].amount / flat[part].amount - 1)).toBeLessThan(0.02);
            expect(Math.abs(traced[part].distanceM / flat[part].distanceM - 1)).toBeLessThan(0.02);
            expect(Math.abs(traced[part].wind / flat[part].wind - 1)).toBeLessThan(0.02);
        }
    }
});

test("the image moves by half an arcsecond overhead through a 10 cm lens, and with the root of the turbulence", () => {
    expect(zenithTilt(lens) / ARCSEC).toBeCloseTo(0.48, 2);
    expect(zenithTilt(eye) / ARCSEC).toBeCloseTo(0.75, 2);
    expect(zenithTilt({ r0: 0.05, aperture: 0.1 }) / zenithTilt(lens)).toBeCloseTo(2 ** (5 / 6), 6);
    const turbulence: Turbulence = { amount: 4, distanceM: 10_000, wind: 0.5 };
    const scales = shimmerScales({ aperture: 0.1, wind: 10 }, turbulence);
    expect(scales.tilt).toBeCloseTo(2 * zenithTilt(lens), 12);
    expect(scales.cell).toBeCloseTo(1e-5, 12);
    expect(scales.drift).toBeCloseTo(5e-4, 12);
    // Low over the ground the Moon trembles by arcseconds, from a mountain by less.
    expect(shimmerScales(lens, air(0, 15).seeing).tilt / ARCSEC).toBeCloseTo(0.94, 1);
    expect(shimmerScales(lens, air(0, 0.5).seeing).tilt / ARCSEC).toBeGreaterThan(4);
    expect(shimmerScales(lens, air(3000, 15).seeing).tilt).toBeLessThan(
        0.5 * shimmerScales(lens, air(0, 15).seeing).tilt,
    );
});

test("a star flickers by a twelfth overhead to the eye, more towards the horizon, and saturates", () => {
    // Dravins et al.'s 19.2 λ^(-7/6) ∫ Cn² h^(5/6) dh over the profile as it is, r0 = 5.56 cm at 550 nm.
    let moment = 0;
    for (let h = 0.01; h < 30_000; h *= 1.01)
        moment += turbulenceStrength(h * 1.005) * (h * 1.005) ** (5 / 6) * h * 0.01;
    expect(zenithScintillation({ r0: 0.0556 })).toBeCloseTo(19.2 * 550e-9 ** (-7 / 6) * moment, 2);
    expect(zenithScintillation()).toBeCloseTo(0.079, 3);

    expect(scintillationIndex(eye, air(0, 90).scintillation)).toBeCloseTo(0.076, 2);
    expect(scintillationIndex(eye, air(0, 30).scintillation)).toBeCloseTo(0.17, 2);
    expect(scintillationIndex(eye, air(0, 10).scintillation)).toBeCloseTo(0.39, 2);
    // Never more than a variance of 1 before any averaging: the index stays below sqrt(ln 2).
    for (const altitude of [5, 1, 0]) {
        const index = scintillationIndex({ exposure: 0 }, air(0, altitude).scintillation);
        expect(index).toBeCloseTo(Math.sqrt(Math.log(2)), 2);
    }
    // The flicker of the Fresnel scale, some 6 cm, crossing at the jet stream's speed: a few milliseconds.
    const { time } = scintillation(eye, air(0, 90).scintillation);
    expect(time).toBeGreaterThan(0.003);
    expect(time).toBeLessThan(0.005);
});

test("a wider lens and a longer exposure average the flicker out, and steadier air has less of it", () => {
    const turbulence = air(0, 45).scintillation;
    const index = (seeing: Seeing) => scintillationIndex(seeing, turbulence);
    expect(index({ aperture: 0.1 })).toBeLessThan(0.6 * index(eye));
    expect(index({ aperture: 1 })).toBeLessThan(0.1 * index(eye));
    expect(index({ exposure: 1 })).toBeLessThan(0.4 * index(eye));
    expect(index({ exposure: 0.001 })).toBeGreaterThan(3 * index(eye));
    expect(index({ r0: 0.2 })).toBeLessThan(0.6 * index(eye));
    expect(index({ wind: 42 })).toBeLessThan(index(eye));
    // In orbit the observer's own 7.7 km/s sweeps the ray through the turbulence, and the eye averages nearly all of it.
    const limb = air(408_000, tableAt(408_000).horizon + 0.3).scintillation;
    expect(scintillation({ speed: 7700 }, limb).time).toBeLessThan(0.01 * scintillation(eye, limb).time);
    expect(scintillationIndex({ speed: 7700 }, limb)).toBeLessThan(0.2 * scintillationIndex(eye, limb));
    expect(shimmerScales({ speed: 7700 }, limb).drift).toBeGreaterThan(100 * shimmerScales(eye, limb).drift);
});

test("the flicker thins out with height: half gone by 2 km, most by 12, all of it above 30", () => {
    const variance = (heightM: number) => scintillation({ exposure: 0 }, air(heightM, 90).scintillation).variance;
    expect(variance(2000) / variance(0)).toBeCloseTo(0.55, 1);
    expect(variance(12_000) / variance(0)).toBeLessThan(0.1);
    expect(variance(31_000)).toBe(0);
    expect(scintillationIndex(eye, air(408_000, -17).scintillation)).toBe(0);
});

test("looking down from high up a ray crosses more turbulence, not less: the airmass of 1 / sin is no measure", () => {
    for (const heightM of [5000, 20_000, 408_000]) {
        const table = tableAt(heightM);
        let last = Number.POSITIVE_INFINITY;
        for (let i = 0; i <= 100; ++i) {
            const altitude = table.horizon + ((table.top - table.horizon) * i) / 100;
            const { amount } = air(heightM, altitude).scintillation;
            expect(amount).toBeLessThanOrEqual(last * (1 + 1e-6));
            last = amount;
        }
    }
    // From a balloon at 20 km a star 3° below the level shines through the tropopause twice; one 3° above it through
    // none of it.
    expect(air(20_000, -3).scintillation.amount).toBeGreaterThan(100 * air(20_000, 3).scintillation.amount);
    // From orbit a star setting through the limb flickers at full strength, the turbulence 2000 km away.
    const limb = air(408_000, tableAt(408_000).horizon + 0.3);
    expect(limb.scintillation.distanceM).toBeGreaterThan(2e6);
    expect(scintillation({ exposure: 0 }, limb.scintillation).variance).toBeCloseTo(1, 2);
});

test("the uniform packing matches the DkSeeing struct", () => {
    const fields = [...wgslSource("seeing").matchAll(/^ {4}(\w+): f32,$/gm)].map((m) => m[1]);
    expect(fields.slice(0, 6)).toEqual(["tilt", "variance", "aperture", "exposure", "wind", "speed"]);
    expect(fields.length * 4).toBe(SEEING_UNIFORM_SIZE);
    const seeing = { r0: 0.07, wind: 15, aperture: 0.05, exposure: 0.02, speed: 250 };
    const data = seeingUniformData(seeing);
    expect(data[0]).toBeCloseTo(zenithTilt(seeing), 12);
    expect(data[1]).toBeCloseTo(zenithScintillation(seeing), 6);
    expect([...data.subarray(2, 6)].map((v) => Math.round(v * 1e4) / 1e4)).toEqual([0.05, 0.02, 15, 250]);
});

test("the WGSL flicker is the TypeScript one's, lognormal with its variance, and colored where the air disperses", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const table = tableAt(100);
    // The variance and the time, for a pupil and a lens, over the sky.
    for (const seeing of [eye, { aperture: 0.1, exposure: 0.004, wind: 30, r0: 0.06 }, { speed: 300 }]) {
        const altitudes = [0, 0.5, 2, 5, 10, 20, 30, 45, 60, 90];
        const got = await evaluateWithAir(
            device,
            table,
            "vec4f(dkScintillationOf(seeing, dkAirAt(air, input.x).scintillation), 0.0, 0.0)",
            altitudes.map((a) => [a * DEG, 0, 0, 0] as [number, number, number, number]),
            seeing,
        );
        altitudes.forEach((altitude, i) => {
            const expected = scintillation(seeing, air(100, altitude).scintillation);
            expect(Math.abs((got[i]?.[0] ?? 0) / expected.variance - 1)).toBeLessThan(5e-3);
            expect(Math.abs((got[i]?.[1] ?? 0) / expected.time - 1)).toBeLessThan(5e-3);
        });
    }

    // 4096 stars at one altitude and one moment: the mean of their light stays 1, its logarithm spreads by the index.
    const stars = (altitude: number, time: number) =>
        evaluateWithAir(
            device,
            table,
            `vec4f(dkScintillation(seeing, dkAirAt(air, ${altitude * DEG}), u32(input.x), ${time} + input.y), 0.0)`,
            Array.from({ length: 4096 }, (_, i) => [i, 0, 0, 0] as [number, number, number, number]),
        );
    const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
    const deviation = (values: number[]) => Math.sqrt(mean(values.map((v) => (v - mean(values)) ** 2)));
    const correlation = (a: number[], b: number[]) =>
        mean(a.map((v, i) => (v - mean(a)) * ((b[i] as number) - mean(b)))) / (deviation(a) * deviation(b));
    for (const [altitude, time] of [
        [90, 3.21],
        [20, 0.5],
        [3, 7.77],
    ] as const) {
        const light = await stars(altitude, time);
        const sigma = scintillationIndex(eye, air(100, altitude).scintillation);
        const logs = [0, 1, 2].map((c) => light.map((star) => Math.log(star[c] as number)));
        for (const channel of [0, 1, 2]) {
            expect(Math.abs(mean(light.map((star) => star[channel] as number)) - 1)).toBeLessThan(0.03);
            expect(Math.abs(deviation(logs[channel] as number[]) / sigma - 1)).toBeLessThan(0.05);
        }
        // Overhead nothing parts the colors and a star flickers white; low, each channel flickers on its own.
        const together = correlation(logs[0] as number[], logs[2] as number[]);
        if (altitude === 90) expect(together).toBeGreaterThan(0.999);
        if (altitude === 3) expect(Math.abs(together)).toBeLessThan(0.1);
    }

    // A millisecond on, the light has hardly changed; an exposure on, it is another.
    const [now, soon, later] = [await stars(20, 0.5), await stars(20, 0.501), await stars(20, 0.75)];
    const green = (light: number[][]) => light.map((star) => Math.log(star[1] as number));
    expect(correlation(green(now), green(soon))).toBeGreaterThan(0.99);
    expect(Math.abs(correlation(green(now), green(later)))).toBeLessThan(0.1);
});
