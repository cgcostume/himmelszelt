/**
 * Exposure in EV100, the photographic convention cameras, Unreal and Frostbite share (Lagarde & de Rousiers 2014):
 * with the sky in cd/m², a scene exposed at the same EV100 looks the same in any of them.
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
 * A point of the automatic exposure's ramp over the day: an exposure compensation in EV, +1 twice as bright, at a sun
 * altitude in degrees. With a `phase`, it applies only while the sun rises (east of the meridian, before noon) or sets
 * (west of it), so mornings and evenings can differ.
 */
export interface AutoExposureKey {
    sunAltitude: number;
    compensation: number;
    phase?: "rising" | "setting";
}

/**
 * Night and the blue hour darker, the last minutes before sunrise and after sunset still somewhat darker, the sunset a
 * little brighter than the sunrise, the golden hour a touch brighter, and noon as metered.
 */
export const DEFAULT_AUTO_EXPOSURE_KEYS: readonly AutoExposureKey[] = [
    { sunAltitude: -18, compensation: -2 },
    { sunAltitude: -6, compensation: -1.2 },
    { sunAltitude: -2, compensation: -0.7 },
    { sunAltitude: 0, compensation: 0, phase: "rising" },
    { sunAltitude: 0, compensation: 0.2, phase: "setting" },
    { sunAltitude: 6, compensation: 0.2, phase: "rising" },
    { sunAltitude: 6, compensation: 0.3, phase: "setting" },
    { sunAltitude: 60, compensation: 0 },
];

/**
 * The compensation the keys give for a sun direction (ENU, x east): linear between the keys of its phase and those
 * without one, held beyond the first and the last. 0 without keys.
 */
export function autoExposureCompensation(
    keys: readonly AutoExposureKey[],
    sunDirection: readonly [number, number, number],
): number {
    const [x, y, z] = sunDirection;
    const altitude = (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI;
    const phase = x > 0 ? "rising" : "setting";
    const points = keys.filter((key) => (key.phase ?? phase) === phase).sort((a, b) => a.sunAltitude - b.sunAltitude);
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) return 0;
    if (altitude <= first.sunAltitude) return first.compensation;
    if (altitude >= last.sunAltitude) return last.compensation;
    const i = points.findIndex((key) => key.sunAltitude > altitude);
    const [a, b] = [points[i - 1] as AutoExposureKey, points[i] as AutoExposureKey];
    return (
        a.compensation +
        ((altitude - a.sunAltitude) / (b.sunAltitude - a.sunAltitude)) * (b.compensation - a.compensation)
    );
}
