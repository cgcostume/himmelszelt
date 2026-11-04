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

/**
 * How strongly a star twinkles at an apparent altitude in degrees: the standard deviation of its light's logarithm, by
 * Young's scaling of the scintillation with the airmass to the power 1.75, as Dravins et al. give it, for an
 * aperture of `apertureCm` centimeters, 0.7 for the eye's pupil at night, and an integration time of `seconds`, 0.1
 * for the eye, from `heightM` meters up, where the air below is thinner. A tenth near the zenith for the eye, half
 * at 20° up, and saturating towards the horizon, where the scaling would run past 1.
 */
export function scintillationIndex(apparentAltitude: number, apertureCm = 0.7, seconds = 0.2, heightM = 0): number {
    const airmass = 1 / Math.max(Math.sin((apparentAltitude * Math.PI) / 180), 0.05);
    const sigma =
        (0.09 * apertureCm ** (-2 / 3) * airmass ** 1.75 * Math.exp(-heightM / 8000)) / Math.sqrt(2 * seconds);
    // Young's measurements saturate well short of the horizon, around a doubling.
    return Math.min(sigma, 0.6);
}
