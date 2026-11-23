// The rail beside the chapter (see Rail.astro): which section the reader is in and how far through the chapter, and its
// groups of settings, each live where a figure on the page reads it, muted where none does or the chapter keeps it.

import { progressBar } from "../dither";
import { paintRange } from "../range";
import { followSwitch, onSetting, type SettingName, setSetting, settings } from "../settings";

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

    const bar = rail.querySelector<SVGSVGElement>(".rail-bar");
    const fill = bar ? progressBar(bar, 8) : undefined;
    const percent = rail.querySelector<HTMLElement>(".rail-percent");
    const line = document.querySelector<HTMLElement>(".read-line");

    // Only on scrolling or resizing, once a frame at most: nothing runs while the page stands still.
    let pending = false;
    const measure = () => {
        pending = false;
        const top = main.getBoundingClientRect().top + window.scrollY;
        const end = top + main.offsetHeight - window.innerHeight;
        const progress = Math.min(1, Math.max(0, (window.scrollY - top) / Math.max(1, end - top)));
        fill?.(progress);
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

    const group = (name: string) => rail.querySelector<HTMLElement>(`[data-group="${name}"]`);
    // Muted, never removed: the groups keep their places, whatever the page holds.
    const mute = (element: HTMLElement | null, why: string) => {
        if (!element) return;
        element.dataset.muted = "";
        // Its controls out of reach, its fold not: a muted group still folds away behind its name.
        const fold = element.matches("details") ? element : element.querySelector("details");
        for (const part of fold ? fold.children : element.children)
            if (part.tagName !== "SUMMARY") (part as HTMLElement).inert = true;
        const copy = fold?.querySelector<HTMLElement>("summary .icon-button");
        if (copy) copy.inert = true;
        // Said in the group's summary where it has one, else under it.
        const note = element.querySelector<HTMLElement>('summary > [data-field="summary"], .rail-why');
        if (note) note.textContent = why;
    };
    const NONE = "No figure here reads it.";

    // The moment and place: live wherever a figure follows it, which then has a set of controls under it.
    if (!main.querySelector(".moment:not([data-environments])")) mute(group("moment"), NONE);

    // An exposure compensation as the rail writes it: "+0.3 EV", a true minus, a thin space before the unit.
    const SIGNED = new Intl.NumberFormat("en", { minimumFractionDigits: 1, signDisplay: "exceptZero" });
    const stops = (value: number) => `${SIGNED.format(value).replace("-", "\u2212")}\u202fEV`;
    // The tone curve, the HDR headroom and the exposure, where the chapter's figures read them: Rail.astro leaves out
    // the groups and rows a page does not need.
    const display = group("display");
    if (display) {
        const { bindHdr, bindToneCurveChoice, onDisplay } = await import("../dunstkreis/atmosphere");
        bindToneCurveChoice(display.querySelectorAll<HTMLInputElement>('input[name="rail-tone"]'));
        const note = display.querySelector<HTMLElement>('[data-hdr="note"]');
        const choice = display.querySelector<HTMLElement>('[data-hdr="choice"]');
        if (note && choice) bindHdr(note, choice);
        // The tone curve and the headroom in the summary, as the radios show them once the binders above have set them.
        const summary = display.querySelector<HTMLElement>('summary > [data-field="summary"]');
        const slider = display.querySelector('[data-setting="exposure"]');
        const summarize = () => {
            const curve = display.querySelector<HTMLInputElement>('input[name="rail-tone"]:checked');
            const headroom = Number(choice?.querySelector<HTMLInputElement>("input:checked")?.value ?? 1);
            const name =
                curve?.value === "clip" ? "no tone curve" : `${curve?.nextElementSibling?.textContent} tone curve`;
            const exposure = settings.exposure && slider ? `, ${stops(settings.exposure)}` : "";
            if (summary) summary.textContent = `${name}, ${headroom > 1 ? `HDR ${headroom}\u00d7` : "SDR"}${exposure}`;
        };
        summarize();
        onDisplay(summarize);
        onSetting("exposure", summarize);
        // Where this display or browser cannot show more than SDR white, said in brackets after the name, the options
        // muted by bindHdr; where it can, nothing more.
        const state = Object.assign(document.createElement("span"), { className: "rail-state" });
        choice?.querySelector(".steps-heading")?.append(state);
        const mark = () => {
            const off = [...(choice?.querySelectorAll<HTMLInputElement>("input") ?? [])].some(
                (input) => input.disabled,
            );
            state.textContent = off ? " (unavailable)" : "";
            state.title = off ? (choice?.querySelector<HTMLElement>("label:has(:disabled)")?.title ?? "") : "";
        };
        mark();
        onDisplay(mark);
    }

    // The settings in rows of radios, or a slider, each a value of settings.ts: set by the inline script in Rail.astro
    // before the first paint, kept up to date here, and choosing one sets it for every figure on every page.
    const parse = (text: string) => {
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    };
    for (const row of rail.querySelectorAll<HTMLElement>(".rail-row[data-setting]")) {
        const name = row.dataset.setting as SettingName;
        const slider = row.querySelector<HTMLInputElement>('input[type="range"]');
        const output = row.querySelector("output");
        const radios = [...row.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
        const show = () => {
            const value = settings[name];
            if (slider) {
                if (document.activeElement !== slider) slider.value = String(value);
                paintRange(slider);
                if (output) output.textContent = stops(Number(value));
            }
            for (const radio of radios) radio.checked = radio.value === String(value);
        };
        slider?.addEventListener("input", () => setSetting(name, Math.round(Number(slider.value) * 10) / 10));
        slider?.addEventListener("dblclick", () => setSetting(name, 0));
        for (const radio of radios) radio.addEventListener("change", () => setSetting(name, parse(radio.value)));
        onSetting(name, show);
        show();
    }

    // What each group reads, in its summary, unless muted, which says why there instead.
    const SUMMARIES: Record<string, [SettingName[], () => string]> = {
        quality: [["quality", "detail"], () => `${settings.quality} quality, ${settings.detail} maps`],
        stars: [
            ["catalog", "milkyWay"],
            () =>
                `${{ yale: "Yale", hipparcos: "Hipparcos", tycho: "Tycho-2" }[settings.catalog]}, ${settings.milkyWay ? "Milky Way" : "no Milky Way"}`,
        ],
        annotations: [
            ["marks", "groundGrid", "labels"],
            () =>
                [
                    settings.marks === "auto" ? "" : `marks ${settings.marks}`,
                    settings.groundGrid ? "" : "no ground grid",
                    settings.labels === "auto" ? "" : `labels ${settings.labels}`,
                ]
                    .filter(Boolean)
                    .join(", ") || "as each figure starts",
        ],
    };
    for (const [name, [names, text]] of Object.entries(SUMMARIES)) {
        const summary = group(name)?.querySelector<HTMLElement>('summary > [data-field="summary"]');
        if (!summary) continue;
        const write = () => {
            summary.textContent = text();
        };
        onSetting(names, write);
        write();
    }

    // The figures' switches that follow a setting until the reader flips them (see settings.ts).
    const asked = (on: string, off: string) => (value: unknown) => (value === on ? true : value === off ? false : null);
    for (const button of main.querySelectorAll<HTMLElement>('[data-setting="labels"]'))
        followSwitch(button, "labels", asked("on", "off"));
    for (const button of main.querySelectorAll<HTMLElement>('[data-setting="marks"]'))
        followSwitch(button, "marks", (value) => (value === "auto" ? null : value !== "off"));
}
