/**
 * The ray the page follows through the tables, shared by the lookup figure and the tables figure: a view
 * ray, `{ kind: "view", mu, azimuth }`, its azimuth from the sun, signed, clockwise like a compass's; or what a texel of
 * the other two tables stands for, `{ kind: "transmittance", r, mu }` or `{ kind: "multiScattering", altitude, muS }`.
 * Pointing at something shows it for as long as the pointer stays; a click keeps it.
 */
export type Ray =
    | { kind: "view"; mu: number; azimuth: number }
    | { kind: "transmittance"; r: number; mu: number }
    | { kind: "multiScattering"; altitude: number; muS: number };

const events = new EventTarget();
const DEG = Math.PI / 180;
let kept: Ray = { kind: "view", mu: Math.sin(8 * DEG), azimuth: 40 * DEG };
let pointed: Ray | null = null;

export const picked = () => pointed ?? kept;
export const keptRay = () => kept;
export const onPick = (listener: (ray: Ray) => void) => events.addEventListener("pick", () => listener(picked()));
const changed = () => events.dispatchEvent(new Event("pick"));

/** Shows `ray` while pointed at; `keep` makes it stay. */
export function pick(ray: Ray, keep = false) {
    if (keep) kept = ray;
    pointed = keep ? null : ray;
    changed();
}

/** The pointer left: back to the ray last kept. */
export function unpoint() {
    if (pointed === null) return;
    pointed = null;
    changed();
}
