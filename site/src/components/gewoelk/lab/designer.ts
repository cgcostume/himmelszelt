import { julianDayFromDate } from "@himmelszelt/sternzeit";
import { find } from "../../dom";
import { paintRange } from "../../range";
import { onChange, state } from "../../sternzeit/state";
import { momentOnClock } from "../../sternzeit/timeofday";
import { DAY_MS, instantOf } from "../../sternzeit/zone";
import { type Design, placeOf, presetOf } from "./kinds";
import { type Lab, ORBIT_HEIGHT_KM, type Orbit } from "./lab";
import { deleteKind, ownKinds, ownList, saveKind } from "./store";

/**
 * What a cloud designer has over the whole-sky figure it is drawn by: a patch of its cloud alone, seen from a camera
 * that orbits it, a time of day and a clock of its own, which never set the page's, and the reader's own kinds beside
 * the library's.
 */

const DEG = Math.PI / 180;
const MINUTE_MS = 60_000;

/**
 * The patch a designer shows: its radius over the ground in km, and for a front how far along its bearing the patch's
 * middle lies from where the front is placed from, so the leading edge and most of the shield fall inside it.
 */
export const PATCH: Record<Design, { radiusKm: number; aheadKm: number }> = {
    low: { radiusKm: 8, aheadKm: 0 },
    towers: { radiusKm: 40, aheadKm: 0 },
    front: { radiusKm: 115, aheadKm: 60 },
    middle: { radiusKm: 8, aheadKm: 0 },
    high: { radiusKm: 6, aheadKm: 0 },
};

/** The camera a designer starts with: from the south-west, over the patch itself, 35° up or, for a front, whose wall would lie flat from there, 20°. */
export function designerOrbit(design: Design): Orbit {
    const { radiusKm } = PATCH[design];
    return {
        center: { east: 0, north: 0 },
        heightKm: 0,
        liftKm: 0,
        azimuth: 215 * DEG,
        elevation: (design === "front" ? 20 : 35) * DEG,
        distanceKm: 1.1 * radiusKm,
        reachKm: [0.2 * radiusKm, 8 * radiusKm],
    };
}

/**
 * The height a designer's camera looks at, on the figure's slider: `sync` shows where it looks, after a drag with shift
 * held or a change of the cloud's own height, and the slider sets it.
 */
export function designerHeight(root: HTMLElement, orbit: Orbit, request: () => void) {
    const slider = find<HTMLInputElement>('[data-field="lookAt"]', root);
    const output = find('[data-field="lookAtValue"]', root);
    slider.addEventListener("input", () => {
        orbit.liftKm = Number(slider.value) - orbit.heightKm;
        request();
    });
    return {
        sync() {
            const km = Math.min(Math.max(orbit.heightKm + orbit.liftKm, ORBIT_HEIGHT_KM[0]), ORBIT_HEIGHT_KM[1]);
            orbit.liftKm = km - orbit.heightKm;
            if (Number(slider.value).toFixed(1) !== km.toFixed(1)) slider.value = km.toFixed(1);
            paintRange(slider);
            output.textContent = `${km.toFixed(1)} km`;
        },
    };
}

/**
 * Which of a designer's two pictures is the large one, the rendering or the model's drawing: the other lies small in
 * its corner, and a click on it changes them over.
 */
export function designerSwap(root: HTMLElement) {
    const stage = find('[data-field="stage"]', root);
    const swap = find('[data-field="swap"]', root);
    const show = (main: "view" | "model") => {
        stage.dataset.main = main;
        const other = main === "view" ? "model" : "rendering";
        swap.title = `Show the ${other} large`;
        swap.setAttribute("aria-label", swap.title);
    };
    swap.addEventListener("click", () => show(stage.dataset.main === "view" ? "model" : "view"));
    show("view");
}

/**
 * A designer's time: the page's date and place, with a time of day of its own on the figure's slider, which starts at
 * the page's moment, follows it when it changes and never sets it. The lab's clock, while it runs, carries the time of
 * day along, unless the figure's lock holds it. `speed` is how fast the chosen switch lets that clock run, and `jd`
 * the moment at `clock` seconds on it.
 */
export function designerTime(root: HTMLElement, request: () => void) {
    const slider = find<HTMLInputElement>('[data-field="daytime"]', root);
    const output = find('[data-field="daytimeValue"]', root);
    const play = find('[data-field="animate"]', root);
    const speeds = [...root.querySelectorAll<HTMLElement>("[data-speed]")];
    const lock = find('[data-field="timeLock"]', root);
    const held = () => lock.getAttribute("aria-pressed") === "true";
    // The time of day, in ms, the figure had when its clock read `mark` seconds.
    let from = momentOnClock().timeOfDay;
    let mark = 0;
    let clock = 0;
    let pageJd = state.jd;

    slider.addEventListener("input", () => {
        from = Number(slider.value) * MINUTE_MS;
        mark = clock;
        request();
    });
    onChange(() => {
        if (state.jd === pageJd) return;
        pageJd = state.jd;
        from = momentOnClock().timeOfDay;
        mark = clock;
    });
    lock.addEventListener("click", () => {
        lock.setAttribute("aria-pressed", String(!held()));
        request();
    });
    play.addEventListener("click", () => {
        const on = play.getAttribute("aria-pressed") !== "true";
        play.setAttribute("aria-pressed", String(on));
        play.setAttribute("aria-label", on ? "Pause" : "Play");
        request();
    });
    for (const button of speeds) {
        button.addEventListener("click", () => {
            for (const other of speeds) other.setAttribute("aria-pressed", String(other === button));
            request();
        });
    }

    return {
        speed: () =>
            Number(speeds.find((button) => button.getAttribute("aria-pressed") === "true")?.dataset.speed) || 1,
        jd(seconds: number) {
            // Held, the time of day stays while the clock runs on: released, it goes on from where it stood.
            if (held()) mark += seconds - clock;
            clock = seconds;
            const timeOfDay = (((from + (clock - mark) * 1000) % DAY_MS) + DAY_MS) % DAY_MS;
            const minutes = Math.floor(timeOfDay / MINUTE_MS);
            slider.value = String(minutes);
            paintRange(slider);
            output.textContent = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
            return julianDayFromDate(new Date(instantOf(momentOnClock().day * DAY_MS + timeOfDay)));
        },
    };
}

/**
 * The reader's own kinds for the designer of `design` in `root`'s `[data-field="own"]`: saved from `numbers`, the
 * designed place's as they stand, and loaded into the sliders as the library's kinds are.
 */
export function designerKinds(root: HTMLElement, design: Design, lab: Lab, numbers: () => object) {
    const holder = root.querySelector<HTMLElement>('[data-field="own"]');
    if (!holder) return;
    const place = placeOf(design);
    const kinds = () => root.querySelectorAll<HTMLInputElement>(`input[name="${root.id}-preset"]`);
    const list = ownList(holder, {
        what: "the sliders as they stand",
        names: () => ownKinds(design).map(({ name }) => name),
        load(name) {
            const kind = ownKinds(design).find((own) => own.name === name);
            if (!kind) return;
            for (const input of kinds()) input.checked = false;
            lab.apply("preset", presetOf(place, kind.numbers));
        },
        save(name) {
            const rounded = Object.entries(numbers()).map(([key, value]) => [
                key,
                typeof value === "number" ? Number(value.toFixed(3)) : value,
            ]);
            return saveKind(design, { name, numbers: Object.fromEntries(rounded) });
        },
        remove: (name) => deleteKind(design, name),
    });
    for (const input of kinds()) input.addEventListener("change", list.clear);
}
