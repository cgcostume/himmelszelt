import tzLookup from "@photostructure/tz-lookup";
import { state } from "./state.js";

/** The viewer's own time zone, as the browser has it. */
export const yourZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

let cached = { latitude: Number.NaN, longitude: Number.NaN, zone: "UTC" };

/** The civil time zone at the page's place, daylight saving time included, from the zone borders tz-lookup ships. */
export function localZone() {
    const { latitude, longitude } = state;
    if (latitude !== cached.latitude || longitude !== cached.longitude) {
        let zone = "UTC";
        try {
            zone = tzLookup(latitude, longitude);
        } catch {}
        cached = { latitude, longitude, zone };
    }
    return cached.zone;
}

const HOUR_MS = 3_600_000;

const WALL_CLOCK = {
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
};

// What a zone's clock reads at that instant, put back together as if it were UT.
function zoneOffsetMs(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", { ...WALL_CLOCK, timeZone }).formatToParts(date);
    const part = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
    const wall = Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second);
    return wall - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * How far the page's clock runs ahead of UT at `date`, in milliseconds: the viewer's zone, the place's, or the
 * place's local mean time, a twenty-fourth of a day per 15° of longitude, to the millisecond rather than to the
 * minute Intl would round an offset to.
 */
export function clockOffsetMs(date) {
    if (state.timeZone === "mean") return Math.round((state.longitude / 15) * HOUR_MS);
    return zoneOffsetMs(date, state.timeZone === "local" ? localZone() : yourZone);
}

// Hours always, minutes and seconds only when there are any: +2, +5:30, +9:18:46.
function signed(ms) {
    const seconds = Math.round(Math.abs(ms) / 1000);
    const fields = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
    while (fields.length > 1 && fields.at(-1) === 0) fields.pop();
    const [hours, ...rest] = fields;
    return `${ms < 0 ? "\u2212" : "+"}${[hours, ...rest.map((n) => String(n).padStart(2, "0"))].join(":")}`;
}

/** The page's clock: its offset from UT, and `date` formatted on it with the given Intl options. */
export function clock(date, options) {
    const offset = clockOffsetMs(date);
    const text = new Date(date.getTime() + offset).toLocaleString("en-GB", { ...options, timeZone: "UTC" });
    return { offset: `UTC${signed(offset)}`, text };
}
