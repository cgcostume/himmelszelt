/**
 * Every slider is its native input, styled in CSS alone (global.css): a slim bar filled up to the value, notched at its
 * scale's marks, and a cursor that stands out of it with a gap either side. A slider may be held between limits inside
 * its scale (`data-allowed-min` and `data-allowed-max` on the input, or `setAllowed`): its value never leaves them, and
 * outside them the scale goes on as a dotted leader. Here only CSS variables are set, the shares of the value and the
 * limits and the notches, nothing is measured. Input events set them by themselves; a script that sets a value calls
 * `paintRange` after.
 */
export function paintRange(input: HTMLInputElement) {
    if (!known.has(input)) attach(input);
    const [min, max] = ends(input);
    const along = (value: number) => (max > min ? String(Math.round(((value - min) / (max - min)) * 1e5) / 1e5) : "0");
    const [lo, hi] = allowed(input);
    const key = `${along(Number(input.value))} ${along(lo)} ${along(hi)}`;
    if (painted.get(input) === key) return;
    painted.set(input, key);
    const [v, l, h] = key.split(" ");
    input.style.setProperty("--range-v", v);
    input.style.setProperty("--range-lo", l);
    input.style.setProperty("--range-hi", h);
}

/** Styles a slider from now on: done for every slider on the page, and for a later one on paintRange. */
export const drawRange = paintRange;

const known = new WeakSet<HTMLInputElement>();
const painted = new WeakMap<HTMLInputElement, string>();
const ends = (input: HTMLInputElement) => [Number(input.min || 0), Number(input.max || 100)];

/** The limits a slider's value is held between, as numbers of its scale; either one undefined for none. */
function allowed(input: HTMLInputElement): [number, number] {
    const [min, max] = ends(input);
    const lo = input.dataset.allowedMin === undefined ? min : Number(input.dataset.allowedMin);
    const hi = input.dataset.allowedMax === undefined ? max : Number(input.dataset.allowedMax);
    return [Math.max(min, lo), Math.min(max, hi)];
}

/** Holds a slider between `lo` and `hi` (undefined: its own end), pulling its value in, with an input event if moved. */
export function setAllowed(input: HTMLInputElement, lo?: number, hi?: number) {
    for (const [key, value] of [
        ["allowedMin", lo],
        ["allowedMax", hi],
    ] as const)
        if (value === undefined) delete input.dataset[key];
        else input.dataset[key] = String(value);
    if (clamp(input)) input.dispatchEvent(new Event("input", { bubbles: true }));
    paintRange(input);
}

// The value back within the limits; true if it had left them. Pushed against one, the cursor flashes.
const stops = new WeakMap<HTMLInputElement, ReturnType<typeof setTimeout>>();
function clamp(input: HTMLInputElement) {
    if (input.dataset.allowedMin === undefined && input.dataset.allowedMax === undefined) return false;
    const [lo, hi] = allowed(input);
    const value = Number(input.value);
    if (value >= lo && value <= hi) return false;
    input.value = String(value < lo ? lo : hi);
    input.dataset.stop = value < lo ? "lo" : "hi";
    clearTimeout(stops.get(input));
    stops.set(
        input,
        setTimeout(() => delete input.dataset.stop, 600),
    );
    return true;
}

// The scale's marks, notched into the bar as 2 px gaps of ground, all but its ends: one gradient a slider, built anew
// only when its marks change.
const MARKS =
    ":scope > .figure-slider-scale > .figure-slider-mark:not(.slider-metered), :scope > .sky-height-scale > *";
const SCALE = ".figure-slider-scale, .sky-height-scale";
function notch(input: HTMLInputElement) {
    const shares = [...(input.parentElement?.querySelectorAll<HTMLElement>(MARKS) ?? [])]
        .map(
            (mark) =>
                Number.parseFloat(mark.style.getPropertyValue("--at")) || Number.parseFloat(mark.style.left) / 100,
        )
        .filter((share) => share > 0 && share < 1)
        .sort((a, b) => a - b);
    if (!shares.length) return input.style.removeProperty("--range-notches");
    const stops = shares.map((share) => {
        const at = `3px + ${share} * (100% - 6px)`;
        return `transparent 0 calc(${at} - 1px), var(--range-gap) 0 calc(${at} + 1px)`;
    });
    input.style.setProperty("--range-notches", `linear-gradient(90deg, ${stops.join(", ")}, transparent 0)`);
}
const marksChanged = new MutationObserver((records) => {
    const inputs = new Set<HTMLInputElement>();
    for (const { target } of records) {
        const scale = (target instanceof Element ? target : target.parentElement)?.closest(SCALE);
        const input = scale?.parentElement?.querySelector<HTMLInputElement>(':scope > input[type="range"]');
        if (input) inputs.add(input);
    }
    for (const input of inputs) notch(input);
});

function attach(input: HTMLInputElement) {
    known.add(input);
    notch(input);
    for (const scale of input.parentElement?.querySelectorAll(`:scope > :is(${SCALE})`) ?? [])
        marksChanged.observe(scale, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["style", "class"],
        });
}

// Held between its limits before any figure's own listener reads the value: on the window, as it is captured.
window.addEventListener(
    "input",
    (event) => {
        if (event.target instanceof HTMLInputElement && event.target.type === "range") clamp(event.target);
    },
    true,
);
document.addEventListener("input", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "range") paintRange(event.target);
});
for (const input of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) paintRange(input);
// And every slider added later, by a figure that builds its controls or copies a panel.
new MutationObserver((records) => {
    for (const record of records)
        for (const node of record.addedNodes)
            if (node instanceof HTMLInputElement && node.type === "range") paintRange(node);
            else if (node instanceof Element && node.firstElementChild)
                for (const input of node.querySelectorAll<HTMLInputElement>('input[type="range"]')) paintRange(input);
}).observe(document.body, { childList: true, subtree: true });

// The wheel steps every slider, over the slider itself and over the label around it: up for more. A step moves it as
// dragging would, an input event at once and a change event once the wheel rests, so work done on release, such as
// recomputing the tables, runs once rather than per notch. A slider that handles the wheel itself prevents the default,
// and is left alone here.
const WHEEL_REST_MS = 300;
const resting = new WeakMap<HTMLInputElement, ReturnType<typeof setTimeout>>();

function sliderFor(target: EventTarget | null) {
    if (!(target instanceof Element)) return null;
    const input =
        target.closest<HTMLInputElement>('input[type="range"]') ??
        target.closest("label")?.querySelector<HTMLInputElement>('input[type="range"]');
    return input && !input.disabled ? input : null;
}

document.addEventListener(
    "wheel",
    (event) => {
        const input = sliderFor(event.target);
        if (!input || event.defaultPrevented || event.deltaY === 0) return;
        event.preventDefault();
        const step = Number(input.dataset.wheelStep || input.step) || 1;
        const [min, max] = allowed(input);
        const value = Math.min(Math.max(Number(input.value) - Math.sign(event.deltaY) * step, min), max);
        if (value === Number(input.value)) return;
        input.value = String(value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        clearTimeout(resting.get(input));
        resting.set(
            input,
            setTimeout(() => input.dispatchEvent(new Event("change", { bubbles: true })), WHEEL_REST_MS),
        );
    },
    { passive: false },
);

// Which slider a pointer is dragging, for the marks that snap it (see snapMark).
let dragged: HTMLInputElement | null = null;
document.addEventListener(
    "pointerdown",
    (event) => {
        dragged = sliderFor(event.target);
    },
    true,
);
window.addEventListener("pointerup", () => {
    dragged = null;
});

/**
 * The mark among `marks` a slider's value is within `reach` of, the nearest, for the slider to land on: the light
 * meter's reading on an exposure, the powers of two on a size. Only while a pointer drags it, so that dragging further
 * lets go, and a key's or the wheel's small steps are never caught.
 */
export function snapMark(input: HTMLInputElement, marks: readonly number[], reach: number): number | null {
    if (dragged !== input) return null;
    const value = Number(input.value);
    let nearest: number | null = null;
    for (const mark of marks)
        if (Math.abs(mark - value) < reach && (nearest === null || Math.abs(mark - value) < Math.abs(nearest - value)))
            nearest = mark;
    return nearest;
}

// A slider in view for HINT_AFTER_MS without ever being touched pulses its thumb once, so a reader who has not noticed
// that the figure can be dragged gets a hint. Counted per slider, while at least half of it is on screen.
export const HINT_AFTER_MS = 12_000;
const hinted = new WeakSet<HTMLInputElement>();
const touch = (event: Event) => {
    const input = sliderFor(event.target);
    if (input) hinted.add(input);
};
for (const type of ["pointerdown", "focusin", "input"]) document.addEventListener(type, touch, true);
document.addEventListener("wheel", touch, { capture: true, passive: true });

const hintTimers = new Map<HTMLInputElement, { left: number; since: number; timer?: ReturnType<typeof setTimeout> }>();
const hintObserver = new IntersectionObserver(
    (entries) => {
        for (const entry of entries) {
            const input = entry.target as HTMLInputElement;
            const count = hintTimers.get(input) ?? { left: HINT_AFTER_MS, since: 0 };
            hintTimers.set(input, count);
            if (entry.isIntersecting) {
                count.since = performance.now();
                count.timer = setTimeout(() => {
                    hintObserver.unobserve(input);
                    if (hinted.has(input)) return;
                    hinted.add(input);
                    input.classList.add("slider-hint");
                    // Long enough for either animation; the class goes, so it never plays again.
                    setTimeout(() => input.classList.remove("slider-hint"), 3000);
                }, count.left);
            } else if (count.timer !== undefined) {
                clearTimeout(count.timer);
                count.timer = undefined;
                count.left -= performance.now() - count.since;
            }
        }
    },
    { threshold: 0.5 },
);
for (const input of document.querySelectorAll<HTMLInputElement>('figure input[type="range"]'))
    hintObserver.observe(input);
