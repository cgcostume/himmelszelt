// A folded group of a figure's options says after its name what is chosen in it, as the rail's summaries do: the chosen
// option of each choice and the name of each switch that is on, in the listing's order (see OptionGroup.astro).

const GROUPS = "details.sky-group";
const CHOSEN = 'input[type="radio"]:checked, input[type="checkbox"]:checked, .view-toggle[aria-pressed="true"]';

const words = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();

function summarize(group: HTMLDetailsElement) {
    const out = group.querySelector(":scope > summary > .sky-group-values");
    const items = group.querySelector(":scope > .sky-group-items");
    if (!out || !items) return;
    const chosen = [...items.querySelectorAll(CHOSEN)].filter((element) => !element.closest("[hidden]"));
    const text = chosen
        .map((element) =>
            element instanceof HTMLInputElement ? words(element.nextElementSibling ?? element) : words(element),
        )
        .filter(Boolean)
        .join(", ");
    if (out.textContent !== text) out.textContent = text;
}

const groups = [...document.querySelectorAll<HTMLDetailsElement>(GROUPS)];
const pending = new Set<HTMLDetailsElement>();
const request = (target: EventTarget | Node | null) => {
    const group = target instanceof Element ? target.closest<HTMLDetailsElement>(GROUPS) : null;
    if (!group) return;
    if (pending.size === 0)
        queueMicrotask(() => {
            for (const each of pending) summarize(each);
            pending.clear();
        });
    pending.add(group);
};
document.addEventListener("change", (event) => request(event.target), true);
document.addEventListener("toggle", (event) => request(event.target), true);
const observer = new MutationObserver((records) => {
    for (const record of records) request(record.target);
});
for (const panel of new Set(groups.map((group) => group.parentElement)))
    if (panel)
        observer.observe(panel, { subtree: true, attributes: true, attributeFilter: ["aria-pressed", "hidden"] });
groups.forEach(summarize);
// Figures set their options as they start, some without an event: read once more when the page has loaded.
addEventListener("load", () => groups.forEach(summarize), { once: true });

export {};
