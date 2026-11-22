/**
 * Contrails: streaks of ice behind aircraft, drawn into the high sheet at its altitude. The library draws streaks and
 * lays one behind an aircraft; where the aircraft are, and whether the air up there is moist enough for a trail to
 * last, is the caller's to say.
 */

/** A streak over the ground, in km east and north of where the observer started: from its young end to its old one. */
export interface Contrail {
    fromKm: readonly [number, number];
    toKm: readonly [number, number];
    /** Its width at either end, in km: a trail starts some 0.03 wide and spreads to a few km. */
    fromWidthKm: number;
    toWidthKm: number;
    /** The optical depth straight through its middle at the young end, about 0.3: it thins as it spreads, and fades out
     *  over its last third. */
    opticalDepth: number;
}

/** An aircraft at cruise: where it is, in km east and north, where it heads, as a compass azimuth in degrees, and how fast. */
export interface Aircraft {
    atKm: readonly [number, number];
    headingDeg: number;
    /** Speed over the ground in m/s, 230 by default. */
    speedMps?: number;
}

/** The air a trail is laid into. */
export interface ContrailAir {
    /** How long a trail lasts, in seconds: a few in dry air, an hour and more where the air is supersaturated over ice. */
    persistenceS: number;
    /** The wind up there, east and north in m/s, none by default: the trail drifts with it, the aircraft does not. */
    wind?: readonly [number, number];
    /** How fast a trail widens, in m/s, 1.5 by default, and its optical depth where it is young, 0.3. */
    spreadMps?: number;
    opticalDepth?: number;
}

/** The streaks a pass draws at most: the rest of a longer list is left out. */
export const MAX_CONTRAILS = 16;
/** A trail's width behind the engines, once the two wingtip vortices have taken it up, in km. */
const YOUNG_WIDTH_KM = 0.03;

/** The trail behind `aircraft` in `air`: straight, as long as the aircraft flew while the trail lasted, less the wind's drift. */
export function contrailBehind(aircraft: Aircraft, air: ContrailAir): Contrail {
    const { atKm, headingDeg, speedMps = 230 } = aircraft;
    const { persistenceS, wind = [0, 0], spreadMps = 1.5, opticalDepth = 0.3 } = air;
    const heading = (headingDeg * Math.PI) / 180;
    // What was laid `persistenceS` ago lies where the aircraft was then, moved on by the wind since.
    const back = [speedMps * Math.sin(heading) - wind[0], speedMps * Math.cos(heading) - wind[1]] as const;
    const km = persistenceS / 1000;
    return {
        fromKm: atKm,
        toKm: [atKm[0] - back[0] * km, atKm[1] - back[1] * km],
        fromWidthKm: YOUNG_WIDTH_KM,
        toWidthKm: YOUNG_WIDTH_KM + spreadMps * km,
        opticalDepth,
    };
}

/** `GwContrails` in highsheet.comp.wgsl packed: the streaks as the observer at `observerKm` has them around. */
export function contrailsData(contrails: readonly Contrail[], observerKm: readonly [number, number]): ArrayBuffer {
    const buffer = new ArrayBuffer(CONTRAILS_SIZE);
    const count = Math.min(contrails.length, MAX_CONTRAILS);
    new Uint32Array(buffer)[0] = count;
    const f = new Float32Array(buffer);
    contrails.slice(0, count).forEach((c, i) => {
        const [east, north] = observerKm;
        f.set([c.fromKm[0] - east, c.fromKm[1] - north, c.toKm[0] - east, c.toKm[1] - north], 4 + 8 * i);
        f.set([c.fromWidthKm, c.toWidthKm, c.opticalDepth], 8 + 8 * i);
    });
    return buffer;
}

export const CONTRAILS_SIZE = 16 + 32 * MAX_CONTRAILS;
