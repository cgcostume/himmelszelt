import * as precise from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { paintRange } from "../range";
import { ephemerisDay, fromSearch, linkedOnLoad, onChange, state, update } from "./state";

// The slider runs through the lunation the moment is in, from one true new moon to the next, the full moon in the
// middle: the moments the Moon's apparent longitude stands 0° from the Sun's. The first quarter is at 90°, the full
// moon at 180°, the last at 270°. Its value is the Moon's age, the days since the new moon.
const { MEAN_NEW_MOON, MEAN_SYNODIC_MONTH } = precise.moon;
const HOUR = 1 / 24;
const SECOND = 1 / 86_400;
const elongation = (jd: number) => {
    const t = ephemerisDay(jd);
    return precise.moon.apparentEclipticalPosition(t).longitude - precise.sun.apparentLongitude(t);
};
/** When, near `guess`, the elongation reaches `target` degrees: Newton's method on the mean rate, to a second. */
function phaseTime(guess: number, target: number) {
    let jd = guess;
    for (let i = 0; i < 10; i++) {
        const step = ((((((elongation(jd) - target + 180) % 360) + 360) % 360) - 180) / 360) * MEAN_SYNODIC_MONTH;
        jd -= step;
        if (Math.abs(step) < SECOND) break;
    }
    return jd;
}
interface Lunation {
    start: number;
    end: number;
    /** Each phase's moment and elongation, new moon to new moon. */
    phases: [number, number][];
}
function lunationAt(jd: number): Lunation {
    const k = Math.floor((jd - MEAN_NEW_MOON) / MEAN_SYNODIC_MONTH);
    let start = phaseTime(MEAN_NEW_MOON + k * MEAN_SYNODIC_MONTH, 0);
    if (start > jd) start = phaseTime(start - MEAN_SYNODIC_MONTH, 0);
    let end = phaseTime(start + MEAN_SYNODIC_MONTH, 0);
    if (end <= jd) [start, end] = [end, phaseTime(end + MEAN_SYNODIC_MONTH, 0)];
    const between = [90, 180, 270].map((target, i): [number, number] => [
        phaseTime(start + ((i + 1) / 4) * MEAN_SYNODIC_MONTH, target),
        target,
    ]);
    return { start, end, phases: [[start, 0], ...between, [end, 0]] };
}

/** A phase as a small disc, lit on the side the Sun is on: the right while waxing, seen from the north. */
function phaseIcon(target: number, north: boolean) {
    const half = (right: boolean) => `<path d="M0,-4A4,4 0 0 ${right ? 1 : 0} 0,4Z"/>`;
    const lit = target === 180 ? '<circle r="4"/>' : target === 0 ? "" : half((target === 90) === north);
    return `<svg viewBox="-5 -5 10 10"><circle r="4" class="phase-outline"/>${lit}</svg>`;
}
const PHASE_NAMES: Record<number, string> = {
    180: "full moon",
    270: "last quarter",
    0: "new moon",
    90: "first quarter",
};

/** Where a lunation slider takes its moment from and puts it: the page's shared one, or a figure's own. */
export interface MomentSource {
    jd(): number;
    set(jd: number): void;
    onChange(listener: () => void): void;
    /** Whether the phases' icons are drawn as from the northern hemisphere. */
    north(): boolean;
}
const PAGE: MomentSource = {
    jd: () => state.jd,
    set: (jd) => update({ jd, live: false, animate: false }),
    onChange: (listener) => onChange(listener),
    north: () => state.latitude >= 0,
};

/** Wires one lunation slider, `label` a `[data-lunation]`, to `source`. */
export function wireLunationSlider(label: Element, source: MomentSource = PAGE) {
    if (label.hasAttribute("data-wired")) return;
    label.setAttribute("data-wired", "");
    const lunationInput = find<HTMLInputElement>('[data-field="lunation"]', label);
    const lunationValue = find('[data-field="lunationValue"]', label);
    const phasesEl = find('[data-field="phases"]', label);
    let lunation = lunationAt(source.jd());
    // The slider moves the moment through the lunation by whole hours and keeps its minutes; never quite to the next new
    // moon, where the next lunation begins.
    lunationInput.addEventListener("input", () => {
        const { start, end } = lunation;
        const within = (source.jd() - start) / HOUR;
        const jd = start + (Number(lunationInput.value) + within - Math.floor(within)) * HOUR;
        const kept = Math.min(Math.max(jd, start + SECOND), end - 60 * SECOND);
        source.set(Number(kept.toFixed(7)));
    });
    const render = () => {
        const jd = source.jd();
        if (jd < lunation.start || jd >= lunation.end) lunation = lunationAt(jd);
        const { start, end, phases } = lunation;
        lunationInput.max = String(Math.floor((end - start) / HOUR));
        lunationInput.value = String(Math.floor((jd - start) / HOUR));
        paintRange(lunationInput);
        lunationValue.textContent = `${(jd - start).toFixed(1)} d`;
        const north = source.north();
        phasesEl.innerHTML = phases
            .map(([at, target]) => {
                const left = (((at - start) / (end - start)) * 100).toFixed(2);
                return `<span class="figure-slider-mark" style="left: ${left}%" title="${PHASE_NAMES[target]}">${phaseIcon(target, north)}</span>`;
            })
            .join("");
    };
    source.onChange(render);
    render();
}

/** Wires every lunation slider on the page to the page's moment, but those a figure wires to its own (`data-own`). */
export function lunationSliders() {
    for (const label of document.querySelectorAll("[data-lunation]:not([data-own])")) wireLunationSlider(label);
}

/**
 * A figure's own moment, apart from the page's: it starts at `jd`, only the figure's lunation slider (`own` on
 * `LunationSlider`) moves it, and `listener` hears of it. A link to the figure (`#` its id) with a moment sets it
 * instead: one that opened the page, or an experiment in its caption, which then leaves the page's moment alone.
 */
export function ownMoment(root: Element, jd: number, listener: () => void) {
    let at = linkedOnLoad && root.id && linkedOnLoad.hash === `#${root.id}` ? linkedOnLoad.jd : jd;
    const listeners = [listener];
    const source: MomentSource = {
        jd: () => at,
        set: (next) => {
            at = next;
            for (const l of listeners) l();
        },
        onChange: (l) => listeners.push(l),
        north: () => true,
    };
    const label = root.querySelector("[data-lunation][data-own]");
    if (label) wireLunationSlider(label, source);
    root.addEventListener("click", (event: Event) => {
        if (!(event instanceof MouseEvent)) return;
        const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href^='?']") : null;
        if (!link || event.ctrlKey || event.metaKey || event.shiftKey || link.hash !== `#${root.id}`) return;
        const next = fromSearch(new URL(link.href).search)?.jd;
        if (next === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        source.set(next);
        root.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return source;
}
