// A star's color from its color index B-V, the difference of its blue and visual magnitudes a catalog lists: a
// temperature, a point on the Planckian locus, a linear sRGB color at unit luminance. The shipped catalog holds the
// result of the approximate path per star, as osgHimmel computed it; these let a consumer recolor from another
// catalog, or more exactly.

export type Rgb = readonly [r: number, g: number, b: number];

/**
 * A star's effective temperature in kelvin from its color index B-V, by Ballesteros' formula (2012), which treats the
 * star as a black body seen through the two filters: 10,100 K for Vega's 0.0, 5,800 K for the Sun's 0.65, 3,600 K for
 * Betelgeuse's 1.85. Good to a few percent from 2,500 K to 30,000 K.
 */
export function temperatureFromColorIndex(bv: number): number {
    return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
}

/** `temperatureFromColorIndex` as Jensen et al. 2001 approximate it, 7000 K over B-V plus 0.56, which the shipped
 *  catalog's colors were computed with: 12,500 K for Vega, 5,800 K for the Sun, too hot for the hottest stars. */
export function temperatureFromColorIndexApprox(bv: number): number {
    return 7000 / (bv + 0.56);
}

/**
 * The chromaticity of a black body at `temperature` kelvin, CIE 1931 x and y, by Kim et al.'s cubic spline fit of the
 * Planckian locus (2002), within 0.001 from 1,667 K to 25,000 K; clamped to that range.
 */
export function planckianLocus(temperature: number): readonly [x: number, y: number] {
    const t = Math.min(Math.max(temperature, 1667), 25000);
    const o = 1 / t;
    const x =
        t <= 4000
            ? 0.17991 + o * (877.6956 + o * (-234358.0 + o * -266123900.0))
            : 0.24039 + o * (222.6347 + o * (2107037.9 + o * -3025846900.0));
    const y =
        t <= 2222
            ? -0.20219683 + x * (2.18555832 + x * (-1.3481102 + x * -1.1063814))
            : t <= 4000
              ? -0.16748867 + x * (2.09137015 + x * (-1.3741859 + x * -0.9549476))
              : -0.37001483 + x * (3.75112997 + x * (-5.8733867 + x * 3.081758));
    return [x, y];
}

/** A chromaticity x, y at luminance `Y` as linear sRGB, the IEC matrix with the D65 white: a color outside the gamut
 *  comes out with a negative channel, which a renderer clamps. */
export function linearSrgbFromChromaticity([x, y]: readonly [number, number], Y = 1): Rgb {
    const X = (Y / y) * x;
    const Z = (Y / y) * (1 - x - y);
    return [
        3.2406 * X - 1.5372 * Y - 0.4986 * Z,
        -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
        0.0557 * X - 0.204 * Y + 1.057 * Z,
    ];
}

/** A star's linear sRGB color at unit luminance from its color index B-V, by Ballesteros' temperature: blue-white
 *  for Vega, white-yellow for the Sun, orange for Betelgeuse. */
export function colorFromColorIndex(bv: number): Rgb {
    return linearSrgbFromChromaticity(planckianLocus(temperatureFromColorIndex(bv)));
}

/** `colorFromColorIndex` by Jensen et al.'s temperature, the shipped catalog's colors. */
export function colorFromColorIndexApprox(bv: number): Rgb {
    return linearSrgbFromChromaticity(planckianLocus(temperatureFromColorIndexApprox(bv)));
}
