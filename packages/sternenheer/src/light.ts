// The stars' light in physical units, from the magnitudes a catalog lists.

/** The Sun's illuminance above the atmosphere, in lux, and its apparent visual magnitude, as `@himmelszelt/dunstkreis`
 *  and Allen's Astrophysical Quantities have them: the two fix the scale between magnitudes and lux. */
export const SUN_ILLUMINANCE = 128_000;
export const SUN_MAGNITUDE = -26.74;

/** The illuminance of a star of apparent magnitude 0, in lux: some 2.5 millionths of a lux, as Vega gives. */
export const MAGNITUDE_ZERO_ILLUMINANCE = SUN_ILLUMINANCE * 10 ** (0.4 * SUN_MAGNITUDE);

/** The illuminance at the eye, in lux, of a star of apparent visual magnitude `magnitude`, above the air: five
 *  magnitudes are a factor of a hundred, Sirius at -1.46 gives ten millionths of a lux, the faintest naked-eye star
 *  at 6.5 a hundredth of that. */
export function illuminanceFromMagnitude(magnitude: number): number {
    return MAGNITUDE_ZERO_ILLUMINANCE * 10 ** (-0.4 * magnitude);
}

/** The apparent magnitude of a point source of `illuminance` lux: the inverse of `illuminanceFromMagnitude`. */
export function magnitudeFromIlluminance(illuminance: number): number {
    return -2.5 * Math.log10(illuminance / MAGNITUDE_ZERO_ILLUMINANCE);
}

/** A tenth-magnitude star per square degree, the S10 unit diffuse sky brightness is tallied in, as a luminance in
 *  cd/m²: some 0.83 millionths of a candela per square meter. */
export const S10_LUMINANCE = illuminanceFromMagnitude(10) / (Math.PI / 180) ** 2;

/** A surface brightness in magnitudes per square arcsecond, the astronomer's unit for the night sky, as a luminance
 *  in cd/m²: 21.5, a dark rural sky, is some 0.2 thousandths of a candela per square meter. */
export function luminanceFromSurfaceBrightness(magnitudesPerSquareArcsecond: number): number {
    return illuminanceFromMagnitude(magnitudesPerSquareArcsecond) / (Math.PI / 180 / 3600) ** 2;
}

/** The inverse of `luminanceFromSurfaceBrightness`. */
export function surfaceBrightnessFromLuminance(luminance: number): number {
    return magnitudeFromIlluminance(luminance * (Math.PI / 180 / 3600) ** 2);
}
