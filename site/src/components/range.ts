/**
 * Keeps every slider's --range-fill, how far along its value is, which the rail left of the thumb is drawn to (see
 * global.css). Input events update it by themselves; a script that sets a value calls `paintRange` after.
 */
export function paintRange(input: HTMLInputElement) {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    input.style.setProperty("--range-fill", String(max > min ? (Number(input.value) - min) / (max - min) : 0));
}

document.addEventListener("input", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "range") paintRange(event.target);
});
for (const input of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) paintRange(input);

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
        const step = Number(input.step) || 1;
        const [min, max] = [Number(input.min || 0), Number(input.max || 100)];
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
