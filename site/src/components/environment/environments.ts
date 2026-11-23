import { barSvg, progressBar } from "../dither";
import {
    catalog,
    DEFAULT_HDRI,
    type Entry,
    filtered,
    hdri,
    load,
    onHdri,
    onLoading,
    pending,
    type Resolution,
    setPending,
    show,
} from "./hdri";

const KEY = "himmelszelt-hdri";
const boxes = [...document.querySelectorAll<HTMLElement>("[data-environments]")];
const field = <T extends HTMLElement = HTMLElement>(box: HTMLElement, name: string) =>
    box.querySelector(`[data-field="${name}"]`) as T;
// What a box may leave out.
const optional = <T extends HTMLElement = HTMLElement>(box: HTMLElement, name: string) =>
    box.querySelector<T>(`[data-field="${name}"]`);

const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(1)}\u202fMB`;

function refresh() {
    const share = pending.total > 0 ? Math.min(pending.loaded / pending.total, 1) : 0;
    for (const box of boxes) {
        const chosen = entries.find(({ id }) => id === pending.id)?.name;
        if (pending.id)
            field(box, "summary").textContent = pending.total
                ? `Loading ${chosen ?? "the HDRI"}: ${megabytes(pending.loaded)} of ${megabytes(pending.total)}`
                : `Loading ${chosen ?? "the HDRI"}…`;
        else if (hdri.name) field(box, "summary").textContent = `${hdri.name}, EV ${hdri.ev100.toFixed(1)}`;
        for (const thumb of field(box, "gallery").querySelectorAll(".environments-thumb")) {
            thumb.setAttribute("aria-pressed", String((thumb as HTMLElement).dataset.id === hdri.id));
            const busy = (thumb as HTMLElement).dataset.id === pending.id;
            thumb.setAttribute("aria-busy", String(busy));
            thumb.toggleAttribute("data-progress", busy && pending.total > 0);
            (thumb as HTMLElement).style.setProperty("--progress", String(share));
            if (busy) ditheredLoading(thumb)(share);
            const percent = thumb.querySelector(".env-percent");
            if (percent) percent.textContent = busy ? `${Math.round(share * 100)}%` : "";
        }
        for (const button of field(box, "gallery").querySelectorAll<HTMLElement>("[data-resolution]")) {
            const item = button.closest<HTMLElement>(".environments-item");
            const shown = item?.dataset.id === hdri.id && button.dataset.resolution === hdri.resolution;
            button.setAttribute("aria-pressed", String(shown));
        }
    }
}

async function openFile(file: File) {
    status("");
    setPending("file");
    try {
        await show(file.name, file.name, await file.arrayBuffer());
    } catch {
        status("That file could not be read as Radiance HDR.");
    } finally {
        setPending(null);
    }
}

function choose(entry: Entry, resolution?: Resolution) {
    if (resolution) {
        if (entry.id === hdri.id && resolution === hdri.resolution) return;
        hdri.resolution = resolution;
    }
    load(entry).catch(() => status("That one could not be loaded."));
    try {
        localStorage.setItem(KEY, entry.id);
    } catch {}
}
const status = (text: string) => {
    for (const box of boxes) {
        const note = optional(box, "status");
        if (note) note.textContent = text;
    }
};

// The bar dithered (see dither.ts): made on the first load, as the bar has no width before it shows.
const dithered = new WeakMap<Element, (share: number) => void>();
function ditheredLoading(thumb: Element) {
    let set = dithered.get(thumb);
    if (!set) {
        const svg = barSvg("env-bar");
        thumb.querySelector(".env-loading > span:first-child")?.replaceWith(svg);
        set = progressBar(svg, 8);
        dithered.set(thumb, set);
    }
    return set;
}

function loadingBar() {
    const bar = Object.assign(document.createElement("span"), { className: "env-loading" });
    bar.append(
        document.createElement("span"),
        Object.assign(document.createElement("span"), { className: "env-percent" }),
    );
    return bar;
}

// 1K stays the first load on a small or saving connection (see hdri.ts), but is not offered: nobody picks it.
const RESOLUTIONS: Resolution[] = ["2k", "4k", "8k"];
let entries: Entry[] = [];
let search = "";

/**
 * Every box's gallery: the 24 most downloaded by day outdoors, the first visit's image leading whatever its downloads;
 * searched, the 24 most downloaded of everything the words find, rooms and nights too.
 */
function fill() {
    const lead = search ? [] : entries.filter(({ id }) => id === DEFAULT_HDRI);
    const shown = search
        ? filtered(entries, "all", search, 24)
        : [
              ...lead,
              ...entries
                  .filter(({ categories }) => !["indoor", "studio", "night"].some((name) => categories.includes(name)))
                  .filter((entry) => !lead.includes(entry)),
          ].slice(0, 24);
    for (const box of boxes) {
        const thumbs = shown.map((entry) => {
            const thumb = document.createElement("button");
            Object.assign(thumb, { type: "button", className: "environments-thumb", title: entry.name });
            thumb.setAttribute("aria-label", entry.name);
            thumb.dataset.id = entry.id;
            thumb.append(
                Object.assign(document.createElement("img"), { src: entry.thumbnail, alt: "", loading: "lazy" }),
                loadingBar(),
            );
            thumb.addEventListener("click", () => choose(entry));
            // Its resolutions over its foot, on hover or focus: one click loads it at the one pressed.
            const resolutions = Object.assign(document.createElement("span"), { className: "environments-res" });
            for (const resolution of RESOLUTIONS) {
                const button = Object.assign(document.createElement("button"), {
                    type: "button",
                    textContent: resolution.toUpperCase(),
                    title: `${entry.name} at ${resolution.toUpperCase()}`,
                });
                button.dataset.resolution = resolution;
                button.addEventListener("click", () => choose(entry, resolution));
                resolutions.append(button);
            }
            const item = Object.assign(document.createElement("div"), { className: "environments-item" });
            item.dataset.id = entry.id;
            item.append(thumb, resolutions);
            return item;
        });
        field(box, "gallery").replaceChildren(...thumbs);
        const input = optional<HTMLInputElement>(box, "search");
        if (input && input.value !== search) input.value = search;
    }
    status(shown.length === 0 ? "Nothing there: try another word." : "");
    refresh();
}

onHdri(refresh);
onLoading(refresh);
// Until the first list and HDRI come.
setPending("first");
for (const box of boxes) {
    optional<HTMLInputElement>(box, "search")?.addEventListener("input", (event) => {
        search = (event.target as HTMLInputElement).value;
        fill();
    });
    optional<HTMLInputElement>(box, "file")?.addEventListener("change", (event) => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (file) openFile(file);
    });
}
// A file dropped on a box, or on any figure showing the HDRI.
for (const target of document.querySelectorAll<HTMLElement>("[data-environments], [data-env-frame]")) {
    target.addEventListener("dragover", (event) => {
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        target.toggleAttribute("data-dropping", true);
    });
    target.addEventListener("dragleave", (event) => {
        if (!target.contains(event.relatedTarget as Node | null)) target.removeAttribute("data-dropping");
    });
    target.addEventListener("drop", (event) => {
        event.preventDefault();
        target.removeAttribute("data-dropping");
        const file = event.dataTransfer?.files[0];
        if (file) openFile(file);
    });
}
catalog()
    .then((all) => {
        entries = all;
        fill();
        let stored: string | null = null;
        try {
            stored = localStorage.getItem(KEY);
        } catch {}
        const first =
            all.find(({ id }) => id === stored) ??
            all.find(({ id }) => id === DEFAULT_HDRI) ??
            filtered(all, "skies", "")[0];
        if (first) choose(first);
    })
    .catch(() => {
        setPending(null);
        status("Poly Haven cannot be reached. Your own .hdr file works without it.");
    });
