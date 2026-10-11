import { find } from "../dom";
import { paintRange } from "../range";
import { onChange, state, update } from "./state";

/** Wires every latitude slider on the page: it sets the place's latitude, whole degrees at a time; the longitude stays. */
export function latitudeSliders() {
    for (const label of document.querySelectorAll("[data-latitude]")) {
        if (label.hasAttribute("data-wired")) continue;
        label.setAttribute("data-wired", "");
        const input = find<HTMLInputElement>('[data-field="latitude"]', label);
        const output = find('[data-field="latitudeValue"]', label);
        input.addEventListener("input", () => update({ latitude: Number(input.value) }));
        const render = () => {
            input.value = String(state.latitude);
            paintRange(input);
            output.textContent = `${Math.abs(state.latitude).toFixed(1)}° ${state.latitude < 0 ? "S" : "N"}`;
        };
        onChange(render);
        render();
    }
}
