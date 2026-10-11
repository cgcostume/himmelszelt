import { julianDayFromDate, julianEphemerisDay } from "@himmelszelt/sternzeit";

/**
 * The one moment and place the whole page shows. Every set of controls writes here, and the tables and the scene
 * read from here, so any number of controls on the page stay in sync by construction.
 */
export const state = {
    jd: 0,
    latitude: 52.3920607,
    longitude: 13.0925765,
    heightM: 1,
    live: false,
    animate: false,
    timeZone: "yours" as TimeZoneChoice,
};

/** Whose clock the page reads: the viewer's, the place's civil zone, or the place's local mean time. */
export type TimeZoneChoice = "yours" | "local" | "mean";
export type State = typeof state;

const changes = new EventTarget();

// The moment and place are kept in the browser, so the page opens where it was left, on any chapter. Only a
// convenience: without storage, e.g. in a private window, it opens at the defaults.
const STORAGE_KEY = "sternwarte:momentAndPlace";
const STORED: (keyof State)[] = ["jd", "latitude", "longitude", "heightM", "live", "timeZone"];
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function save() {
    clearTimeout(saveTimer);
    // Live and animated moments change many times a second; the last one a moment later is enough.
    saveTimer = setTimeout(() => {
        try {
            localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify(Object.fromEntries(STORED.map((key) => [key, state[key]]))),
            );
        } catch {}
    }, 500);
}

function restore() {
    try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
        if (!stored || typeof stored !== "object") return;
        for (const key of STORED) {
            const value = stored[key];
            const valid =
                key === "live"
                    ? typeof value === "boolean"
                    : key === "timeZone"
                      ? value === "local"
                      : Number.isFinite(value);
            if (valid) Object.assign(state, { [key]: value });
        }
        state.heightM = Math.min(Math.max(state.heightM, 1), 408_000);
        placeOnEarth();
    } catch {}
}

// A place on Earth: latitude from pole to pole, longitude once around, whatever was typed or stepped past the ends.
function placeOnEarth() {
    state.latitude = Math.min(Math.max(state.latitude, -90), 90);
    state.longitude = ((((state.longitude + 180) % 360) + 360) % 360) - 180;
}

/** Applies `patch` and notifies every listener; `source` is the controls element the change came from, if any. */
export function update(patch: Partial<State>, source: Element | null = null) {
    Object.assign(state, patch);
    placeOnEarth();
    save();
    changes.dispatchEvent(new CustomEvent("change", { detail: source }));
}

export function onChange(listener: (source: Element | null) => void) {
    changes.addEventListener("change", (event) => listener((event as CustomEvent<Element | null>).detail));
}

/** Seconds, the finest step any control offers; "now" and stepping snap to it. */
const JD_MIN_STEP = 1 / 86_400;

export function julianDayNow() {
    const jd = julianDayFromDate(new Date());
    return Number((Math.round(jd / JD_MIN_STEP) * JD_MIN_STEP).toFixed(7));
}

// A moment and a place passed in a link: `jd` (a Julian Day, UT) or `date` (anything a JavaScript Date reads, such as
// 2026-08-12T18:29Z), and `lat`, `lon` and `h` (meters), each optional. Returns the patch, or null if there is none.
function fromSearch(search: string): Partial<State> | null {
    const params = new URLSearchParams(search);
    const patch: Partial<State> = {};
    const number = (key: string) => (params.has(key) ? Number(params.get(key)) : Number.NaN);
    const jd = params.has("date") ? julianDayFromDate(new Date(params.get("date") ?? "")) : number("jd");
    if (Number.isFinite(jd)) Object.assign(patch, { jd, live: false });
    for (const [key, field] of [
        ["lat", "latitude"],
        ["lon", "longitude"],
        ["h", "heightM"],
    ] as const) {
        if (Number.isFinite(number(key))) patch[field] = number(key);
    }
    if (patch.heightM !== undefined) patch.heightM = Math.min(Math.max(patch.heightM, 1), 408_000);
    return Object.keys(patch).length > 0 ? patch : null;
}

state.jd = julianDayNow();
restore();
// Live goes on from now, not from when the page was left.
if (state.live) state.jd = julianDayNow();
// A link's moment and place win over the stored ones, once: the address drops them again, so a reload keeps whatever
// was changed since.
const linked = fromSearch(location.search);
if (linked) {
    Object.assign(state, linked);
    placeOnEarth();
    save();
    history.replaceState(history.state, "", location.pathname + location.hash);
}
// A link on the page that only sets the moment and the place (the experiments in the captions) does so in place,
// without reloading, and scrolls to its figure.
document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href^='?']") : null;
    const patch =
        link && !event.ctrlKey && !event.metaKey && !event.shiftKey ? fromSearch(new URL(link.href).search) : null;
    if (!link || !patch) return;
    event.preventDefault();
    update(patch, link);
    const target = link.hash ? document.getElementById(decodeURIComponent(link.hash.slice(1))) : null;
    target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
});

/** The page's moments are UT; the orbits take ephemeris time, a minute or so ahead today (see deltaT). */
export const ephemerisDay = (jd: number) => julianEphemerisDay(jd);
