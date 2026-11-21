/**
 * What the air does to light arriving from beyond it, as one small table per observer height: how far it bends a ray,
 * what it lets through, how much of it the ray crosses and the turbulence on the way. The atmosphere is the same all
 * round, so all of it depends on the ray's apparent altitude alone, and a star, the Moon, a planet or a satellite read
 * the same table, on the CPU here and on the GPU by `wgsl.air`.
 *
 * The layout, which anyone may fill: `AIR_TABLE_WIDTH` entries by `AIR_TABLE_ROWS` rows of four floats, row major,
 * an rgba32float texture as it is. Rows 0 to 2 run over the apparent altitude, from the horizon the air shows to the
 * top, the zenith or, from above the atmosphere, the ray that touches its upper edge: entry i lies at
 * horizon + (top - horizon) (i / (width - 1))⁴, crowded towards the horizon, where the air changes fastest: half the
 * entries lie in the lowest sixteenth, the first 6° from the ground and the limb's dense air from orbit.
 *
 *     row 0   transmittance of sunlight, linear sRGB (r, g, b), and the bend in radians (a)
 *     row 1   airmass (r), and the seeing's turbulence: its amount (g), distance in m (b) and wind (a)
 *     row 2   the scintillation's turbulence: its amount (r), distance in m (g) and wind (b), and the dilution (a)
 *     row 3   over the true altitude, from the true horizon to the true top, spaced alike: the lift in radians (r)
 *     row 4   texel 0: horizon, top, true horizon, true top, in radians; texel 1: the observer's height in m (r)
 *
 * The bend is what a ray seen at an apparent altitude lies lower once it has left the air; the lift is what a body at
 * a true altitude shows higher. Rows 0 and 3 are each other's inverse: a lookup either way and one step of Newton's
 * to make them agree, no iteration, which matters from orbit, where the air squeezes the limb so hard that iterating
 * on the bend diverges. The dilution is that squeeze, 1 / (1 - d bend / d altitude): how much closer together the air
 * shows two points, 1 overhead, 0.78 on the ground's horizon, a tenth at the limb's edge from orbit. A surface keeps
 * its brightness and is squeezed; a point's light is spread thinner by it, so a star's is multiplied by it.
 */
import type { AtmosphereModel } from "./model.js";
import { apparentHorizon, sunlightThrough, TRACE_SAMPLES, traceSeen } from "./refraction.js";
import { type PathTurbulence, turbulenceAlong, turbulenceThrough } from "./seeing.js";

export const AIR_TABLE_WIDTH = 256;
export const AIR_TABLE_ROWS = 5;
/** Full floats: the bends are read to a fraction of an arcsecond. Loaded, not sampled, so no device feature needed. */
export const AIR_TABLE_FORMAT = "rgba32float" satisfies GPUTextureFormat;

const DEG = Math.PI / 180;
const LAST = AIR_TABLE_WIDTH - 1;
type Vec3 = readonly [number, number, number];

/** The air along one ray, seen at an apparent altitude. */
export interface Air extends PathTurbulence {
    /** How far the air bends the ray down, in degrees: what it shows lies that much lower. */
    bend: number;
    /** What the air lets through of sunlight along it, per channel of linear sRGB. */
    transmittance: [number, number, number];
    /** The air crossed, in columns of it straight up from sea level: 1 at the zenith there, some 39 at the horizon,
     *  less from a mountain, far more for a ray that dips into the air from high above it. */
    airmass: number;
    /** How much the air squeezes the sky here, the apparent altitude gained per true one: what the light of a point,
     *  a star or a planet, is multiplied by besides the transmittance, and its colors' spread. Not a surface's. */
    dilution: number;
}

/** The air table of one observer height. `data` is the texture's content, in the layout above. */
export interface AirTable {
    /** The apparent altitude of the lowest ray that still reaches space, in degrees: below it the ground hides
     *  everything beyond the air. */
    horizon: number;
    /** The apparent altitude the table ends at, in degrees: 90, or from above the atmosphere the ray that touches its
     *  upper edge, above which there is no air in the way. */
    top: number;
    /** The true altitudes of bodies showing at `horizon` and `top`, in degrees. */
    trueHorizon: number;
    trueTop: number;
    observerHeightM: number;
    data: Float32Array;
}

/**
 * Tabulates the air from a function of the apparent altitude in degrees, for an air other than dunstkreis' own: a fit
 * such as Bennett's refraction with Kasten and Young's airmass, or measurements. `horizon` and `top` are the
 * altitudes the table spans, in degrees, `top` 90 by default. Without `seeing` and `scintillation` an entry takes the
 * flat Earth's turbulence for its airmass, `turbulenceThrough`.
 */
export function airTableFrom(
    air: (apparentAltitude: number) => Pick<Air, "bend" | "transmittance" | "airmass"> & Partial<PathTurbulence>,
    { horizon, top = 90, observerHeightM = 0 }: { horizon: number; top?: number; observerHeightM?: number },
): AirTable {
    const data = new Float32Array(AIR_TABLE_WIDTH * AIR_TABLE_ROWS * 4);
    const apparent = new Float64Array(AIR_TABLE_WIDTH);
    const bends = new Float64Array(AIR_TABLE_WIDTH);
    const real = new Float64Array(AIR_TABLE_WIDTH);
    for (let i = 0; i < AIR_TABLE_WIDTH; ++i) {
        const altitude = horizon + (top - horizon) * (i / LAST) ** 4;
        const entry = air(altitude);
        const { seeing, scintillation } = { ...turbulenceThrough(entry.airmass), ...entry };
        data.set([...entry.transmittance, entry.bend * DEG], i * 4);
        data.set([entry.airmass, seeing.amount, seeing.distanceM, seeing.wind], (AIR_TABLE_WIDTH + i) * 4);
        data.set([scintillation.amount, scintillation.distanceM, scintillation.wind, 0], (2 * AIR_TABLE_WIDTH + i) * 4);
        apparent[i] = altitude;
        bends[i] = entry.bend;
        // A body never shows lower for lying higher: the true altitudes rise with the apparent ones.
        real[i] = Math.max(altitude - entry.bend, i > 0 ? (real[i - 1] as number) : Number.NEGATIVE_INFINITY);
    }
    // The dilution from the bend's slope, between entries far enough apart to tell: next to the horizon they crowd.
    for (let i = 0; i < AIR_TABLE_WIDTH; ++i) {
        let [low, high] = [Math.max(i - 1, 0), Math.min(i + 1, LAST)];
        const apart = Math.min(2e-3, (top - horizon) / 4);
        while (low > 0 && (apparent[i] as number) - (apparent[low] as number) < apart) --low;
        while (high < LAST && (apparent[high] as number) - (apparent[i] as number) < apart) ++high;
        const slope =
            ((bends[high] as number) - (bends[low] as number)) /
            ((apparent[high] as number) - (apparent[low] as number));
        data[(2 * AIR_TABLE_WIDTH + i) * 4 + 3] = 1 / Math.max(1 - slope, 1e-6);
    }
    const [trueHorizon, trueTop] = [real[0] as number, real[LAST] as number];
    // Row 3: the bend's table turned round, entry by entry, between its own.
    let k = 0;
    for (let i = 0; i < AIR_TABLE_WIDTH; ++i) {
        const altitude = trueHorizon + (trueTop - trueHorizon) * (i / LAST) ** 4;
        while (k < LAST - 1 && (real[k + 1] as number) < altitude) ++k;
        const [low, high] = [real[k] as number, real[k + 1] as number];
        const share = high > low ? Math.min(Math.max((altitude - low) / (high - low), 0), 1) : 0;
        const shown = (apparent[k] as number) + ((apparent[k + 1] as number) - (apparent[k] as number)) * share;
        data[(3 * AIR_TABLE_WIDTH + i) * 4] = (shown - altitude) * DEG;
    }
    data.set([horizon * DEG, top * DEG, trueHorizon * DEG, trueTop * DEG, observerHeightM], 4 * AIR_TABLE_WIDTH * 4);
    return { horizon, top, trueHorizon, trueTop, observerHeightM, data };
}

/**
 * The air table of a model for an observer `observerHeightM` meters up, each entry traced through the model's air as
 * `refractionAngle` and `airTransmittance` trace theirs, with the turbulence summed along the same bent ray. Make it
 * anew when the height or the model changes, a few milliseconds; the Sun, the Moon, the time and the camera leave it
 * as it is. On the CPU on purpose: `liftedDirection` and `airAt` then answer at once, with no round trip to the GPU,
 * and in double precision.
 */
export function airTable(model: AtmosphereModel, observerHeightM: number): AirTable {
    const { groundRadiusKm, thicknessKm } = model.planet;
    const heightKm = Math.max(observerHeightM, 0) / 1000;
    const horizon = apparentHorizon(model, observerHeightM);
    const top =
        heightKm > thicknessKm ? -Math.acos((groundRadiusKm + thicknessKm) / (groundRadiusKm + heightKm)) / DEG : 90;
    const through = sunlightThrough(model);
    const path = new Float64Array(2 * (TRACE_SAMPLES + 1));
    const centerKm = groundRadiusKm + Math.min(heightKm, thicknessKm);
    return airTableFrom(
        (altitude) => {
            // The grazing ray itself ends on the ground: the first entry is the ray a hair above it.
            const ray =
                traceSeen(model, observerHeightM, Math.max(altitude, horizon + 1e-6), path) ??
                traceSeen(model, observerHeightM, altitude + 1e-4, path);
            if (!ray) throw new Error(`airTable: the ray at ${altitude}° ends on the ground`);
            return {
                bend: ray.bend / DEG,
                transmittance: through(ray.depth),
                airmass: ray.airmass,
                ...turbulenceAlong(path, TRACE_SAMPLES, centerKm, groundRadiusKm, ray.start),
            };
        },
        { horizon, top, observerHeightM },
    );
}

/** Where an altitude falls in a row spaced by the fourth power: the entry below it and the share of the next. */
function entryAt(altitude: number, from: number, to: number): [number, number] {
    const x = Math.sqrt(Math.sqrt(Math.min(Math.max((altitude - from) / Math.max(to - from, 1e-12), 0), 1))) * LAST;
    const i = Math.min(Math.floor(x), LAST - 1);
    return [i, x - i];
}

function read(table: AirTable, row: number, [i, share]: [number, number], channel: number): number {
    const at = (row * AIR_TABLE_WIDTH + i) * 4 + channel;
    const [a, b] = [table.data[at] as number, table.data[at + 4] as number];
    return a + (b - a) * share;
}

/**
 * The air along a ray seen at an apparent altitude in degrees, read from the table between its entries, or `null`
 * below the horizon, where the ray ends on the ground. Above `top` there is no air in the way.
 */
export function airAt(table: AirTable, apparentAltitude: number): Air | null {
    if (apparentAltitude < table.horizon) return null;
    const at = entryAt(apparentAltitude, table.horizon, table.top);
    const value = (row: number, channel: number) => read(table, row, at, channel);
    return {
        bend: value(0, 3) / DEG,
        transmittance: [value(0, 0), value(0, 1), value(0, 2)],
        airmass: value(1, 0),
        seeing: { amount: value(1, 1), distanceM: value(1, 2), wind: value(1, 3) },
        scintillation: { amount: value(2, 0), distanceM: value(2, 1), wind: value(2, 2) },
        dilution: value(2, 3),
    };
}

/**
 * How much higher a body at a true altitude shows, both in degrees. Below the true horizon it stays the horizon's, so
 * a setting body sinks on behind the ground at the same rate instead of dropping back to its true place.
 */
export function airLift(table: AirTable, trueAltitude: number): number {
    const lift = read(table, 3, entryAt(trueAltitude, table.trueHorizon, table.trueTop), 0);
    // One step of Newton's towards the bend's own row, so a star lifted and the sky behind it unbent stay together.
    const shown = entryAt(trueAltitude + lift / DEG, table.horizon, table.top);
    return (lift + (read(table, 0, shown, 3) - lift) * read(table, 2, shown, 3)) / DEG;
}

/** A direction turned up by an angle in radians within its vertical plane. ENU. */
function turnedUp([x, y, z]: Vec3, angle: number): [number, number, number] {
    const horizontal = Math.hypot(x, y);
    if (horizontal < 1e-9) return [x, y, z];
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    const up = (-z / horizontal) * s;
    return [x * (c + up), y * (c + up), z * c + horizontal * s];
}

const altitudeOf = ([x, y, z]: Vec3) => Math.atan2(z, Math.hypot(x, y)) / DEG;

/**
 * Where a body in the true (geometric) `direction` shows, lifted by the air: for placing a star, aiming a camera at
 * the Moon, or measuring the air along its line of sight. ENU, unit length. `airShows` tells whether the ground hides
 * it there.
 */
export function liftedDirection(table: AirTable, direction: Vec3): [number, number, number] {
    return turnedUp(direction, airLift(table, altitudeOf(direction)) * DEG);
}

/** The direction a ray seen along `view` has once it has left the air, turned down by its bend: for looking up what
 *  lies beyond, a star map or the Milky Way. ENU, unit length. */
export function unbentDirection(table: AirTable, view: Vec3): [number, number, number] {
    const altitude = altitudeOf(view);
    return turnedUp(view, -read(table, 0, entryAt(altitude, table.horizon, table.top), 3));
}

/** Whether a ray seen along `view` reaches space, or the ground hides what lies beyond the air. */
export function airShows(table: AirTable, view: Vec3): boolean {
    return altitudeOf(view) >= table.horizon;
}

/**
 * A texture for the table, as the `wgsl.air` functions take it: `AIR_TABLE_WIDTH` by `AIR_TABLE_ROWS`, rgba32float,
 * filled if a table is given. One serves every pass of a frame; write it anew with `writeAirTexture` when the
 * observer's height or the model changes. Bind it as an unfilterable float texture.
 */
export function createAirTexture(device: GPUDevice, table?: AirTable): GPUTexture {
    const texture = device.createTexture({
        label: "dunstkreis:air",
        size: [AIR_TABLE_WIDTH, AIR_TABLE_ROWS],
        format: AIR_TABLE_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    if (table) writeAirTexture(device, texture, table);
    return texture;
}

export function writeAirTexture(device: GPUDevice, texture: GPUTexture, table: AirTable): void {
    device.queue.writeTexture(
        { texture },
        table.data as Float32Array<ArrayBuffer>,
        { bytesPerRow: AIR_TABLE_WIDTH * 16 },
        [AIR_TABLE_WIDTH, AIR_TABLE_ROWS],
    );
}
