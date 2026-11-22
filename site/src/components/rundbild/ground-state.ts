import { groundedMeets } from "./ground-math";

// The surface the chapter's grounded figures share: the ground geometry figure sets it with its sliders, the grounded
// figure follows it. Without the first, the second shows these defaults: a capture point 2 m up, a level horizon, the
// ground flat for some 8 m under a dome without end, falling away past it like a hilltop.

/** The capture height, the reach and the dome's radius in meters (1e9 for without end), the lifted horizon in degrees,
 * and how high up the dome the bend meets it, in radians, as rbGroundedMeets gives. */
export type GroundSurface = { height: number; lift: number; reach: number; radius: number; meets: number };

const FAR = 1e9;
let surface: GroundSurface = { height: 2, lift: 0, reach: 3 * 100 ** (21 / 99), radius: FAR, meets: 0 };
surface.meets = groundedMeets(surface.height, surface.radius, 1, 0);
const listeners = new Set<(surface: GroundSurface) => void>();

/** The surface as last set. */
export const groundSurface = () => surface;

/** Sets the surface and tells every figure that follows it. */
export function setGroundSurface(next: GroundSurface) {
    surface = next;
    for (const listener of listeners) listener(surface);
}

/** Calls `listener` with the surface whenever it is set. */
export function onGroundSurface(listener: (surface: GroundSurface) => void) {
    listeners.add(listener);
}
