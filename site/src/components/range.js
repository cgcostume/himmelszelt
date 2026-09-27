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
