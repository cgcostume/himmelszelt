import { colorFromColorIndex } from "@himmelszelt/sternenheer";
import { escapeText } from "../sternzeit/figure";

interface Entry {
    value: string;
    name: string;
    /** The IAU name where it differs, the Bayer designation and the HR number; empty for the Sun. */
    designation: string;
    bv: number;
    works: { film: string; year: number; note: string; history: boolean }[];
}

/** A StarPicker driven from its figure: `value` is the picked star's HR number, "sun", or "" for none. */
export interface StarPicker {
    value: string;
    /** Called when the reader picks a star, not when `value` is set. */
    onPick(listener: (value: string) => void): void;
}

const encode = (c: number) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
const signed = (v: number) => (v < 0 ? "−" : "") + Math.abs(v).toFixed(2);

/** The star's color at full value, as CSS. */
function dotColor(bv: number) {
    const rgb = colorFromColorIndex(bv);
    const peak = Math.max(...rgb, 1e-6);
    return `rgb(${rgb.map((c) => encode(Math.min(Math.max(c / peak, 0), 1))).join(" ")})`;
}

/** The most recent work with a short title, or the most recent at all: one that fits the status line's one row. */
function featured(works: Entry["works"]) {
    const recent = [...works].sort((a, b) => b.year - a.year);
    return recent.find((work) => work.film.length <= 20) ?? recent[0];
}

/** The status line with `named`, all or some of the designation. */
function story({ name, bv, works }: Entry, named: string) {
    const work = featured(works);
    const year = work && (work.history && work.year < 1000 ? `AD ${work.year}` : String(work.year));
    const told = !work?.film
        ? escapeText(work?.note ?? "")
        : work.history
          ? `${escapeText(work.film)}, ${year}`
          : `<cite>${escapeText(work.film)}</cite> (${year})`;
    const title = `<span class="status-title">${escapeText(name.replace(/^the/, "The"))}</span>`;
    return `${title}${named ? `, ${escapeText(named)}` : ""}, B−V ${signed(bv)}, ${told}`;
}

/** The picker in `root`, a `[data-star-picker]`: a radio group, arrows and Home/End moving the pick, as in a select. */
export function starPicker(root: HTMLElement): StarPicker {
    const entries = JSON.parse(root.dataset.stars ?? "[]") as Entry[];
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("button[data-value]")];
    const status = root.querySelector<HTMLElement>("[data-field=pickedStar]");
    const listeners: ((value: string) => void)[] = [];
    let current = buttons.find((b) => b.getAttribute("aria-checked") === "true")?.dataset.value ?? "";

    function show() {
        for (const button of buttons) {
            const on = button.dataset.value === current;
            button.setAttribute("aria-checked", String(on));
            button.tabIndex = on || (!current && button === buttons[0]) ? 0 : -1;
        }
        fit();
    }

    // The longest status that fits the one row: the whole designation, without the HR number, the Bayer one alone, none.
    function fit() {
        const entry = entries.find((e) => e.value === current);
        if (!status) return;
        if (!entry) {
            status.innerHTML = "";
            return;
        }
        const parts = entry.designation ? entry.designation.split(", ") : [];
        const tries = [parts, parts.slice(0, -1), parts.slice(-2, -1), []].map((p) => p.join(", "));
        for (const named of new Set(tries)) {
            status.innerHTML = story(entry, named);
            if (status.scrollWidth <= status.clientWidth) break;
        }
    }

    function pick(value: string) {
        current = value;
        show();
        for (const listener of listeners) listener(value);
    }

    for (const button of buttons) {
        const dot = button.querySelector<HTMLElement>(".starpicker-dot");
        if (dot) dot.style.color = dotColor(Number(button.dataset.bv));
        button.addEventListener("click", () => pick(button.dataset.value ?? ""));
        button.addEventListener("keydown", (event) => {
            const i = buttons.indexOf(button);
            const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: -1 }[
                event.key
            ];
            if (next === undefined) return;
            event.preventDefault();
            const target = buttons.at(next % buttons.length);
            if (!target) return;
            target.focus();
            pick(target.dataset.value ?? "");
        });
    }
    show();
    if (status) new ResizeObserver(fit).observe(status);

    return {
        get value() {
            return current;
        },
        set value(value: string) {
            current = value;
            show();
        },
        onPick(listener) {
            listeners.push(listener);
        },
    };
}
