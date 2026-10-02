/**
 * Saussure's cyanometer, the site's accent: 53 steps of Prussian blue from white (0) to black (52), modeled here as
 * one hue and saturation with the lightness falling evenly, so the site's default accent, hsl(207 62% 62%), is step 20.
 */
export const CYANOMETER_STEPS = 53;
export const DEFAULT_STEP = 20;
export const STORAGE_KEY = "himmelszelt-cyanometer";
export const HUE = 207;
export const SATURATION = 62;
export const LIGHTNESS_AT_ZERO = 98;
export const LIGHTNESS_PER_STEP = 1.8;

const lightness = (step: number) => LIGHTNESS_AT_ZERO - step * LIGHTNESS_PER_STEP;

export const stepColor = (step: number) => `hsl(${HUE} ${SATURATION}% ${lightness(step).toFixed(1)}%)`;

/** The step this browser chose, or the default; storage may be unavailable, which leaves the default. */
export function storedStep(): number {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        const step = Number(stored);
        if (stored !== null && Number.isInteger(step) && step >= 0 && step < CYANOMETER_STEPS) return step;
    } catch {}
    return DEFAULT_STEP;
}

/** Sets the page's accent to a step, which every color derived from --cyanometer follows. */
export function applyStep(step: number) {
    document.documentElement.style.setProperty("--cyanometer", stepColor(step));
}
