/**
 * The ray the page follows through the tables, shared by the sky, the lookup figure and the tables figure: a view
 * ray, `{ kind: "view", mu, azimuth }`, its azimuth from the sun, signed, clockwise like a compass's; or what a texel of
 * the other two tables stands for, `{ kind: "transmittance", r, mu }` or `{ kind: "multiScattering", altitude, muS }`.
 * Pointing at something shows it for as long as the pointer stays; a click keeps it.
 */
const events = new EventTarget();
const DEG = Math.PI / 180;
let kept = { kind: "view", mu: Math.sin(8 * DEG), azimuth: 40 * DEG };
let pointed = null;

export const picked = () => pointed ?? kept;
export const keptRay = () => kept;
export const onPick = (listener) => events.addEventListener("pick", () => listener(picked()));
const changed = () => events.dispatchEvent(new Event("pick"));

/** Shows `ray` while pointed at; `keep` makes it stay. */
export function pick(ray, keep = false) {
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
