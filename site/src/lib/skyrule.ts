/** Where the i-th of n Suns stands on a section rule's day arc, both 0 to 1: x across the rule, y above its horizon. The
 *  first rises and the last sets on the horizon itself. */
export const sunAt = (i: number, n: number) => ({ x: (i + 0.5) / n, y: Math.sin((Math.PI * i) / (n - 1)) });

/** The small scene around the current Sun, by section id; a section without one shows the Sun alone. */
export const SCENES: Record<string, string> = {
    "counting-time-the-astronomers-way": "clock",
    "earth-the-platform-we-observe-from": "earth",
    "coordinates-on-the-sky": "grid",
    "the-sun": "rays",
    "the-moon": "moon",
    eclipses: "eclipse",
    "a-month-of-moons": "phases",
    "precise-or-approximate": "approx",
};
