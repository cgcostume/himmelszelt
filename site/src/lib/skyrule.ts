/** Where the i-th of n Suns stands on a section rule's day arc, both 0 to 1: x across the rule, y above its horizon. The
 *  first rises and the last sets on the horizon itself. */
export const sunAt = (i: number, n: number) => ({ x: (i + 0.5) / n, y: Math.sin((Math.PI * i) / (n - 1)) });

/** The small scene around the current Sun, by chapter and section id; a section without one shows the Sun alone. */
export const SCENES: Record<string, Record<string, string>> = {
    sternzeit: {
        "counting-time-the-astronomers-way": "astrolabe",
        "earth-the-platform-we-observe-from": "earth",
        "coordinates-on-the-sky": "grid",
        "the-sun": "rays",
        "the-moon": "moon",
        eclipses: "eclipse",
        "a-month-of-moons": "phases",
        "precise-and-approximate": "approx",
        "bent-light": "squeezed",
    },
    // A lunation instead of a day (see moonrule.ts), a section without a scene shows the Moon in its phase.
    nachtgestirn: {
        "shadows-along-the-terminator": "jagged",
        earthshine: "earthshine",
        "earths-shadow": "umbra",
        "through-the-air": "shimmer",
        "the-moon-tonight": "tonight",
        "cheap-and-full": "pixels",
        "the-eastern-sea": "target",
        "the-people-behind-the-numbers": "telescope",
    },
};

/** The chapters whose rule carries Moons instead of Suns. */
export const MOON_RULES = new Set(["nachtgestirn"]);
