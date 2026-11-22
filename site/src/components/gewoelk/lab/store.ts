import type { Designed } from "./kinds";

/**
 * The reader's own kinds of cloud and weathers, kept in the browser: a designer's sliders saved under a name, and a
 * weather as the kind chosen for each place of the sky. A convenience: without storage, as in a private window, the
 * figures work and nothing is kept. Every figure on the page, and every other tab, hears of a change.
 */

const KEY = "sternwarte:gewoelk:presets:v1";
const CHANGED = "gewoelk:presets";
/** How many kinds a designer keeps, and how many weathers the composer. */
export const MOST = 8;
export const NAME_LENGTH = 24;

/** A kind of cloud as saved: its numbers by their names in the library, a `CLOUD_TYPES` entry with every number set. */
export interface OwnKind {
    name: string;
    numbers: Record<string, number | string>;
}
/** A place of a saved weather: what was chosen for it, see `composer.ts`, and its numbers then, should that be gone. */
export interface OwnPlace {
    choice: string;
    numbers: Record<string, number | string> | null;
}
export interface OwnWeather {
    name: string;
    places: Record<"low" | "deep" | "middle" | "high", OwnPlace>;
}
interface Stored {
    designs: Record<Designed, OwnKind[]>;
    weathers: OwnWeather[];
}

const DESIGNS: Designed[] = ["low", "towers", "front", "middle", "high", "voxel"];
const named = (list: unknown): { name: string }[] =>
    Array.isArray(list) ? list.filter((item) => typeof item?.name === "string").slice(0, MOST) : [];

function read(): Stored {
    let stored: Partial<Stored> = {};
    try {
        stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
    } catch {}
    const designs = Object.fromEntries(DESIGNS.map((design) => [design, named(stored.designs?.[design])]));
    return { designs: designs as Record<Designed, OwnKind[]>, weathers: named(stored.weathers) as OwnWeather[] };
}

function write(stored: Stored) {
    try {
        localStorage.setItem(KEY, JSON.stringify(stored));
    } catch {
        return false;
    }
    window.dispatchEvent(new Event(CHANGED));
    return true;
}

/** `item` in `list` under its name, in place of one of that name: null where the list is full. */
function put<T extends { name: string }>(list: T[], item: T) {
    const at = list.findIndex(({ name }) => name === item.name);
    if (at < 0 && list.length >= MOST) return null;
    return at < 0 ? [...list, item] : list.map((kept, i) => (i === at ? item : kept));
}

export type Saved = "saved" | "full" | "failed";

export const ownKinds = (design: Designed) => read().designs[design];
export const ownWeathers = () => read().weathers;

export function saveKind(design: Designed, kind: OwnKind): Saved {
    const stored = read();
    const list = put(stored.designs[design], kind);
    if (!list) return "full";
    return write({ ...stored, designs: { ...stored.designs, [design]: list } }) ? "saved" : "failed";
}
export function deleteKind(design: Designed, name: string) {
    const stored = read();
    const list = stored.designs[design].filter((kind) => kind.name !== name);
    write({ ...stored, designs: { ...stored.designs, [design]: list } });
}
export function saveWeather(weather: OwnWeather): Saved {
    const stored = read();
    const weathers = put(stored.weathers, weather);
    if (!weathers) return "full";
    return write({ ...stored, weathers }) ? "saved" : "failed";
}
export function deleteWeather(name: string) {
    const stored = read();
    write({ ...stored, weathers: stored.weathers.filter((weather) => weather.name !== name) });
}

/** Calls `listener` whenever the saved kinds or weathers change, on this page or in another tab. */
export function onOwnChange(listener: () => void) {
    window.addEventListener(CHANGED, listener);
    window.addEventListener("storage", (event) => {
        if (event.key === KEY || event.key === null) listener();
    });
}

/**
 * A list of saved things in `holder`, each a button that loads it with one beside it that deletes it, then a field for
 * a name and a button that saves under it: over one of that name, or as a new one while there is room.
 */
export function ownList(
    holder: HTMLElement,
    options: {
        names: () => string[];
        load: (name: string) => void;
        save: (name: string) => Saved;
        remove: (name: string) => void;
        what: string;
    },
) {
    const { names, load, save, remove, what } = options;
    const list = holder.appendChild(Object.assign(document.createElement("span"), { className: "own-list" }));
    const form = holder.appendChild(Object.assign(document.createElement("span"), { className: "own-save" }));
    const field = form.appendChild(document.createElement("input"));
    Object.assign(field, { type: "text", maxLength: NAME_LENGTH, placeholder: "name", spellcheck: false });
    field.setAttribute("aria-label", `A name for ${what}`);
    const button = form.appendChild(document.createElement("button"));
    Object.assign(button, { type: "button", className: "view-toggle", textContent: "save" });
    button.title = `Saves ${what} under the name in this browser, over one of that name: ${MOST} at most`;
    const note = holder.appendChild(Object.assign(document.createElement("span"), { className: "own-note" }));
    note.setAttribute("role", "status");
    let chosen = "";

    const show = () => {
        list.replaceChildren(
            ...names().map((name) => {
                const item = Object.assign(document.createElement("span"), { className: "own-item" });
                const use = item.appendChild(document.createElement("button"));
                Object.assign(use, { type: "button", className: "view-toggle", textContent: name });
                use.title = `Loads "${name}"`;
                use.setAttribute("aria-pressed", String(name === chosen));
                use.addEventListener("click", () => {
                    chosen = name;
                    field.value = name;
                    load(name);
                    show();
                });
                const drop = item.appendChild(document.createElement("button"));
                Object.assign(drop, { type: "button", className: "view-toggle own-delete", textContent: "×" });
                drop.title = `Deletes "${name}"`;
                drop.setAttribute("aria-label", `Delete ${name}`);
                drop.addEventListener("click", () => remove(name));
                return item;
            }),
        );
        list.hidden = list.childElementCount === 0;
    };
    const say = (text: string) => {
        note.textContent = text;
        if (!text) return;
        setTimeout(() => {
            if (note.textContent === text) note.textContent = "";
        }, 4000);
    };
    const submit = () => {
        const name = field.value.trim();
        if (!name) return say("Name it first.");
        const saved = save(name);
        if (saved === "saved") chosen = name;
        say(
            saved === "saved"
                ? `Saved "${name}".`
                : saved === "full"
                  ? `${MOST} at most: delete one, or save over one by its name.`
                  : "This browser keeps nothing here.",
        );
        show();
    };
    button.addEventListener("click", submit);
    field.addEventListener("keydown", (event) => {
        // The view's keys are not for a name being typed.
        event.stopPropagation();
        if (event.key === "Enter") submit();
    });
    onOwnChange(show);
    show();
    return {
        /** No saved one is the chosen one any longer: something else was loaded. */
        clear() {
            chosen = "";
            show();
        },
    };
}
