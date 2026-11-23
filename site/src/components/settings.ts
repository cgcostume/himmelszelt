// The reader's settings, the same on every page and across visits (see rail/Rail.astro, which sets them): each kept in
// localStorage as JSON under "sternwarte:<name>", read once, told to whoever listens on a change, in this tab or another.

/** A setting's value when none is stored, the values it takes, and the key an earlier version kept it under, as text. */
const setting = <T extends string | number | boolean>(fallback: T, values?: readonly T[], legacy?: string) => ({
    fallback,
    values,
    legacy,
});
const LEVELS = ["auto", "low", "medium", "high"] as const;

const SETTINGS = {
    /** The tone curve every sky is shown through. */
    toneCurve: setting<"neutral" | "agx" | "aces" | "clip">(
        "neutral",
        ["clip", "neutral", "agx", "aces"],
        "himmelszelt-tone-curve",
    ),
    /** How many times SDR white an HDR display may show; 4 until one is chosen, which an HDR display then shows. */
    headroom: setting<number>(4, [1, 2, 4, 8], "himmelszelt-headroom"),
    /** Stops added to each figure's own metered exposure, +1 twice as bright; a figure exposed by hand ignores it. */
    exposure: setting<number>(0),
    /** How much each figure spends per frame: "auto" its own choice, else mapped to its own steps by each figure. */
    quality: setting<(typeof LEVELS)[number]>("auto", LEVELS),
    /** The size of the maps fetched, the Moon's, the HDRIs' and the Milky Way's, mapped to their sizes by each figure. */
    detail: setting<(typeof LEVELS)[number]>("auto", LEVELS),
    /** The stars drawn, each catalog with the ones before it. */
    catalog: setting<"yale" | "hipparcos" | "tycho">("hipparcos", ["yale", "hipparcos", "tycho"]),
    milkyWay: setting<boolean>(true, [true, false]),
    /** The marks over a sky, the compass and the grid of altitudes; "auto" as each figure starts. */
    marks: setting<"auto" | "off" | "compass" | "grid">("auto", ["auto", "off", "compass", "grid"]),
    /** The grid on the ground in a flight. */
    groundGrid: setting<boolean>(true, [true, false]),
    /** The annotations a figure writes over its view; "auto" as each figure starts. */
    labels: setting<"auto" | "on" | "off">("auto", ["auto", "on", "off"]),
};
const EXPOSURE_REACH = 3;

export type Settings = { [K in keyof typeof SETTINGS]: (typeof SETTINGS)[K]["fallback"] };
export type SettingName = keyof Settings;

/** Which group of the rail holds each setting: a chapter that keeps a group in its figures has them not follow it. */
export const GROUPS: Record<SettingName, string> = {
    toneCurve: "display",
    headroom: "display",
    exposure: "display",
    quality: "quality",
    detail: "quality",
    catalog: "stars",
    milkyWay: "stars",
    marks: "annotations",
    groundGrid: "annotations",
    labels: "annotations",
};

export const PREFIX = "sternwarte:";
const NAMES = Object.keys(SETTINGS) as SettingName[];

function valid<K extends SettingName>(name: K, value: unknown): value is Settings[K] {
    const { fallback, values } = SETTINGS[name];
    if (typeof value !== typeof fallback) return false;
    if (values) return (values as readonly unknown[]).includes(value);
    return name !== "exposure" || Math.abs(value as number) <= EXPOSURE_REACH;
}

function stored<K extends SettingName>(name: K): Settings[K] {
    const { fallback, legacy } = SETTINGS[name];
    try {
        const text = localStorage.getItem(PREFIX + name);
        if (text !== null) {
            const value = JSON.parse(text);
            if (valid(name, value)) return value;
        } else if (legacy) {
            const text = localStorage.getItem(legacy);
            const value = typeof fallback === "number" ? Number(text) : text;
            localStorage.removeItem(legacy);
            if (valid(name, value)) {
                localStorage.setItem(PREFIX + name, JSON.stringify(value));
                return value;
            }
        }
    } catch {}
    return fallback as Settings[K];
}

/** The settings as they are now; set them with `setSetting`. */
export const settings = Object.fromEntries(NAMES.map((name) => [name, stored(name)])) as Settings;

const events = new EventTarget();
const notify = (name: SettingName) => events.dispatchEvent(new Event(name));

/** Sets a setting for every page, kept for the next visit; listeners hear of it only if it changed. */
export function setSetting<K extends SettingName>(name: K, value: Settings[K]) {
    if (!valid(name, value) || settings[name] === value) return;
    (settings as Record<SettingName, unknown>)[name] = value;
    try {
        if (value === SETTINGS[name].fallback) localStorage.removeItem(PREFIX + name);
        else localStorage.setItem(PREFIX + name, JSON.stringify(value));
    } catch {}
    notify(name);
}

/** Calls `listener` whenever one of `names` changes; returns what stops it. */
export function onSetting(names: SettingName | readonly SettingName[], listener: (current: Settings) => void) {
    const handler = () => listener(settings);
    const list = typeof names === "string" ? [names] : names;
    for (const name of list) events.addEventListener(name, handler);
    return () => {
        for (const name of list) events.removeEventListener(name, handler);
    };
}

// Set in another tab: this one follows.
window.addEventListener("storage", (event) => {
    const name = event.key?.startsWith(PREFIX) ? (event.key.slice(PREFIX.length) as SettingName) : null;
    if (!name || !(name in SETTINGS)) return;
    const value = stored(name);
    if (settings[name] === value) return;
    (settings as Record<SettingName, unknown>)[name] = value;
    notify(name);
});

/** Whether this page's chapter keeps the group of `name` in its figures (see the `LOCAL` map in Rail.astro). */
export const kept = (name: SettingName) =>
    (document.querySelector<HTMLElement>(".rail")?.dataset.local ?? "").split(" ").includes(GROUPS[name]);

/** The exposure compensation a metered figure adds, in stops: none where the chapter keeps the display to its figures. */
export const exposureCompensation = () => (kept("exposure") ? 0 : settings.exposure);

/**
 * A figure's control that follows a setting until the reader changes it there: then a local override, marked by
 * `data-override` (a dot, see figure.css), until it shows what the setting asks again or the setting changes. `want`
 * is what the setting asks of this control, `read` what it shows, `write` sets it, as a click on it would. Nothing
 * follows where the chapter keeps the setting's group in its figures.
 */
export function follow<T>(
    control: HTMLElement,
    name: SettingName,
    want: () => T,
    read: () => T,
    write: (value: T) => void,
) {
    if (kept(name)) return;
    const mark = () => control.toggleAttribute("data-override", read() !== want());
    // After every listener of a click or a key, the figure's own too, has had it.
    for (const type of ["click", "keydown"]) control.addEventListener(type, () => setTimeout(mark));
    const apply = () => {
        if (read() !== want()) write(want());
        control.removeAttribute("data-override");
    };
    onSetting(name, apply);
    apply();
}

/**
 * A figure's switch, a button whose `aria-pressed` its own click handler flips, following `name`: `on` says what the
 * setting asks of it, null for "as the figure starts". Its first state is taken from the markup, and the setting is
 * applied once the page's scripts have wired the switch, which a click then flips.
 */
export function followSwitch(
    button: HTMLElement,
    name: SettingName,
    on: (value: Settings[SettingName]) => boolean | null,
) {
    const initial = button.getAttribute("aria-pressed") === "true";
    const read = () => button.getAttribute("aria-pressed") === "true";
    const want = () => on(settings[name]) ?? initial;
    // Clicked until it shows what is asked, a few times while its figure's script may still be wiring it.
    const write = (value: boolean, tries = 20) => {
        if (read() === value || tries === 0) return;
        button.click();
        if (read() !== value) setTimeout(() => write(value, tries - 1), 250);
    };
    const start = () => follow(button, name, want, read, write);
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
}
