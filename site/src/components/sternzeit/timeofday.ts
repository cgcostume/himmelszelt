import * as precise from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { paintRange } from "../range";
import { onChange, state, update } from "./state";
import { clockOffsetMs, DAY_MS, instantOf, wallDayOf } from "./zone";

const MINUTE_MS = 60_000;
// The moment a time slider set to 24:00: the next midnight, still counted to the day it ends, so the thumb stays at
// the end, until anything else moves the moment.
let dayEndJd = Number.NaN;

/** The moment's day on the chosen clock, and how far into it, in milliseconds; 24:00 from a slider counts to its day. */
export function momentOnClock() {
    const ms = precise.dateFromJulianDay(state.jd).getTime();
    const day = wallDayOf(ms) - (state.jd === dayEndJd ? 1 : 0);
    return { day, timeOfDay: ms + clockOffsetMs(new Date(ms)) - day * DAY_MS };
}

/** Wires every time-of-day slider on the page: it sets the moment's time on the clock and keeps its date. */
export function timeOfDaySliders() {
    for (const label of document.querySelectorAll("[data-time-of-day]")) {
        if (label.hasAttribute("data-wired")) continue;
        label.setAttribute("data-wired", "");
        const input = find<HTMLInputElement>('[data-field="time"]', label);
        const output = find('[data-field="timeValue"]', label);
        input.addEventListener("input", () => {
            const minutes = Number(input.value);
            const ms = instantOf(momentOnClock().day * DAY_MS + minutes * MINUTE_MS);
            const jd = Number(precise.julianDayFromDate(new Date(ms)).toFixed(7));
            dayEndJd = minutes === 24 * 60 ? jd : Number.NaN;
            update({ jd, live: false, animate: false });
        });
        const render = () => {
            const minutes = Math.round(momentOnClock().timeOfDay / MINUTE_MS);
            input.value = String(minutes);
            paintRange(input);
            output.textContent = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
        };
        onChange(render);
        render();
    }
}
