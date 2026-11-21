import { expect, test } from "@playwright/test";
import {
    AIR_TABLE_ROWS,
    AIR_TABLE_WIDTH,
    type AirTable,
    airAt,
    airLift,
    airShows,
    airTable,
    airTableFrom,
    liftedDirection,
    unbentDirection,
} from "../src/air.js";
import { DEFAULT_ATMOSPHERE_MODEL } from "../src/model.js";
import { airTransmittance, apparentDirection, apparentHorizon, refractionAngle } from "../src/refraction.js";
import { turbulenceThrough } from "../src/seeing.js";
import { evaluateWithAir } from "./airgpu.js";
import { gpuDevice } from "./gpu.js";

const model = DEFAULT_ATMOSPHERE_MODEL;
const DEG = Math.PI / 180;
const ARCSEC = 1 / 3600;
// From the ground, a hill, a mountain, a plane, above nearly all the air, from just above it and from orbit.
const HEIGHTS = [1, 300, 2000, 10_000, 50_000, 99_000, 101_000, 408_000];
const tables = new Map<number, AirTable>();
const tableAt = (heightM: number) => {
    const table = tables.get(heightM) ?? airTable(model, heightM);
    tables.set(heightM, table);
    return table;
};

let seed = 1;
const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
};
const towards = (altitude: number): [number, number, number] => [
    0.6 * Math.cos(altitude * DEG),
    0.8 * Math.cos(altitude * DEG),
    Math.sin(altitude * DEG),
];
const altitudeOf = ([x, y, z]: readonly number[]) =>
    Math.atan2(z as number, Math.hypot(x as number, y as number)) / DEG;

test("the table holds its rows as the layout says", () => {
    const table = tableAt(10_000);
    expect(table.data.length).toBe(AIR_TABLE_WIDTH * AIR_TABLE_ROWS * 4);
    const range = table.data.subarray(4 * AIR_TABLE_WIDTH * 4, 4 * AIR_TABLE_WIDTH * 4 + 5);
    [table.horizon, table.top, table.trueHorizon, table.trueTop].forEach((altitude, i) => {
        expect(range[i]).toBeCloseTo(altitude * DEG, 6);
    });
    expect(range[4]).toBe(10_000);
    // The first entry is the horizon's ray, the last the zenith's: its bend in the fourth channel of row 0.
    const grazing = refractionAngle(model, 10_000, table.horizon + 1e-6) as number;
    expect(table.data[3]).toBeCloseTo(grazing * DEG, 7);
    expect(table.data[(AIR_TABLE_WIDTH - 1) * 4 + 3]).toBeCloseTo(0, 9);
    expect(table.trueHorizon).toBeCloseTo(table.horizon - grazing, 6);
});

test("the horizon is the lowest ray the tracing follows", () => {
    for (const heightM of HEIGHTS) {
        const horizon = apparentHorizon(model, heightM);
        expect(refractionAngle(model, heightM, horizon - 1e-6)).toBeNull();
        expect(refractionAngle(model, heightM, horizon + 1e-6)).not.toBeNull();
        expect(airAt(tableAt(heightM), horizon - 1e-3)).toBeNull();
    }
    // 20° below the level from the station's orbit, the air's top 2.6° above it.
    expect(tableAt(408_000).horizon).toBeCloseTo(-19.95, 1);
    expect(tableAt(408_000).top).toBeCloseTo(-17.35, 1);
    expect(tableAt(1).top).toBe(90);
});

test("between its entries the table reads what the tracing gives, to half an arcsecond", () => {
    for (const heightM of HEIGHTS) {
        const table = tableAt(heightM);
        for (let i = 0; i < 150; ++i) {
            const altitude = table.horizon + (table.top - table.horizon) * random() ** 3 + 1e-9;
            const air = airAt(table, altitude);
            const bend = refractionAngle(model, heightM, altitude) as number;
            const through = airTransmittance(model, heightM, altitude) as number[];
            expect(Math.abs((air?.bend ?? 0) - bend)).toBeLessThan(0.6 * ARCSEC);
            through.forEach((t, c) => {
                expect(Math.abs((air?.transmittance[c] ?? 0) - t)).toBeLessThan(4e-3);
            });
        }
    }
});

test("lifted is the inverse of unbent, and where apparentDirection puts a body", () => {
    for (const heightM of HEIGHTS) {
        const table = tableAt(heightM);
        for (let i = 0; i < 100; ++i) {
            const apparent = table.horizon + (table.top - table.horizon) * random() ** 3;
            // To a fiftieth of an arcsecond: the lift's one step of Newton's lands on the bend's own row.
            const back = altitudeOf(liftedDirection(table, unbentDirection(table, towards(apparent))));
            expect(Math.abs(back - apparent)).toBeLessThan(0.02 * ARCSEC);
        }
        for (let i = 0; i < 30; ++i) {
            const real = table.trueHorizon + 0.02 + (table.trueTop - table.trueHorizon - 0.02) * random() ** 3;
            const lifted = liftedDirection(table, towards(real));
            const traced = apparentDirection(towards(real), model, heightM);
            expect(Math.abs(altitudeOf(lifted) - altitudeOf(traced))).toBeLessThan(0.6 * ARCSEC);
            // Turned within its vertical plane: the azimuth and the length stay.
            expect(lifted[0] / lifted[1]).toBeCloseTo(0.75, 9);
            expect(Math.hypot(...lifted)).toBeCloseTo(1, 12);
        }
    }
});

test("from orbit the air squeezes the limb fourfold, and the lift still inverts it in one lookup", () => {
    const table = tableAt(408_000);
    // A degree of true altitude above the horizon shows within a quarter of one: iterating on the bend would diverge.
    const shown = airLift(table, table.trueHorizon + 1) + table.trueHorizon + 1 - table.horizon;
    expect(shown).toBeGreaterThan(0.15);
    expect(shown).toBeLessThan(0.3);
    const slope = ((airAt(table, table.horizon + 0.02)?.bend ?? 0) - (airAt(table, table.horizon)?.bend ?? 0)) / 0.02;
    expect(slope).toBeLessThan(-2);
});

test("the dilution is the squeeze: 1 overhead, 0.78 on the ground's horizon, a tenth at the limb from orbit", () => {
    const ground = tableAt(1);
    expect(airAt(ground, 90)?.dilution).toBeCloseTo(1, 3);
    expect(airAt(ground, 45)?.dilution).toBeCloseTo(1, 2);
    expect(airAt(ground, ground.horizon)?.dilution).toBeCloseTo(0.78, 1);
    const orbit = tableAt(408_000);
    expect(airAt(orbit, orbit.horizon)?.dilution).toBeGreaterThan(0.07);
    expect(airAt(orbit, orbit.horizon)?.dilution).toBeLessThan(0.13);
    expect(airAt(orbit, orbit.top)?.dilution).toBeCloseTo(1, 3);
    // It is the apparent altitude gained per true one, which the lift's row holds the other way round.
    for (const table of [ground, tableAt(10_000), orbit]) {
        for (const share of [0.001, 0.01, 0.1, 0.5]) {
            const real = table.trueHorizon + (table.trueTop - table.trueHorizon) * share;
            const step = 0.002;
            const shown = (altitude: number) => altitude + airLift(table, altitude);
            const gained = (shown(real + step) - shown(real - step)) / (2 * step);
            expect(Math.abs((airAt(table, shown(real))?.dilution ?? 0) / gained - 1)).toBeLessThan(0.03);
        }
    }
});

test("a body below the true horizon sinks on behind the ground, hidden", () => {
    for (const heightM of [1, 10_000, 408_000]) {
        const table = tableAt(heightM);
        const rate = airLift(table, table.trueHorizon);
        expect(rate).toBeCloseTo(table.horizon - table.trueHorizon, 4);
        const below = liftedDirection(table, towards(table.trueHorizon - 0.5));
        expect(altitudeOf(below)).toBeCloseTo(table.horizon - 0.5, 4);
        expect(airShows(table, below)).toBe(false);
        expect(airShows(table, liftedDirection(table, towards(table.trueHorizon + 0.01)))).toBe(true);
    }
});

test("the airmass is the air crossed: one overhead from sea level, some 40 at the horizon, more looking down", () => {
    const ground = tableAt(1);
    expect(airAt(ground, 90)?.airmass).toBeCloseTo(1, 3);
    // Kasten and Young's 1.995 at 30°, 5.60 at 10°.
    expect(airAt(ground, 30)?.airmass).toBeCloseTo(1.995, 2);
    expect(Math.abs((airAt(ground, 10)?.airmass ?? 0) / 5.6 - 1)).toBeLessThan(0.01);
    expect(airAt(ground, 0)?.airmass).toBeGreaterThan(36);
    expect(airAt(ground, 0)?.airmass).toBeLessThan(41);
    // From a plane, the air above is e^(-10/8) of it, and a ray below the level dips into the air under the plane.
    const plane = tableAt(10_000);
    expect(airAt(plane, 90)?.airmass).toBeCloseTo(Math.exp(-10 / 8), 3);
    expect(airAt(plane, -2)?.airmass).toBeGreaterThan(2 * (airAt(plane, 0)?.airmass ?? 0));
    expect(airAt(plane, -2)?.airmass).toBeGreaterThan(1 / 0.05);
    // Every table: more air the lower the ray.
    for (const heightM of HEIGHTS) {
        const table = tableAt(heightM);
        let last = Number.POSITIVE_INFINITY;
        for (let i = 0; i <= 200; ++i) {
            const airmass = airAt(table, table.horizon + ((table.top - table.horizon) * i) / 200)?.airmass ?? 0;
            expect(airmass).toBeLessThanOrEqual(last + 1e-6);
            last = airmass;
        }
    }
});

test("from orbit there is no air above the limb, and a star setting through it reddens and goes out", () => {
    const table = tableAt(408_000);
    const above = airAt(table, table.top + 5);
    expect(above?.bend).toBe(0);
    expect(above?.transmittance).toEqual([1, 1, 1]);
    expect(above?.airmass).toBe(0);
    expect(above?.scintillation.amount).toBe(0);
    // Through the stratosphere the ozone takes the red and the green, and the star turns blue before it reddens.
    const ozone = airAt(table, table.horizon + 0.5)?.transmittance ?? [0, 0, 0];
    expect(ozone[2]).toBeGreaterThan(ozone[0]);
    const low = airAt(table, table.horizon + 0.1)?.transmittance ?? [0, 0, 0];
    expect(low[0]).toBeGreaterThan(5 * low[2]);
    expect(low[0]).toBeLessThan(0.2);
    expect(Math.max(...(airAt(table, table.horizon)?.transmittance ?? [1]))).toBeLessThan(0.01);
});

test("airTableFrom takes any air: Bennett's refraction with Kasten and Young's airmass", () => {
    const bennett = (h: number) => 1 / Math.tan((h + 7.31 / (h + 4.4)) * DEG) / 60;
    const kastenYoung = (h: number) => 1 / (Math.sin(h * DEG) + 0.50572 * (h + 6.07995) ** -1.6364);
    const table = airTableFrom(
        (h) => ({
            bend: bennett(h) - bennett(90),
            transmittance: [0.9, 0.85, 0.75].map((t) => t ** kastenYoung(h)) as [number, number, number],
            airmass: kastenYoung(h),
        }),
        { horizon: -0.5 },
    );
    expect(airAt(table, 0)?.bend).toBeCloseTo(bennett(0) - bennett(90), 4);
    expect(airAt(table, 20)?.transmittance[2]).toBeCloseTo(0.75 ** kastenYoung(20), 3);
    for (const apparent of [-0.4, 0, 0.3, 2, 11, 47, 89]) {
        const real = apparent - (airAt(table, apparent)?.bend ?? 0);
        expect(Math.abs(altitudeOf(liftedDirection(table, towards(real))) - apparent)).toBeLessThan(ARCSEC);
    }
    // Without a path, the turbulence is the flat Earth's for the airmass.
    const flat = turbulenceThrough(kastenYoung(20));
    expect(airAt(table, 20)?.seeing.amount).toBeCloseTo(flat.seeing.amount, 2);
    expect(airAt(table, 20)?.scintillation.amount).toBeCloseTo(flat.scintillation.amount, 2);
});

test("the WGSL lookups read what the TypeScript ones do", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const near = (a: number, b: number, relative: number, absolute: number) =>
        expect(Math.abs(a - b)).toBeLessThan(absolute + relative * Math.abs(b));
    for (const heightM of [1, 10_000, 408_000]) {
        const table = tableAt(heightM);
        const altitudes = Array.from(
            { length: 256 },
            (_, i) => table.horizon - 0.2 + (Math.min(table.top + 0.2, 90) - table.horizon + 0.2) * (i / 255) ** 3,
        );
        const inputs = altitudes.map((a) => [a * DEG, 0, 0, 0] as [number, number, number, number]);
        const run = (expression: string, declarations = "") =>
            evaluateWithAir(device, table, expression, inputs, {}, declarations);
        const light = await run("dkAirLight(air, input.x)");
        const lift = await run("vec4f(dkAirLift(air, input.x), select(0.0, 1.0, dkAirShows(air, input.x)), 0.0, 0.0)");
        const at = await run("vec4f(dkAirAt(air, input.x).seeing, dkAirAt(air, input.x).airmass)");
        const direction = "vec3f(0.6 * cos(input.x), 0.8 * cos(input.x), sin(input.x))";
        const towards3 = `dkAirTowards(air, ${direction})`;
        const flicker = await run(`vec4f(${towards3}.scintillation, ${towards3}.bend)`);
        const squeeze = await run(`vec4f(${towards3}.dilution, 0.0, 0.0, 0.0)`);
        const lifted = await run(`vec4f(dkAirLifted(air, ${direction}), 0.0)`);
        const unbent = await run(`vec4f(dkAirUnbent(air, ${direction}), 0.0)`);
        altitudes.forEach((altitude, i) => {
            // Below the horizon the WGSL holds the horizon's entry, where the TypeScript says null.
            const air = airAt(table, Math.max(altitude, table.horizon));
            if (!air) throw new Error("no air above the horizon");
            air.transmittance.forEach((t, c) => {
                near(light[i]?.[c] as number, t, 1e-4, 1e-5);
            });
            // Bends and lifts to a twentieth of an arcsecond, directions to a fifth: f32, and a GPU's trigonometry.
            near(light[i]?.[3] as number, air.bend * DEG, 1e-5, 2.5e-7);
            near(flicker[i]?.[3] as number, air.bend * DEG, 1e-4, 1e-6);
            near(lift[i]?.[0] as number, airLift(table, altitude) * DEG, 1e-5, 2.5e-7);
            expect(lift[i]?.[1]).toBe(altitude >= table.horizon ? 1 : 0);
            near(at[i]?.[3] as number, air.airmass, 1e-4, 1e-6);
            near(squeeze[i]?.[0] as number, air.dilution, 2e-3, 0);
            // Next to the horizon the turbulence grows so fast that an altitude in f32 already moves it by a thousandth.
            [air.seeing.amount, air.seeing.distanceM, air.seeing.wind].forEach((value, c) => {
                near(at[i]?.[c] as number, value, 2e-3, 1e-6);
            });
            [air.scintillation.amount, air.scintillation.distanceM, air.scintillation.wind].forEach((value, c) => {
                near(flicker[i]?.[c] as number, value, 2e-3, 1e-6);
            });
            liftedDirection(table, towards(altitude)).forEach((value, c) => {
                near(lifted[i]?.[c] as number, value, 0, 1e-6);
            });
            unbentDirection(table, towards(altitude)).forEach((value, c) => {
                near(unbent[i]?.[c] as number, value, 0, 1e-6);
            });
        });
    }
});
