/**
 * Keeps every slider's --range-fill, how far along its value is, which the rail left of the thumb is drawn to (see
 * global.css). Input events update it by themselves; a script that sets a value calls `paintRange` after.
 */
export function paintRange(input) {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    input.style.setProperty("--range-fill", String(max > min ? (Number(input.value) - min) / (max - min) : 0));
}

document.addEventListener("input", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "range") paintRange(event.target);
});
for (const input of document.querySelectorAll('input[type="range"]')) paintRange(input);

// The wheel steps every slider, over the slider itself and over the label around it: up for more. A step moves it as
// dragging would, an input event at once and a change event once the wheel rests, so work done on release, such as
// recomputing the tables, runs once rather than per notch. A slider that handles the wheel itself prevents the default,
// and is left alone here.
const WHEEL_REST_MS = 300;
const resting = new WeakMap();

function sliderFor(target) {
    if (!(target instanceof Element)) return null;
    const input =
        target.closest('input[type="range"]') ?? target.closest("label")?.querySelector('input[type="range"]');
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
