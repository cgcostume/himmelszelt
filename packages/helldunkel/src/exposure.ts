/**
 * Exposure in EV100, the photographic convention cameras, Unreal and Frostbite share (Lagarde & de Rousiers 2014):
 * with light in cd/m², a scene exposed at the same EV100 looks the same in any of them.
 */

/** The multiplier an EV100 exposes luminance in cd/m² with: 1 / (1.2 · 2^EV100), the luminance that just saturates. */
export function exposureFromEV100(ev100: number): number {
    return 1 / (1.2 * 2 ** ev100);
}

/**
 * The EV100 a light meter reads for an average luminance in cd/m²: log2(L · S / K), with ISO S = 100 and the meter's
 * calibration K = 12.5. Exposed so, the average lands at about a tenth of saturation.
 */
export function ev100FromLuminance(averageLuminance: number): number {
    return Math.log2((averageLuminance * 100) / 12.5);
}

/**
 * The stops a dim scene's exposure is lowered by, so it looks as dim as the eye finds it, rather than metered up to the
 * brightness of day: Krawczyk et al.'s key of a scene's average luminance in cd/m², 1.03 - 2 / (2 + log10(L + 1)), over
 * middle gray. Zero from about 1.25 cd/m² up, the end of the mesopic range, falling to -2.6 at night. Subtract it from
 * a metered EV100.
 */
export function lowLightCompensation(averageLuminance: number): number {
    const key = 1.03 - 2 / (2 + Math.log10(Math.max(averageLuminance, 0) + 1));
    return Math.min(Math.log2(key / 0.18), 0);
}

/**
 * The stops an object far brighter than the scene around it is drawn darker, as the eye adapts to what it looks at
 * while a camera has one exposure for the frame: `strength` times how far the object's own EV100 lies above the
 * scene's, 1 for the eye settled on the object, 0 for the camera. Never brighter. For the Moon in a night sky.
 */
export function localAdaptation(sceneEV100: number, objectEV100: number, strength = 1): number {
    return -Math.min(Math.max(strength, 0), 1) * Math.max(objectEV100 - sceneEV100, 0);
}
