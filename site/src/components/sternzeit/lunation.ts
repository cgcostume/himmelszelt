import * as precise from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { paintRange } from "../range";
import { ephemerisDay, onChange, state, update } from "./state";

// The slider runs through the lunation the moment is in, from one true full moon to the next: the moments the Moon's
// apparent longitude stands 180° from the Sun's. The last quarter is at 270°, the new moon at 0°, the first at 90°.
const { MEAN_NEW_MOON, MEAN_SYNODIC_MONTH } = precise.moon;
const HOUR = 1 / 24;
const SECOND = 1 / 86_400;
const elongation = (jd: number) => {
    const t = ephemerisDay(jd);
    return precise.moon.position(t).longitude + precise.earth.longitudeNutation(t) - precise.sun.apparentLongitude(t);
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
    /** Each phase's moment and elongation, full moon to full moon. */
    phases: [number, number][];
}
function lunationAt(jd: number): Lunation {
    const k = Math.floor((jd - MEAN_NEW_MOON) / MEAN_SYNODIC_MONTH - 0.5);
    let start = phaseTime(MEAN_NEW_MOON + (k + 0.5) * MEAN_SYNODIC_MONTH, 180);
    if (start > jd) start = phaseTime(start - MEAN_SYNODIC_MONTH, 180);
    let end = phaseTime(start + MEAN_SYNODIC_MONTH, 180);
    if (end <= jd) [start, end] = [end, phaseTime(end + MEAN_SYNODIC_MONTH, 180)];
    const between = [270, 0, 90].map((target, i): [number, number] => [
        phaseTime(start + ((i + 1) / 4) * MEAN_SYNODIC_MONTH, target),
        target,
    ]);
    return { start, end, phases: [[start, 180], ...between, [end, 180]] };
}
let lunation = lunationAt(state.jd);

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

function renderLunation(jd: number, lunationInput: HTMLInputElement, lunationValue: Element, phasesEl: Element) {
    if (jd < lunation.start || jd >= lunation.end) lunation = lunationAt(jd);
    const { start, end, phases } = lunation;
    lunationInput.max = String(Math.floor((end - start) / HOUR));
    lunationInput.value = String(Math.floor((jd - start) / HOUR));
    paintRange(lunationInput);
    lunationValue.textContent = `${(jd - start).toFixed(1)} d`;
    const north = state.latitude >= 0;
    phasesEl.innerHTML = phases
        .map(([at, target]) => {
            const left = (((at - start) / (end - start)) * 100).toFixed(2);
            return `<span class="figure-slider-mark" style="left: ${left}%" title="${PHASE_NAMES[target]}">${phaseIcon(target, north)}</span>`;
        })
        .join("");
}

/** Wires every lunation slider on the page, under the Moon view and the sun path diagram alike. */
export function lunationSliders() {
    for (const label of document.querySelectorAll("[data-lunation]")) {
        if (label.hasAttribute("data-wired")) continue;
        label.setAttribute("data-wired", "");
        const lunationInput = find<HTMLInputElement>('[data-field="lunation"]', label);
        const lunationValue = find('[data-field="lunationValue"]', label);
        const phasesEl = find('[data-field="phases"]', label);
        // The slider moves the moment through the lunation by whole hours and keeps its minutes; never quite to the next full
        // moon, where the next lunation begins.
        lunationInput.addEventListener("input", () => {
            const { start, end } = lunation;
            const within = (state.jd - start) / HOUR;
            const jd = start + (Number(lunationInput.value) + within - Math.floor(within)) * HOUR;
            const kept = Math.min(Math.max(jd, start + SECOND), end - 60 * SECOND);
            update({ jd: Number(kept.toFixed(7)), live: false, animate: false });
        });

        const render = () => renderLunation(state.jd, lunationInput, lunationValue, phasesEl);
        onChange(render);
        render();
    }
}
