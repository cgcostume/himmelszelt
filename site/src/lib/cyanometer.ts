/**
 * Saussure's cyanometer, the site's accent: 53 steps of Prussian blue from white (0) to black (52), modeled in OKLCH as
 * one hue with the lightness falling evenly from 1 to 0, so the steps also look even. The chroma is capped, and tapers
 * towards white and black as sRGB does at this hue.
 */
export const CYANOMETER_STEPS = 53;
export const STORAGE_KEY = "himmelszelt-cyanometer";
export const HUE = 245;
export const CHROMA = 0.11;

/**
 * From this step on the page turns light: the accent contrasts more against the light background than the dark one,
 * by WCAG's ratio, 4.5 against 4.2 here. The accent sits in links and bold text, so it picks the theme.
 */
export const LIGHT_FROM_STEP = 23;

/** The step a reader starts from, by the theme their system prefers: 7:1 against either background. */
export const DEFAULT_STEPS = { dark: 16, light: 30 } as const;

export type Theme = keyof typeof DEFAULT_STEPS;

const lightness = (step: number) => 1 - step / (CYANOMETER_STEPS - 1);

// Within sRGB at this hue, where the most chroma is about a quarter of the lightness, and half of what is left to white.
const chroma = (step: number) => Math.min(CHROMA, 0.21 * lightness(step), 0.44 * (1 - lightness(step)));

export const stepColor = (step: number) => `oklch(${lightness(step).toFixed(3)} ${chroma(step).toFixed(3)} ${HUE})`;

export const themeOf = (step: number): Theme => (step >= LIGHT_FROM_STEP ? "light" : "dark");

const themeKey = (theme: Theme) => `${STORAGE_KEY}-${theme}`;

/** The step last chosen on a theme's page, or its default: where the theme button goes. */
export function stepFor(theme: Theme): number {
    try {
        const stored = localStorage.getItem(themeKey(theme));
        const step = Number(stored);
        if (stored !== null && themeOf(step) === theme && Number.isInteger(step) && step < CYANOMETER_STEPS)
            return step;
    } catch {}
    return DEFAULT_STEPS[theme];
}

/** Keeps a step as the reader's, and as the last one on its theme's page; the default needs no keeping. */
export function storeStep(step: number) {
    try {
        if (step === defaultStep()) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, String(step));
        localStorage.setItem(themeKey(themeOf(step)), String(step));
    } catch {}
}

export const defaultStep = () => DEFAULT_STEPS[matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"];

/** The step this browser chose, or the default; storage may be unavailable, which leaves the default. */
export function storedStep(): number {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        const step = Number(stored);
        if (stored !== null && Number.isInteger(step) && step >= 0 && step < CYANOMETER_STEPS) return step;
    } catch {}
    return defaultStep();
}

/** Sets the page's accent to a step, which every color derived from --cyanometer follows, and the theme with it. */
export function applyStep(step: number) {
    document.documentElement.style.setProperty("--cyanometer", stepColor(step));
    document.documentElement.dataset.theme = themeOf(step);
}
