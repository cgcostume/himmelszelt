import { find } from "../dom";
import { paintRange } from "../range";
import { onChange, state, update } from "./state";

const MINUTE = 1 / 1440;

/** Signed hours and minutes, as the offset beside a slider: "+1:05", "−0:30". */
function signedTime(minutes: number) {
    const m = Math.round(Math.abs(minutes));
    return `${minutes < 0 ? "\u2212" : "+"}${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * Wires every offset slider on the page, in minutes either way of an anchor: the moment where something else last set
 * it, a jump to an eclipse's maximum most of all; a change of place alone keeps that anchor.
 */
export function offsetSliders() {
    for (const label of document.querySelectorAll("[data-offset]")) {
        if (label.hasAttribute("data-wired")) continue;
        label.setAttribute("data-wired", "");
        const input = find<HTMLInputElement>('[data-field="offset"]', label);
        const output = find('[data-field="offsetValue"]', label);
        let anchor = state.jd;
        let slid = Number.NaN;
        input.addEventListener("input", () => {
            slid = Number((anchor + Number(input.value) * MINUTE).toFixed(7));
            update({ jd: slid, live: false, animate: false }, input);
        });
        const render = () => {
            if (state.jd !== slid) anchor = state.jd;
            const minutes = Math.round((state.jd - anchor) / MINUTE);
            input.value = String(minutes);
            paintRange(input);
            output.textContent = signedTime(minutes);
        };
        onChange(render);
        render();
    }
}
