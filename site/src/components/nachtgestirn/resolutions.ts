import { gpu } from "../dunstkreis/atmosphere";
import { MAPS_TEXELS, type MapSize, mapsProgress, onMapsProgress } from "./renderer";

type Choice = Exclude<MapSize, "auto">;

/** What each set is called in a figure's status line. */
export const RESOLUTION_NAMES: Record<Choice, string> = {
    small: "512 maps",
    medium: "1K maps",
    large: "4K maps",
    "8k": "8K maps",
    "16k": "16K color map and 8K heights",
    "8k-strip": "8K strip over the 4K maps",
    "16k-strip": "16K strip over the 4K maps",
};

/**
 * Wires a figure's row of map resolutions (Resolutions.astro) on `root`: `onChoose` with the one clicked, the one
 * chosen pressed, its spinner while it comes, the bar under the row as far as it has come, and the ones the GPU cannot
 * hold disabled. Returns the chosen one's getter.
 */
export function mapResolutions(root: HTMLElement, initial: Choice, onChoose: () => void) {
    let chosen = initial;
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-resolution]")];
    const limit = gpu.device?.limits.maxTextureDimension2D ?? 8192;
    for (const button of buttons) {
        const value = button.dataset.resolution as Choice;
        if (MAPS_TEXELS[value] > limit) {
            button.disabled = true;
            button.title += `, more than this GPU's ${limit} texels`;
        }
        button.addEventListener("click", () => {
            chosen = value;
            show();
            onChoose();
        });
    }
    function show() {
        const coming = mapsProgress.get(chosen);
        for (const button of buttons) {
            const on = button.dataset.resolution === chosen;
            button.setAttribute("aria-pressed", String(on));
            button.toggleAttribute("data-busy", on && coming !== undefined);
        }
        root.toggleAttribute("data-progress", coming !== undefined && coming.total > 0);
        root.style.setProperty("--progress", coming && coming.total > 0 ? String(coming.loaded / coming.total) : "0");
    }
    onMapsProgress(show);
    show();
    return () => chosen;
}
