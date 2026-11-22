import type { AutoExposureKey } from "@himmelszelt/dunstkreis";

/**
 * The site's ramp over the day, a photographer's: night darker, the blue hour lifted a little so its blue shows, the
 * minutes around sunrise and sunset darker, the sunset a little brighter than the sunrise, the golden hour a touch
 * brighter, and noon as metered. The sky figures' and the clouds' ramp, and Grading the day's "photo" preset.
 */
export const PHOTO_RAMP: readonly AutoExposureKey[] = [
    { sunAltitude: -18, compensation: -2 },
    { sunAltitude: -8, compensation: -1.5 },
    { sunAltitude: -5, compensation: -0.8 },
    { sunAltitude: -2, compensation: -0.9 },
    { sunAltitude: -1, compensation: -0.7 },
    { sunAltitude: 0, compensation: { rising: 0, setting: 0.2 } },
    { sunAltitude: 6, compensation: { rising: 0.2, setting: 0.3 } },
    { sunAltitude: 60, compensation: 0 },
];
