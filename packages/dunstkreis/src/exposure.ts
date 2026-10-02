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
 * altitude in degrees above the observer's horizon, which sinks below the horizontal as the observer rises. A pair tells the rising sun (east of the meridian, before noon) from the setting one.
 */
export interface AutoExposureKey {
    sunAltitude: number;
    compensation: number | { rising: number; setting: number };
}

/**
 * Night darker, the blue hour lifted a little so its blue shows, the minutes around sunrise and sunset darker, the
 * sunset a little brighter than the sunrise, the golden hour a touch brighter, and noon as metered.
 */
export const DEFAULT_AUTO_EXPOSURE_KEYS: readonly AutoExposureKey[] = [
    { sunAltitude: -18, compensation: -2 },
    { sunAltitude: -8, compensation: -1.5 },
    { sunAltitude: -5, compensation: -0.8 },
    { sunAltitude: -2, compensation: -0.9 },
    { sunAltitude: -1, compensation: -0.7 },
    { sunAltitude: 0, compensation: { rising: 0, setting: 0.2 } },
    { sunAltitude: 6, compensation: { rising: 0.2, setting: 0.3 } },
    { sunAltitude: 60, compensation: 0 },
];

/** Monotone cubic through [x, y] points (Fritsch & Carlson 1980): smooth, never overshooting one, flat at both ends. */
function monotoneCubic(points: readonly (readonly [number, number])[], x: number): number {
    const n = points.length;
    const first = points[0];
    const last = points[n - 1];
    if (!first || !last) return 0;
    if (x <= first[0]) return first[1];
    if (x >= last[0]) return last[1];
    const at = (i: number) => points[i] as readonly [number, number];
    const slope = (i: number) => (at(i + 1)[1] - at(i)[1]) / (at(i + 1)[0] - at(i)[0]);
    const tangent = (i: number) => {
        if (i === 0 || i === n - 1) return 0;
        const [s0, s1] = [slope(i - 1), slope(i)];
        return s0 * s1 > 0 ? (2 * s0 * s1) / (s0 + s1) : 0;
    };
    const i = points.findIndex(([px]) => px > x) - 1;
    const [[x0, y0], [x1, y1]] = [at(i), at(i + 1)];
    const h = x1 - x0;
    const t = (x - x0) / h;
    const [t2, t3] = [t * t, t * t * t];
    return (
        (2 * t3 - 3 * t2 + 1) * y0 +
        (t3 - 2 * t2 + t) * h * tangent(i) +
        (-2 * t3 + 3 * t2) * y1 +
        (t3 - t2) * h * tangent(i + 1)
    );
}

/**
 * The compensation the keys give for a sun direction (ENU, x east) and the observer's horizon dip in degrees, 0 on the
 * ground: a smooth curve through the keys, held beyond the first and the last, 0 without keys. Morning and evening blend
 * across the meridian, within 30° of azimuth on either side, so noon and midnight do not jump.
 */
export function autoExposureCompensation(
    keys: readonly AutoExposureKey[],
    sunDirection: readonly [number, number, number],
    horizonDip = 0,
): number {
    const [x, y, z] = sunDirection;
    const horizontal = Math.hypot(x, y);
    const altitude = (Math.atan2(z, horizontal) * 180) / Math.PI + horizonDip;
    const sorted = [...keys].sort((a, b) => a.sunAltitude - b.sunAltitude);
    const curve = (phase: "rising" | "setting") =>
        monotoneCubic(
            sorted.map(({ sunAltitude, compensation: c }) => [sunAltitude, typeof c === "number" ? c : c[phase]]),
            altitude,
        );
    const e = Math.min(Math.max((horizontal > 0 ? x / horizontal : 0) / 0.5 + 0.5, 0), 1);
    const rising = e * e * (3 - 2 * e);
    return rising * curve("rising") + (1 - rising) * curve("setting");
}
