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
