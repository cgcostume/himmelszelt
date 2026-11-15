// The section rule of a Moon's chapter (see SkyRule.astro): a lunation along the arc instead of a day, from new moon at
// the introduction over full moon in the middle to new moon at the references, and a scene that changes the Moon itself.

const f = (v: number) => v.toFixed(2);

/** A phase: k from -1 (new) over 0 (half) to 1 (full), lit towards +x when waxing (dir 0) and towards -x when waning (180). */
export type Phase = { k: number; dir: number };

/** The phase of the i-th of n markers. */
export const phaseAt = (i: number, n: number): Phase => ({
    k: -Math.cos((i / (n - 1)) * 2 * Math.PI),
    dir: i < (n - 1) / 2 ? 0 : 180,
});

/** Tonight's phase, from the mean synodic month since the new moon of 2000-01-06 18:14 UT: a day off at most. */
export function tonight(now = Date.now()): Phase {
    const month = 29.530589;
    const age = ((((now - Date.UTC(2000, 0, 6, 18, 14)) / 864e5) % month) + month) % month;
    return { k: -Math.cos((age / month) * 2 * Math.PI), dir: age < month / 2 ? 0 : 180 };
}

/** The lit part's outline of a Moon of radius r lit towards +x, its terminator jagged by `jag`. */
export function litPath(r: number, k: number, jag = 0) {
    const w = Math.abs(k) * r;
    if (!jag) return `M0 ${-r}A${r} ${r} 0 0 1 0 ${r}A${f(w)} ${r} 0 0 ${k > 0 ? 1 : 0} 0 ${-r}Z`;
    const points = Array.from({ length: 25 }, (_, i) => {
        const y = r - (2 * r * i) / 24;
        const across = Math.sqrt(Math.max(0, 1 - (y / r) ** 2));
        return `L${f(-Math.sign(k) * w * across - (i % 2 ? jag : 0) * across)} ${f(y)}`;
    }).join("");
    return `M0 ${-r}A${r} ${r} 0 0 1 0 ${r}${points}Z`;
}

/** A small Moon for the markers but the current one, in currentColor, in a 7 by 7 box, with a gap around it. */
export const markerMoon = ({ k, dir }: Phase, ahead: boolean) =>
    `<svg viewBox="-3.5 -3.5 7 7" aria-hidden="true"><circle r="6" fill="var(--bg)"/><circle r="3.5" fill="currentColor" opacity="${ahead ? 0.35 : 0.5}"/><path d="${litPath(3.5, k)}" fill="currentColor" transform="rotate(${-dir})"/></svg>`;

// The current marker's radius in pixels, as large as the current Sun of the other chapters.
const R = 7;

type MoonStyle = { night?: string; lit?: string; inner?: string; jag?: number; cover?: boolean };
/** A Moon of radius r: its night side, its lit part and what is drawn into it (`inner`), with a gap around it. */
function moon({ k, dir }: Phase, { night = "night", lit = "lit", inner = "", jag = 0, cover = true }: MoonStyle = {}) {
    return `${cover ? `<circle r="${R + 3}" class="cover"/>` : ""}<circle r="${R}" class="${night}"/><path d="${litPath(R, k, jag)}" class="${lit}" transform="rotate(${-dir})"/>${inner}`;
}
const clipDisc = (id: string, inner: string) =>
    `<clipPath id="moonrule-${id}"><circle r="${R}"/></clipPath><g clip-path="url(#moonrule-${id})">${inner}</g>`;

/** A stick figure standing at x on the ground, looking at `toward`, as in sternzeit's rule. */
function stick(x: number, ground: number, toward: { x: number; y: number }, k = 1.4) {
    const [hip, shoulder] = [ground - 4 * k, ground - 7.5 * k];
    const head = { x: x - 0.6 * k, y: ground - 9.6 * k };
    const d = Math.hypot(toward.x - head.x, toward.y - head.y);
    const [ux, uy] = [(toward.x - head.x) / d, (toward.y - head.y) / d];
    const hand = { x: x - 0.3 * k + ux * 3.2 * k, y: shoulder + uy * 3.2 * k };
    const p = (a: number, b: number) => `${f(a)} ${f(b)}`;
    const neck = p(x - 0.3 * k, shoulder);
    const body = `M${p(x - 1.8 * k, ground)}L${p(x, hip)}L${p(x + 1.8 * k, ground)}M${p(x, hip)}L${neck}L${p(hand.x, hand.y)}M${neck}L${p(x + 1.8 * k, shoulder + 2.8 * k)}`;
    const svg = `<path d="${body}" class="figure"/><circle cx="${f(head.x)}" cy="${f(head.y)}" r="${1.4 * k}" class="figure"/>`;
    return { head, ux, uy, k, svg };
}

type Place = { phase: Phase; horizon: number };
/** The scenes in place of the current marker, by name (see skyrule.ts), in a 48 by 32 box around it, y down. */
export const MOON_SCENES: Record<string, (at: Place) => string> = {
    // Mountains and craters cast long shadows along the terminator.
    jagged: ({ phase }) => moon(phase, { jag: 1.1 }),
    // Nearly new, the night side in a nearly full Earth's light.
    earthshine: () => moon({ k: -0.82, dir: 0 }, { night: "blue" }),
    // The full Moon half in the umbra, the umbra's edge dashed, the penumbra's dotted.
    umbra: () => {
        const [cx, cy, u] = [-8.6, 2.2, 8.9];
        const copper = clipDisc("umbra", `<circle cx="${cx}" cy="${cy}" r="${u}" class="copper"/>`);
        return `<circle r="${R + 3}" class="cover"/>${moon({ k: 1, dir: 0 }, { cover: false, lit: "lit dim", inner: copper })}<circle cx="${cx}" cy="${cy}" r="${u}" class="dashes thin"/><circle cx="${cx}" cy="${cy}" r="${u + 5.2}" class="dots"/>`;
    },
    // Low and golden, squeezed by the air, its streaks running through it.
    shimmer: ({ phase }) => {
        const streak = "q2.2 -1.1 4.5 0t4.5 0 4.5 0 4.5 0";
        return `<g transform="scale(1 0.84)"><circle r="${R + 3}" class="cover"/><circle r="${R}" class="night"/><path d="${litPath(R, phase.k)}" class="golden" transform="rotate(${-phase.dir})"/></g><clipPath id="moonrule-shimmer"><ellipse rx="${R}" ry="${f(R * 0.84)}"/></clipPath><g clip-path="url(#moonrule-shimmer)"><path d="M-9 -2${streak}M-9 1.2${streak}M-9 4${streak}" class="streaks"/></g>`;
    },
    // The stick figure looks up to the Moon as it stands tonight, set when the page loads (see SkyRule.astro).
    tonight: ({ horizon }) => {
        const fig = stick(22, horizon, { x: 0, y: 0 });
        const from = `${f(fig.head.x + fig.ux * 4.5 * fig.k)} ${f(fig.head.y + fig.uy * 4.5 * fig.k)}`;
        return `<path d="M${from}L${f(-fig.ux * (R + 4))} ${f(-fig.uy * (R + 4))}" class="dots"/>${fig.svg}<g data-tonight>${moon(tonight())}</g>`;
    },
    // Lit from the limb on the left: a column of coarse pixels, two finer ones, then smooth up to the terminator.
    pixels: () => {
        const cells: string[] = [];
        const block = (x0: number, n: number, size: number) => {
            for (let i = 0; i < n; i++)
                for (let y = -R; y < R; y += size) {
                    const x = x0 + i * size;
                    if (Math.hypot(x + size / 2, y + size / 2) < R)
                        cells.push(
                            `<rect x="${f(x)}" y="${f(y)}" width="${f(size * 0.88)}" height="${f(size * 0.88)}" class="lit"/>`,
                        );
                }
            return x0 + n * size;
        };
        const edge = block(block(-R, 1, (2 * R) / 3), 2, R / 3);
        return `<circle r="${R + 3}" class="cover"/><circle r="${R}" class="night"/><clipPath id="moonrule-pixels"><rect x="${f(edge)}" y="-9" width="${f(R - edge)}" height="18"/></clipPath><g clip-path="url(#moonrule-pixels)"><path d="${litPath(R, 0.6)}" class="lit" transform="rotate(180)"/></g>${cells.join("")}`;
    },
    // Mare Orientale from above, its rings a face looking back.
    target: () =>
        `<circle r="13" class="cover"/><ellipse cy="1.9" rx="2.9" ry="1.9" class="mare"/><circle r="5.5" class="rim"/><circle r="8" class="rim thin"/><circle r="10.5" class="dashes thin"/><circle cx="-1.5" cy="-2.2" r="0.8" class="lit"/><circle cx="1.8" cy="-1.7" r="0.8" class="lit"/>`,
    // A stick figure at a telescope on its tripod, pointed at the Moon.
    telescope: ({ phase, horizon: h }) => {
        const x = 20;
        const fig = stick(x + 6, h, { x: x - 3, y: h - 9 });
        const top = `M${x - 0.5} ${f(h - 11.5)}`;
        return `<path d="${top}L${x - 4} ${f(h)}${top}L${x + 2.5} ${f(h)}${top}V${f(h)}" class="thin"/><path d="M${x - 3} ${f(h - 9)}L${x + 2} ${f(h - 14)}" class="figure"/><path d="M${x - 3.6} ${f(h - 9.6)}L${f(R * 0.75)} ${f(R * 0.75)}" class="dots"/>${fig.svg}${moon(phase)}`;
    },
};

/** The current marker without a scene of its own: the Moon in its phase. */
export const plainMoon = ({ phase }: Place) => moon(phase);

/** Turns the Moon of the "tonight" scene under `root` to tonight's phase. */
export function showTonight(root: ParentNode) {
    const { k, dir } = tonight();
    for (const lit of root.querySelectorAll<SVGPathElement>("[data-tonight] .lit")) {
        lit.setAttribute("d", litPath(R, k));
        lit.setAttribute("transform", `rotate(${-dir})`);
    }
}
