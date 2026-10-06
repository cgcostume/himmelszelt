import { fromDate, fromJulianDay, julianDayUT, toDate } from "@himmelszelt/sternzeit";
import { julianDayNow, onChange, state, update } from "./state.js";
import { clock } from "./zone.js";

// Every set of controls on the page (see Controls.astro) is wired the same way: user input writes to the shared
// state, and every state change is written back to all of them, so they always show the one moment and place.
const roots = [...document.querySelectorAll(".moment")];
const LATLONG_DECIMALS = 7;

// jd is UT; shown in the viewer's own time zone or in the place's, as the clock toggle says.
const dateOf = (jd) => toDate(fromJulianDay(jd));
const julianDayOf = (date) => julianDayUT(fromDate(date));

// Days, weeks, months and years step in UT, so time flows on evenly: across daylight saving time the clock shows an
// hour more or less instead of the sky jumping. A month from 31 January is the last of February.
function stepCalendar(jd, unit, sign) {
    const date = dateOf(jd);
    if (unit === "day" || unit === "week") date.setUTCDate(date.getUTCDate() + sign * (unit === "week" ? 7 : 1));
    else {
        const day = date.getUTCDate();
        date.setUTCDate(1);
        date.setUTCMonth(date.getUTCMonth() + sign * (unit === "year" ? 12 : 1));
        date.setUTCDate(
            Math.min(day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()),
        );
    }
    return julianDayOf(date);
}

const formatClock = (options) => {
    const { offset, text } = clock(dateOf(state.jd), options);
    return `${text} ${offset}`;
};

// One-liner in every set's summary, so the current moment and place stay readable while it is folded.
function formatSummary() {
    const when = formatClock({ dateStyle: "medium", timeStyle: "medium" });
    const lat = `${Math.abs(state.latitude).toFixed(2)}° ${state.latitude >= 0 ? "N" : "S"}`;
    const lon = `${Math.abs(state.longitude).toFixed(2)}° ${state.longitude >= 0 ? "E" : "W"}`;
    return `${when}, ${lat} ${lon}, ${state.heightM}\u202fm${state.live ? ", live" : ""}`;
}

// The whole moment and place as JSON, under the names the library's own functions use, so it pastes straight into
// code. The instant is there twice: the Julian Day everything here is computed from, and an ISO timestamp in UT to
// read it by (a local time would not say which instant it was without naming the zone).
function momentAndPlaceJson() {
    const moment = {
        julianDay: state.jd,
        utc: `${dateOf(state.jd).toISOString().slice(0, 19)}Z`,
        latitude: state.latitude,
        longitude: state.longitude,
        heightM: state.heightM,
    };
    return `${JSON.stringify(moment, null, 4)}\n`;
}

// Snapping to an exact multiple of minStep (not just rounding the display) matters because the steps themselves are
// repeating decimals (1/86400, 1/3600, ...): a step landing a hair off a whole second would make the time jitter.
function roundToStep(value, minStep, decimals = Math.max(0, Math.ceil(-Math.log10(minStep)) + 2)) {
    return Number((Math.round(value / minStep) * minStep).toFixed(decimals));
}

const capDecimals = (value, decimals) => Number(value.toFixed(decimals));
// A step size is picked from a group of radio buttons (see Controls.astro), one per granularity.
const stepChoices = (steps) => [...steps.querySelectorAll('input[type="radio"]')];
const chosenStep = (steps) => steps.querySelector('input[type="radio"]:checked');
const minStepOf = (steps) => Math.min(...stepChoices(steps).map((choice) => Number(choice.value)));

// Arrow keys, wheel and the two buttons beside the input step by the chosen granularity, by hand rather than via
// input.step: the browser's stepUp()/stepDown() silently no-ops on values that aren't exact multiples of `step`,
// which ours never are.
function wireStepping(input, steps, commit, decimals) {
    input.step = "any";
    const minStep = minStepOf(steps);
    const applyStep = (sign) => {
        const value = Number(input.value) || 0;
        const choice = chosenStep(steps);
        const unit = choice?.dataset.calendar;
        const next = unit ? stepCalendar(value, unit, sign) : value + sign * Number(choice?.value ?? 0);
        input.value = roundToStep(next, minStep, decimals);
        commit();
    };
    for (const button of input.closest(".stepper").querySelectorAll("[data-step]")) {
        button.addEventListener("click", () => applyStep(Number(button.dataset.step)));
    }
    input.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        applyStep(event.key === "ArrowUp" ? 1 : -1);
    });
    input.addEventListener(
        "wheel",
        (event) => {
            if (document.activeElement !== input) return;
            event.preventDefault();
            applyStep(event.deltaY < 0 ? 1 : -1);
        },
        { passive: false },
    );
}

// The browser knows where, not how high: coords.altitude is null on anything but a GPS fix, and ellipsoidal where it
// is not. Open-Meteo's elevation endpoint answers with the Copernicus DEM (90 m grid) above sea level, no key needed;
// it is asked only when the location button is pressed, and a failure just leaves the height as it was.
async function lookupElevation(latitude, longitude) {
    try {
        const url = `https://api.open-meteo.com/v1/elevation?latitude=${latitude}&longitude=${longitude}`;
        const answer = await (await fetch(url)).json();
        const elevation = answer?.elevation?.[0];
        return typeof elevation === "number" ? Math.max(0, Math.round(elevation)) : null;
    } catch {
        return null;
    }
}

let liveIntervalId = null;
let animateIntervalId = null;
const ANIMATE_PER_SECOND = 30;

function stopAnimate() {
    clearInterval(animateIntervalId);
    animateIntervalId = null;
}

// Both drive the moment, so turning one on turns the other off.
function setLive(live, source) {
    clearInterval(liveIntervalId);
    liveIntervalId = live ? setInterval(() => update({ jd: julianDayNow() }), 1000) : null;
    if (live) stopAnimate();
    update({ live, ...(live ? { jd: julianDayNow(), animate: false } : {}) }, source);
}

// The same step the buttons take, taken over and over: whatever granularity is chosen becomes the speed.
function setAnimate(animate, source, steps) {
    stopAnimate();
    if (animate && state.live) setLive(false, source);
    const minStep = minStepOf(steps);
    const tick = () => {
        const choice = chosenStep(steps);
        const unit = choice?.dataset.calendar;
        const next = unit ? stepCalendar(state.jd, unit, 1) : state.jd + Number(choice?.value ?? 0);
        update({ jd: roundToStep(next, minStep) });
    };
    if (animate) animateIntervalId = setInterval(tick, 1000 / ANIMATE_PER_SECOND);
    update({ animate }, source);
}

for (const root of roots) {
    const field = (name) => root.querySelector(`[data-field="${name}"]`);
    const jd = field("jd");
    const latitude = field("latitude");
    const longitude = field("longitude");
    const height = field("height");

    const commitJd = () => {
        if (state.live) setLive(false, root);
        if (state.animate) setAnimate(false, root, field("jdStep"));
        update({ jd: Number(jd.value) }, root);
    };
    const commitLatLong = () => update({ latitude: Number(latitude.value), longitude: Number(longitude.value) }, root);

    wireStepping(jd, field("jdStep"), commitJd);
    // Both angles step by the same unit, from one group of buttons.
    wireStepping(latitude, field("latlongStep"), commitLatLong, LATLONG_DECIMALS);
    wireStepping(longitude, field("latlongStep"), commitLatLong, LATLONG_DECIMALS);
    // From eye level, give or take, up to the International Space Station's orbit: parallax and horizon dip hold at
    // any height, refraction fades out with the air.
    const commitHeight = () => {
        height.value = Math.min(Number(height.max), Math.max(Number(height.min), Number(height.value) || 0));
        update({ heightM: Number(height.value) }, root);
    };
    wireStepping(height, field("heightStep"), commitHeight, 0);
    jd.addEventListener("input", commitJd);
    latitude.addEventListener("input", commitLatLong);
    longitude.addEventListener("input", commitLatLong);
    height.addEventListener("change", commitHeight);

    field("copy").addEventListener("click", async (event) => {
        // It sits inside the summary line, where a click would otherwise fold the set open or shut.
        event.preventDefault();
        const status = field("location");
        try {
            await navigator.clipboard.writeText(momentAndPlaceJson());
            status.textContent = "copied as JSON";
        } catch {
            status.textContent = "copying failed, this browser did not allow it";
        }
    });
    // One button for both: while it is on the moment follows the clock, and switching it off leaves it at "now".
    // Only how the clock reads changes, never the instant, so the sky stays where it is.
    field("timeZone").addEventListener("change", (event) => update({ timeZone: event.target.value }, root));
    field("live").addEventListener("click", () => setLive(!state.live, root));
    field("animate").addEventListener("click", () => setAnimate(!state.animate, root, field("jdStep")));
    field("geolocate").addEventListener("click", () => {
        const status = field("location");
        if (!navigator.geolocation) {
            status.textContent = "geolocation not supported by this browser";
            return;
        }
        status.textContent = "requesting location...";
        navigator.geolocation.getCurrentPosition(
            async (position) => {
                status.textContent = "";
                const latitude = capDecimals(position.coords.latitude, LATLONG_DECIMALS);
                const longitude = capDecimals(position.coords.longitude, LATLONG_DECIMALS);
                update({ latitude, longitude });
                const elevation = await lookupElevation(latitude, longitude);
                if (elevation === null) status.textContent = "height lookup failed, set it by hand";
                else update({ heightM: Math.max(1, elevation) });
            },
            (err) => {
                status.textContent = `geolocation failed: ${err.message}`;
            },
            { timeout: 5000 },
        );
    });
}

// Writes the state into every set of controls, except into the input the change is being typed into, so its caret and
// partial input stay put.
function sync(source) {
    for (const root of roots) {
        const field = (name) => root.querySelector(`[data-field="${name}"]`);
        const set = (input, value) => {
            if (!(root === source && input === document.activeElement)) input.value = value;
        };
        set(field("jd"), state.jd);
        set(field("latitude"), state.latitude);
        set(field("longitude"), state.longitude);
        set(field("height"), state.heightM);
        field("live").setAttribute("aria-pressed", String(state.live));
        field("animate").setAttribute("aria-pressed", String(state.animate));
        // Nothing to set or step by hand while the clock or the animation is driving it.
        const driven = state.live || state.animate;
        field("jd").disabled = driven;
        for (const button of root.querySelectorAll('.stepper:has([data-field="jd"]) [data-step]')) {
            button.disabled = driven;
        }
        for (const choice of stepChoices(field("timeZone"))) choice.checked = choice.value === state.timeZone;
        field("summary").textContent = formatSummary();
    }
}

onChange(sync);
// A page restored in live mode keeps going live.
if (state.live && liveIntervalId === null) setLive(true, null);
// Anything else on the page may end live mode or the animation, e.g. the eclipse views jumping to an example moment.
onChange(() => {
    if (!state.live && liveIntervalId !== null) setLive(false, null);
    if (!state.animate && animateIntervalId !== null) stopAnimate();
});
sync(null);
