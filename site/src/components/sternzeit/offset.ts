import { find } from "../dom";
import { paintRange } from "../range";
import { onChange, state, update } from "./state";

const MINUTE = 1 / 1440;

/** Signed hours and minutes, as the offset beside a slider: "+1:05", "−0:30". */
function signedTime(minutes: number) {
    const m = Math.round(Math.abs(minutes));
    return `${minutes < 0 ? "\u2212" : "+"}${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** Signed days to a tenth, as the offset beside a slider over a lunation: "+12.5 d". */
function signedDays(hours: number) {
    return `${hours < 0 ? "\u2212" : "+"}${(Math.abs(hours) / 24).toFixed(1)}\u202Fd`;
}

/**
 * Wires every offset slider on the page, in minutes either way of an anchor, or in hours where `data-offset="hours"`:
 * the moment where something else last set it, a jump to an eclipse's maximum most of all; a change of place alone
 * keeps that anchor.
 */
export function offsetSliders() {
    for (const label of document.querySelectorAll("[data-offset]")) {
        if (label.hasAttribute("data-wired")) continue;
        label.setAttribute("data-wired", "");
        const input = find<HTMLInputElement>('[data-field="offset"]', label);
        const output = find('[data-field="offsetValue"]', label);
        const hours = label.getAttribute("data-offset") === "hours";
        const step = hours ? 60 * MINUTE : MINUTE;
        let anchor = state.jd;
        let slid = Number.NaN;
        input.addEventListener("input", () => {
            slid = Number((anchor + Number(input.value) * step).toFixed(7));
            update({ jd: slid, live: false, animate: false }, input);
        });
        const render = () => {
            // Animated, the thumb runs along from where it was, and starts over in the middle at either end.
            const away = (state.jd - anchor) / step;
            if (state.jd !== slid && (!state.animate || Math.abs(away) > Number(input.max))) anchor = state.jd;
            const steps = Math.round((state.jd - anchor) / step);
            input.value = String(steps);
            paintRange(input);
            output.textContent = hours ? signedDays(steps) : signedTime(steps);
        };
        onChange(render);
        render();
    }
}
