import { momentLink, state } from "./sternzeit/state";

/** An element's text in one line, without the glossary's tooltips inside it. */
function words(element: Element) {
    const copy = element.cloneNode(true) as Element;
    for (const tip of copy.querySelectorAll(".term-tip")) tip.remove();
    return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** What a control is called: the word it shows, else its label, else its title. */
const nameOf = (element: Element) =>
    words(element) || element.getAttribute("aria-label") || element.getAttribute("title") || "control";

/**
 * Wires the figure's `[data-field=copyInfo]` button: a click copies, as JSON, all it takes to see the figure again,
 * its number, its caption, a link to its moment and place, its switches, sliders and status lines, and what `extra`
 * adds; `link` replaces the plain link, for a figure that reads more of its state from it.
 */
export function figureInfo(
    root: HTMLElement,
    extra: () => Record<string, unknown> = () => ({}),
    link: () => string = () => momentLink(root.id),
) {
    const button = root.querySelector<HTMLElement>("[data-field=copyInfo]");
    if (!button) return;
    button.addEventListener("click", async () => {
        const captions = [...document.querySelectorAll(".figure-caption")];
        const caption = root.querySelector(".figure-caption");
        const switches: Record<string, boolean> = {};
        for (const toggle of root.querySelectorAll<HTMLElement>("button[aria-pressed]")) {
            const field = toggle.dataset.field;
            if (toggle.hidden || toggle.dataset.resolution || toggle.dataset.pick || field === "fullscreen") continue;
            switches[nameOf(toggle)] = toggle.getAttribute("aria-pressed") === "true";
        }
        const resolution = root.querySelector<HTMLElement>("[data-resolution][aria-pressed=true]");
        const sliders: Record<string, number> = {};
        for (const input of root.querySelectorAll<HTMLInputElement>("input[type=range]")) {
            sliders[nameOf(input)] = Number(input.value);
        }
        const status = [...root.querySelectorAll(".view-status, [data-field=note]")].map(words).filter(Boolean);
        const info = {
            figure: caption ? `Figure ${captions.indexOf(caption) + 1}` : root.id,
            caption: caption ? words(caption).replace(/^Figure\s\d+\.\s*/, "") : undefined,
            link: link(),
            utc: new Date((state.jd - 2440587.5) * 86_400_000).toISOString(),
            julianDay: state.jd,
            latitude: state.latitude,
            longitude: state.longitude,
            heightM: state.heightM,
            ...(resolution ? { maps: resolution.dataset.resolution } : {}),
            switches,
            sliders,
            status: [...new Set(status)],
            ...extra(),
        };
        try {
            await navigator.clipboard.writeText(`${JSON.stringify(info, null, 4)}\n`);
            button.toggleAttribute("data-copied", true);
            setTimeout(() => button.removeAttribute("data-copied"), 1500);
        } catch {
            button.title = "Copying failed, this browser did not allow it";
        }
    });
}
