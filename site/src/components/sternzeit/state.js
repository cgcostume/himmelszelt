import { fromDate, julianDayUT, julianEphemerisDay } from "@himmelszelt/sternzeit";

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
    timeZone: "yours",
};

const changes = new EventTarget();

// The moment and place are kept in the browser, so the page opens where it was left, on any chapter. Only a
// convenience: without storage, e.g. in a private window, it opens at the defaults.
const STORAGE_KEY = "sternwarte:momentAndPlace";
const STORED = ["jd", "latitude", "longitude", "heightM", "live", "timeZone"];
let saveTimer = null;

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
            if (valid) state[key] = value;
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
export function update(patch, source = null) {
    Object.assign(state, patch);
    placeOnEarth();
    save();
    changes.dispatchEvent(new CustomEvent("change", { detail: source }));
}

export function onChange(listener) {
    changes.addEventListener("change", (event) => listener(event.detail));
}

/** Seconds, the finest step any control offers; "now" and stepping snap to it. */
const JD_MIN_STEP = 1 / 86_400;

export function julianDayNow() {
    const jd = julianDayUT(fromDate(new Date()));
    return Number((Math.round(jd / JD_MIN_STEP) * JD_MIN_STEP).toFixed(7));
}

state.jd = julianDayNow();
restore();
// Live goes on from now, not from when the page was left.
if (state.live) state.jd = julianDayNow();

/** The page's moments are UT; the orbits take ephemeris time, a minute or so ahead today (see deltaT). */
export const ephemerisDay = (jd) => julianEphemerisDay(jd);
