import { MOON_WHITE, NO_WHITE_BALANCE, SUN_WHITE, type WhiteBalance, whiteBalance } from "@himmelszelt/helldunkel";

/** Which white a sky figure is balanced on: "auto" follows the Sun's altitude, `skyWhite`; "none" is no balance. */
export type WhiteChoice = "auto" | "moon" | "sun" | "none";

const DEG = Math.PI / 180;
/** The Sun's altitudes in degrees between which "auto" goes from the Moon's white to the Sun's: sunset, and the end of
 *  nautical twilight, where a bright Moon's sky outshines the twilight's. */
export const AUTO_WHITE_ALTITUDES = { moon: -12, sun: 0 } as const;

/** How far "auto" is towards the Sun's white, from 0 to 1, at a sun altitude in degrees, smoothly between the bounds. */
export function sunWhiteShare(sunAltitude: number): number {
    const { moon, sun } = AUTO_WHITE_ALTITUDES;
    const t = Math.min(Math.max((sunAltitude - moon) / (sun - moon), 0), 1);
    return t * t * (3 - 2 * t);
}

/** The white "auto" balances on at a sun altitude in degrees, linear sRGB at unit luminance like its two ends. */
export function autoWhite(sunAltitude: number): [number, number, number] {
    const s = sunWhiteShare(sunAltitude);
    return [0, 1, 2].map((i) => s * (SUN_WHITE[i] ?? 1) + (1 - s) * (MOON_WHITE[i] ?? 1)) as [number, number, number];
}

/**
 * The one white balance every figure that finishes a sky frame takes, for the Sun's true direction, ENU: the Sun's
 * white while it is up, a camera set to daylight, which keeps a sunset warm, and the Moon's from the end of nautical
 * twilight, which shows the Moon a neutral gray, smoothly between. The Moon's also on a night without it, so the
 * picture does not jump at moonrise. `degree` as helldunkel's `whiteBalance`.
 */
export function skyWhite(sunDirection: readonly number[], choice: WhiteChoice = "auto", degree = 1): WhiteBalance {
    if (choice === "none") return NO_WHITE_BALANCE;
    if (choice === "sun") return whiteBalance(SUN_WHITE, degree);
    if (choice === "moon") return whiteBalance(MOON_WHITE, degree);
    const z = Math.min(Math.max(sunDirection[2] ?? 1, -1), 1);
    return whiteBalance(autoWhite(Math.asin(z) / DEG), degree);
}
