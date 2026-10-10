import * as precise from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { onDemand } from "../frame";
import { onChange, state } from "./state";
import { clock, DAY_MS, instantOf, wallDayOf } from "./zone";

// The golden hour example, run: the same minute steps and thresholds, on the page's day and clock.
const output = find('[data-field="sunTimes"]');
const MINUTE_MS = 60_000;

// When the Sun climbs past `altitude` and when it sinks past it again: in a northern summer, dusk can come after midnight,
// so the first crossing of a day is not always the rising one.
function crossings(start: number, end: number, altitude: number) {
    const above = (ms: number) =>
        precise.sun.horizontalPosition(precise.fromJulianDay(precise.julianDayFromDate(new Date(ms))), state).altitude >
        altitude;
    const found: { rising?: number; setting?: number; aboveAtStart: boolean } = { aboveAtStart: above(start) };
    let before = found.aboveAtStart;
    for (let ms = start + MINUTE_MS; ms <= end; ms += MINUTE_MS) {
        const now = above(ms);
        if (now !== before) found[now ? "rising" : "setting"] ??= ms;
        before = now;
    }
    return found;
}

let key = "";

function render() {
    const page = precise.dateFromJulianDay(state.jd).getTime();
    const day = wallDayOf(page);
    const [start, end] = [instantOf(day * DAY_MS), instantOf((day + 1) * DAY_MS)];
    const next = [day, state.latitude, state.longitude, state.heightM, state.timeZone].join();
    if (next === key) return;
    key = next;
    const time = (ms: number | undefined) =>
        ms === undefined ? "none" : clock(new Date(ms), { timeStyle: "short" }).text;
    const field = (name: string, ms: number | undefined) => `<span class="status-title">${name}</span> ${time(ms)}`;
    // A pair of crossings, or, near the poles, the Sun staying on one side of the threshold all day.
    const pair = (altitude: number, [risingName, settingName]: string[], [allAbove, allBelow]: string[]) => {
        const { rising, setting, aboveAtStart } = crossings(start, end, altitude);
        if (rising === undefined && setting === undefined) return aboveAtStart ? allAbove : allBelow;
        return `${field(risingName, rising)}, ${field(settingName, setting)}`;
    };
    const sun = pair(-0.833, ["sunrise", "sunset"], ["the Sun stays up all day", "the Sun stays down all day"]);
    const twilight = pair(-6, ["dawn", "dusk"], ["no civil night", "no civil twilight"]);
    output.innerHTML = `${sun}; ${twilight}`;
}

onChange(onDemand(render, output));
render();
