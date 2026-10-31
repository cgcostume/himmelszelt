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
    setPending,
    show,
} from "./hdri";

const KEY = "himmelszelt-hdri";
const boxes = [...document.querySelectorAll<HTMLElement>("[data-environments]")];
const field = <T extends HTMLElement = HTMLElement>(box: HTMLElement, name: string) =>
    box.querySelector(`[data-field="${name}"]`) as T;

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
        for (const thumb of field(box, "gallery").children) {
            thumb.setAttribute("aria-pressed", String((thumb as HTMLElement).dataset.id === hdri.id));
            const busy = (thumb as HTMLElement).dataset.id === pending.id;
            thumb.setAttribute("aria-busy", String(busy));
            thumb.toggleAttribute("data-progress", busy && pending.total > 0);
            (thumb as HTMLElement).style.setProperty("--progress", String(share));
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

function choose(entry: Entry) {
    load(entry).catch(() => status("That one could not be loaded."));
    try {
        localStorage.setItem(KEY, entry.id);
    } catch {}
}
const status = (text: string) => {
    for (const box of boxes) field(box, "status").textContent = text;
};

function loadingBar() {
    const bar = Object.assign(document.createElement("span"), { className: "env-loading" });
    bar.append(document.createElement("span"));
    return bar;
}

let entries: Entry[] = [];
let category = "skies";
let search = "";

/** Every box's gallery: the most downloaded of what the category and the search leave. */
function fill() {
    // Where nothing is searched, the first visit's image leads, whatever its downloads.
    const lead = category === "skies" && !search ? entries.filter(({ id }) => id === DEFAULT_HDRI) : [];
    const shown = [...lead, ...filtered(entries, category, search, 16).filter((entry) => !lead.includes(entry))].slice(
        0,
        16,
    );
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
            return thumb;
        });
        field(box, "gallery").replaceChildren(...thumbs);
        field<HTMLInputElement>(box, "search").value = search;
        for (const radio of box.querySelectorAll<HTMLInputElement>("[data-category]")) {
            radio.checked = radio.value === category;
        }
    }
    status(shown.length === 0 ? "Nothing there: try another category or word." : "");
    refresh();
}

onHdri(refresh);
onLoading(refresh);
// Until the first list and HDRI come.
setPending("first");
for (const box of boxes) {
    field<HTMLInputElement>(box, "search").addEventListener("input", (event) => {
        search = (event.target as HTMLInputElement).value;
        fill();
    });
    for (const radio of box.querySelectorAll<HTMLInputElement>("[data-category]")) {
        radio.addEventListener("change", () => {
            category = radio.value;
            fill();
        });
    }
    field<HTMLInputElement>(box, "file").addEventListener("change", (event) => {
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
            filtered(all, category, "")[0];
        if (first) choose(first);
    })
    .catch(() => {
        setPending(null);
        status("Poly Haven cannot be reached. Your own .hdr file works without it.");
    });
