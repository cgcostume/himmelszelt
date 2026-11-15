// What the air does to a star's light along a ray, tabulated over the sky for the pass: the bend, which lifts a star
// seen low and moves the whole sky near the horizon, and the transmittance per channel, which dims and reddens it. The
// atmosphere model stays with the caller (`@himmelszelt/dunstkreis` on the himmelszelt site), which hands over the two
// functions; this samples them where they change fastest, along the horizon.

export type Rgb = readonly [r: number, g: number, b: number];

/** The entries of an `AirTable`, `SH_AIR_SAMPLES` in params.wgsl. */
export const AIR_SAMPLES = 128;

/**
 * The air over the sky, from the horizon up, as the pass takes it: `AIR_SAMPLES` entries over the apparent altitude,
 * spaced by the square of the entry's share so they crowd towards `horizon`, where the air changes fastest: an entry
 * `i` lies at `horizon + (90 - horizon) (i / (AIR_SAMPLES - 1))²` degrees. Below `horizon` a ray ends on the ground and
 * the pass draws no star.
 */
export interface AirTable {
    /** The apparent altitude of the lowest ray that still reaches space, in degrees: the horizon the air shows, a
     *  little below the geometric one from the ground, well below it from orbit. */
    horizon: number;
    /** How far the air bends a ray seen at each entry's apparent altitude down, in degrees: the star it shows truly
     *  lies that much lower. */
    bends: Float32Array;
    /** What the air lets through along each entry's ray, per channel of linear sRGB. */
    transmittances: Float32Array;
}

/** The apparent altitude of entry `i`, in degrees. */
export function airTableAltitude(horizon: number, i: number): number {
    const t = i / (AIR_SAMPLES - 1);
    return horizon + (90 - horizon) * t * t;
}

/**
 * Tabulates the air from two functions of the apparent altitude in degrees, such as `@himmelszelt/dunstkreis`'
 * `refractionAngle` and `airTransmittance` for a model and an observer's height: `bend` gives the refraction in
 * degrees, `transmittance` what the air lets through per channel, both null for a ray that ends on the ground. The
 * horizon is found by bisection between `lowest`, -90 by default, and the zenith. Without refraction, a bend of 0
 * everywhere; without air, `null` to the pass.
 */
export function airTable(
    bend: (apparentAltitude: number) => number | null,
    transmittance: (apparentAltitude: number) => Rgb | null,
    lowest = -90,
): AirTable {
    let low = lowest;
    let high = 90;
    if (bend(low) !== null) high = low;
    else
        for (let i = 0; i < 40; i++) {
            const middle = (low + high) / 2;
            if (bend(middle) === null) low = middle;
            else high = middle;
        }
    const horizon = high;
    const bends = new Float32Array(AIR_SAMPLES);
    const transmittances = new Float32Array(AIR_SAMPLES * 3);
    for (let i = 0; i < AIR_SAMPLES; i++) {
        const altitude = airTableAltitude(horizon, i);
        const b = bend(altitude);
        const t = transmittance(altitude);
        // The horizon's entry lies on the edge, where the bisection may have left it on the ground: the next one's then.
        if (b === null || t === null) {
            if (i === 0) {
                const above = airTableAltitude(horizon, 1);
                bends[0] = bend(above) ?? 0;
                transmittances.set(transmittance(above) ?? [0, 0, 0], 0);
            } else {
                bends[i] = bends[i - 1] ?? 0;
                transmittances.copyWithin(i * 3, (i - 1) * 3, i * 3);
            }
            continue;
        }
        bends[i] = b;
        transmittances.set(t, i * 3);
    }
    return { horizon, bends, transmittances };
}

/** The bend at an apparent altitude in degrees, read from the table between its entries; 0 below the horizon. */
export function airTableBend(table: AirTable, apparentAltitude: number): number {
    const t = Math.sqrt(Math.max(apparentAltitude - table.horizon, 0) / (90 - table.horizon));
    const x = Math.min(t * (AIR_SAMPLES - 1), AIR_SAMPLES - 1);
    const i = Math.min(Math.floor(x), AIR_SAMPLES - 2);
    const a = table.bends[i] ?? 0;
    const b = table.bends[i + 1] ?? a;
    return a + (b - a) * (x - i);
}

/**
 * Where a star in the true direction shows, lifted by the table's bend, ENU: the apparent altitude solved by iterating
 * `apparent = true + bend(apparent)`, which converges fast, since the bend changes slowly with the altitude. A star
 * below even the most bent ray is returned as it is.
 */
export function liftedDirection(
    table: AirTable,
    [x, y, z]: readonly [number, number, number],
): [number, number, number] {
    const horizontal = Math.hypot(x, y);
    if (horizontal < 1e-9) return [x, y, z];
    const trueAltitude = (Math.atan2(z, horizontal) * 180) / Math.PI;
    let apparent = trueAltitude;
    for (let i = 0; i < 8; i++) apparent = trueAltitude + airTableBend(table, apparent);
    if (apparent < table.horizon) return [x, y, z];
    const a = (apparent * Math.PI) / 180;
    return [(x / horizontal) * Math.cos(a), (y / horizontal) * Math.cos(a), Math.sin(a)];
}

// The twinkling's turbulence: the Hufnagel-Valley 5/7 profile of Cn² over the height in meters, with its wind of 21
// m/s up high, whose r0 from the ground is 5.56 cm at 550 nm. Nothing of it is left above 30 km.
const TURBULENCE_R0_M = 0.0556;
const TURBULENCE_TOP_M = 30_000;
const SCINTILLATION_WAVELENGTH_M = 550e-9;
const SCINTILLATION_WIND = 21;
const hufnagelValley = (h: number) =>
    0.00594 * (21 / 27) ** 2 * (1e-5 * h) ** 10 * Math.exp(-h / 1000) +
    2.7e-16 * Math.exp(-h / 1500) +
    1.7e-14 * Math.exp(-h / 100);

let turbulenceFor = { heightM: Number.NaN, moment: 0, distance: 1 };

/** The turbulence above `heightM`: ∫ d^(5/6) Cn² dd over the distance d up from there, and the mean distance it weighs. */
function turbulenceAbove(heightM: number) {
    if (turbulenceFor.heightM === heightM) return turbulenceFor;
    const reach = TURBULENCE_TOP_M - Math.max(heightM, 0);
    let moment = 0;
    let weighted = 0;
    // Steps that grow with the distance, a percent and a half each, from half a meter up.
    for (let d = 0.5; d < reach; d *= 1.015) {
        const w = hufnagelValley(Math.max(heightM, 0) + d) * d ** (5 / 6) * d * 0.015;
        moment += w;
        weighted += w * d;
    }
    turbulenceFor = { heightM, moment, distance: moment > 0 ? weighted / moment : 1 };
    return turbulenceFor;
}

/**
 * What the twinkling starts from at the zenith, for an aperture far smaller than the turbulence's Fresnel scale of
 * some 6 cm, the eye's pupil: `variance`, the variance of a star's light unaveraged, by Dravins et al.'s small
 * aperture equation, 19.2 λ^(-7/6) ∫ h^(5/6) Cn² dh, over the Hufnagel-Valley profile scaled to Fried's parameter `r0`
 * in meters at 550 nm from the ground, 0.08 for 0.1, an arcsecond of seeing; and `steps`, how many correlation times of
 * the flicker, the Fresnel scale over the `wind` in m/s up there, 3 ms, pass in `seconds`, what the eye or an exposure
 * averages over. From `heightM` meters up only the turbulence above counts: half of the variance is gone by 2 km,
 * most by 12 km, all of it by 30 km, and no star twinkles from orbit.
 */
export function scintillationScales(r0 = 0.1, seconds = 0.1, wind = SCINTILLATION_WIND, heightM = 0) {
    const { moment, distance } = turbulenceAbove(heightM);
    const time = Math.sqrt(SCINTILLATION_WAVELENGTH_M * distance) / wind;
    const variance = 19.2 * SCINTILLATION_WAVELENGTH_M ** (-7 / 6) * moment * (r0 / TURBULENCE_R0_M) ** (-5 / 3);
    return { variance, steps: seconds / time };
}

/**
 * How strongly a star twinkles at an apparent altitude in degrees: the standard deviation of its light's logarithm as
 * the eye sees it, or an exposure of `seconds`. The unaveraged variance grows with the airmass to the power 11/6 and
 * saturates at 1; the averaging leaves the variance of an exponentially correlated signal's mean, the correlation time
 * growing with the root of the airmass as the Fresnel scale does. 0.07 at the zenith for the eye, 0.15 at 30° up, 0.35
 * at 10°.
 */
export function scintillationIndex(
    apparentAltitude: number,
    r0 = 0.1,
    seconds = 0.1,
    wind = SCINTILLATION_WIND,
    heightM = 0,
) {
    const airmass = 1 / Math.max(Math.sin((apparentAltitude * Math.PI) / 180), 0.05);
    const { variance, steps } = scintillationScales(r0, seconds, wind, heightM);
    const x = Math.max(steps / Math.sqrt(airmass), 1e-3);
    const seen = (Math.min(variance * airmass ** (11 / 6), 1) * 2 * (x - 1 + Math.exp(-x))) / (x * x);
    return Math.sqrt(Math.log(1 + seen));
}
