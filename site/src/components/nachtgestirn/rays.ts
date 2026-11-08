// Buttons already switching: a figure with two canvases asks for its switch twice.
const wired = new WeakSet<Element>();

/**
 * The supersampling switch in the figure around `element`, `[data-field=rays]`: four rays a pixel, their light averaged,
 * or one through its center. Returns what to draw with, null where the figure has no switch.
 */
export function raysOf(element: Element, requestRender: () => void) {
    const button = element.closest("figure")?.querySelector<HTMLElement>("[data-field=rays]") ?? null;
    if (!button) return () => null;
    const on = () => button.getAttribute("aria-pressed") === "true";
    if (!wired.has(button)) {
        wired.add(button);
        button.addEventListener("click", () => button.setAttribute("aria-pressed", String(!on())));
    }
    button.addEventListener("click", requestRender);
    return () => (on() ? { samples: 4, terminatorSamples: 4 } : { samples: 1, terminatorSamples: 1 });
}
