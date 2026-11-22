import { type Contrail, type ContrailAir, contrailBehind } from "@himmelszelt/gewoelk";

/**
 * Air routes over the observer, invented: gewoelk draws trails and lays one behind an aircraft, and where the aircraft
 * are is the application's to say. Each route is a straight line that passes the place the observer started from, flown
 * by aircraft at even intervals.
 */
interface Route {
    /** Where the route passes nearest, in km east and north, and where it heads, as a compass azimuth in degrees. */
    passKm: readonly [number, number];
    headingDeg: number;
    /** Aircraft on the route at a time, and where along it the first is at time 0, as a share of the way. */
    aircraft: number;
    phase: number;
}

const ROUTES: Route[] = [
    { passKm: [2, 1], headingDeg: 70, aircraft: 2, phase: 0.52 },
    { passKm: [-14, 6], headingDeg: 250, aircraft: 2, phase: 0.2 },
    { passKm: [25, -30], headingDeg: 135, aircraft: 1, phase: 0.45 },
    { passKm: [-40, -10], headingDeg: 10, aircraft: 2, phase: 0.6 },
    { passKm: [8, 55], headingDeg: 300, aircraft: 1, phase: 0.35 },
];
/** How far to either side of its pass a route is flown, in km, and how fast, in m/s. */
const REACH_KM = 180;
const SPEED_MPS = 230;
/** The share of the way at either end over which a trail comes and goes, far off. */
const FADE = 0.15;

/** The trails over the routes at `timeS`, in the `air` up there. */
export function routeTrails(timeS: number, air: ContrailAir): Contrail[] {
    const { persistenceS } = air;
    const wayS = (2 * REACH_KM * 1000) / SPEED_MPS;
    return ROUTES.flatMap(({ passKm, headingDeg, aircraft, phase }) =>
        Array.from({ length: aircraft }, (_, i) => {
            const way = (((timeS / wayS + phase + i / aircraft) % 1) + 1) % 1;
            const heading = (headingDeg * Math.PI) / 180;
            const alongKm = (2 * way - 1) * REACH_KM;
            const atKm = [passKm[0] + Math.sin(heading) * alongKm, passKm[1] + Math.cos(heading) * alongKm] as const;
            // A trail is no longer than the aircraft has flown on this way, and faint where the way begins and ends.
            const trail = contrailBehind(
                { atKm, headingDeg, speedMps: SPEED_MPS },
                { ...air, persistenceS: Math.min(persistenceS, way * wayS) },
            );
            const shown = Math.min(way / FADE, (1 - way) / FADE, 1);
            return { ...trail, opticalDepth: trail.opticalDepth * shown };
        }),
    );
}
