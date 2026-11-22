// The rail beside the chapter (see Rail.astro): which section the reader is in and how far through the chapter, and its
// groups of settings, each live where a figure on the page reads it, muted where none does or the chapter keeps it.

const rail = document.querySelector<HTMLElement>(".rail");
const main = document.querySelector<HTMLElement>("main");

if (rail && main) {
    const links = [...rail.querySelectorAll<HTMLAnchorElement>("a[data-section]")];
    const headings = links
        .map((link) => document.getElementById(link.dataset.section ?? ""))
        .filter((heading): heading is HTMLElement => heading !== null);
    // Each section's figures after its name, by the numbers the captions count (see Base.astro), to jump to.
    const figures = [...main.querySelectorAll<HTMLElement>("figure[id]:has(> .figure-caption)")];
    for (const [index, figure] of figures.entries()) {
        const before = headings.filter(
            (heading) => heading.compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
        const link = links.find((candidate) => candidate.dataset.section === before.at(-1)?.id);
        const item = link?.parentElement;
        if (!item) continue;
        let numbers = item.querySelector<HTMLElement>(".rail-figures");
        if (!numbers) {
            numbers = Object.assign(document.createElement("span"), { className: "rail-figures" });
            item.append(numbers);
        }
        const number = Object.assign(document.createElement("a"), {
            href: `#${figure.id}`,
            textContent: String(index + 1),
        });
        number.title = `Figure ${index + 1}`;
        numbers.append(number);
    }

    const fill = rail.querySelector<HTMLElement>(".rail-fill");
    const percent = rail.querySelector<HTMLElement>(".rail-percent");
    const line = document.querySelector<HTMLElement>(".read-line");

    // Only on scrolling or resizing, once a frame at most: nothing runs while the page stands still.
    let pending = false;
    const measure = () => {
        pending = false;
        const top = main.getBoundingClientRect().top + window.scrollY;
        const end = top + main.offsetHeight - window.innerHeight;
        const progress = Math.min(1, Math.max(0, (window.scrollY - top) / Math.max(1, end - top)));
        fill?.style.setProperty("width", `${progress * 100}%`);
        line?.style.setProperty("--progress", String(progress));
        if (percent) percent.textContent = `${String(Math.round(progress * 100)).padStart(2, "0")}%`;
        // The section whose heading last passed a quarter down the window; none before the first.
        const mark = window.innerHeight / 4;
        let current: HTMLElement | null = null;
        for (const heading of headings) if (heading.getBoundingClientRect().top <= mark) current = heading;
        for (const link of links) {
            if (link.dataset.section === current?.id) link.setAttribute("aria-current", "location");
            else link.removeAttribute("aria-current");
        }
    };
    const request = () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(measure);
    };
    window.addEventListener("scroll", request, { passive: true });
    window.addEventListener("resize", request);
    new ResizeObserver(request).observe(main);
    measure();

    // Remembers how the reader leaves each group, folded or open; the inline script in Rail.astro sets it on the next page.
    const FOLDS = "sternwarte:rail";
    for (const fold of rail.querySelectorAll<HTMLDetailsElement>("details")) {
        const name = fold.closest<HTMLElement>("[data-group]")?.dataset.group;
        if (!name) continue;
        fold.addEventListener("toggle", () => {
            try {
                const folds = JSON.parse(localStorage.getItem(FOLDS) ?? "{}");
                localStorage.setItem(FOLDS, JSON.stringify({ ...folds, [name]: fold.open }));
            } catch {}
        });
    }

    const local = new Set((rail.dataset.local ?? "").split(" ").filter(Boolean));
    const group = (name: string) => rail.querySelector<HTMLElement>(`[data-group="${name}"]`);
    // Muted, never removed: the groups keep their places, whatever the page holds.
    const mute = (element: HTMLElement | null, why: string) => {
        if (!element) return;
        element.dataset.muted = "";
        element.inert = true;
        // Said in the group's summary where it has one, else under it.
        const note = element.querySelector<HTMLElement>('summary > [data-field="summary"], .rail-why');
        if (note) note.textContent = why;
    };
    const NONE = "No figure in this chapter reads it.";
    const KEPT = "In the figures: this chapter is about it.";

    // The moment and place: live wherever a figure follows it, which then has a set of controls under it.
    if (!main.querySelector(".moment:not([data-environments])")) mute(group("moment"), NONE);

    // The tone curve and the HDR headroom, shared by every sky the page renders.
    const display = group("display");
    if (local.has("display")) mute(display, KEPT);
    else if (!main.querySelector('[data-hdr="choice"], input[name$="-tone"]')) mute(display, NONE);
    else if (display) {
        const { bindHdr, bindToneCurveChoice, onDisplay } = await import("../dunstkreis/atmosphere");
        bindToneCurveChoice(display.querySelectorAll<HTMLInputElement>('input[name="rail-tone"]'));
        const note = display.querySelector<HTMLElement>('[data-hdr="note"]');
        const choice = display.querySelector<HTMLElement>('[data-hdr="choice"]');
        if (note && choice) bindHdr(note, choice);
        // The tone curve and the headroom in the summary, as the radios show them once the binders above have set them.
        const summary = display.querySelector<HTMLElement>('summary > [data-field="summary"]');
        const summarize = () => {
            const curve = display.querySelector<HTMLInputElement>('input[name="rail-tone"]:checked');
            const headroom = Number(choice?.querySelector<HTMLInputElement>("input:checked")?.value ?? 1);
            const name =
                curve?.value === "clip" ? "no tone curve" : `${curve?.nextElementSibling?.textContent} tone curve`;
            if (summary) summary.textContent = `${name}, ${headroom > 1 ? `HDR ${headroom}\u00d7` : "SDR"}`;
        };
        summarize();
        onDisplay(summarize);
    }
}

export {};
