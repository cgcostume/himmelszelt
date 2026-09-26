/**
 * Atmospheric refraction, as a correction to a view ray.
 *
 * This is the CPU twin of `wgsl/refraction.wgsl`; both implement the same fit and are pinned to each other by a
 * test. Having it here too lets a consumer do the correction on their own rays, and lets the shader's version
 * be verified without a screenshot.
 *
 * Refraction is deliberately not derived from the scattering model: it comes from air's refractive index,
 * scattering and absorption from its cross-sections, and neither follows from the other.
 *
 * One model for every ray: refraction comes from the air along it, mostly from around its lowest point, so it falls off
 * with that point's height like the air pressure. With B(a) Bennett's fit at sea level and p(h) the pressure ratio, a
 * ray going up bends by B(a) p(h_observer); a ray from space grazing the planet, in and out, by 2 B(0) p(h_lowest); a
 * ray going down from an elevated observer, past the ground, by 2 B(0) p(h_lowest) - B(|a|) p(h_observer).
 */

const DEG_TO_RAD = Math.PI / 180;

/** Bennett's fit is Earth's, so the planet it takes the lowest point of a ray over is Earth's too. */
const EARTH_RADIUS_M = 6_371_000;

/** Pressure scale height of the international standard atmosphere, in meters: R·T₀ / (M·g) at 288.15 K. */
export const PRESSURE_SCALE_HEIGHT_M = 8434.5;

/**
 * Air pressure at a height above sea level, relative to sea level. Thinner air bends light less, so this is
 * what makes refraction fall off with the observer's height and vanish at the top of the atmosphere.
 */
export function airPressureRatio(observerHeightM: number): number {
    return Math.exp(-observerHeightM / PRESSURE_SCALE_HEIGHT_M);
}

/** Local conditions at the observer. Both default to the ones the fit itself assumes. */
export interface RefractionConditions {
    /** Observer height above sea level, in meters. */
    observerHeightM?: number;
    /** Local air temperature, in degrees Celsius. */
    temperatureC?: number;
}

/**
 * Refraction, in degrees, as a function of the *apparent* altitude it produced, per Meeus 16.3 from
 * Bennett 1982. ~34.5' at the horizon, 0 at the zenith.
 *
 * This is the direction a renderer needs, since a camera ray is by definition an apparent direction:
 * subtracting this from a ray's apparent altitude gives the true altitude to sample the sky at.
 * `@himmelszelt/sternzeit`'s `earth.atmosphericRefraction` is the inverse relation (Meeus 16.4, true to apparent), for
 * correcting a computed body position instead. Apply one or the other, never both.
 *
 * The fit is stated for apparent altitudes of 0 and up and has a pole at -4.4°, so the input is clamped at 0.
 */
export function atmosphericRefractionFromApparent(
    apparentAltitude: number,
    conditions: RefractionConditions = {},
): number {
    const { observerHeightM = 0, temperatureC = 10 } = conditions;
    return bennett(apparentAltitude) * airPressureRatio(observerHeightM) * temperatureScale(temperatureC);
}

/** Bennett's fit, in degrees, at sea level and 10 °C; the constant zeroes it at the zenith, which the bare fit misses by
 *  ~0.0014'. Clamped at 0, below its pole at -4.4°. */
function bennett(apparentAltitude: number): number {
    const h = Math.max(apparentAltitude, 0);
    return (1 / Math.tan((h + 7.31 / (h + 4.4)) * DEG_TO_RAD) + 0.0013515216737563) / 60;
}

/** Meeus' 283/(273+T) scaling (ch. 16), exactly 1 at the fit's own conditions. */
const temperatureScale = (temperatureC: number) => 283 / (273 + temperatureC);

/**
 * Refraction, in degrees, along the whole ray an observer looks along, up or down, from the sine and cosine of its
 * apparent altitude (see the model above). Taken from the direction's components, as the WGSL twin has to: its cos
 * would lose kilometers of the lowest point's height.
 */
export function refractionAlongRay(sinAltitude: number, cosAltitude: number, conditions: RefractionConditions = {}) {
    const { observerHeightM = 0, temperatureC = 10 } = conditions;
    const apparentAltitude = Math.atan2(sinAltitude, cosAltitude) / DEG_TO_RAD;
    if (sinAltitude >= 0) return atmosphericRefractionFromApparent(apparentAltitude, conditions);

    const lowest = observerHeightM * cosAltitude - (EARTH_RADIUS_M * sinAltitude * sinAltitude) / (1 + cosAltitude);
    const twice = 2 * bennett(0) * airPressureRatio(Math.max(lowest, 0));
    const back = bennett(-apparentAltitude) * airPressureRatio(observerHeightM);
    return (twice - back) * temperatureScale(temperatureC);
}

/** Refraction, in degrees, of a ray from space through the atmosphere whose lowest point is that high over the ground:
 *  about 1.2° grazing the ground, falling off with the pressure above it. */
export function refractionThroughAtmosphere(lowestHeightM: number, temperatureC = 10): number {
    return 2 * bennett(0) * airPressureRatio(Math.max(lowestHeightM, 0)) * temperatureScale(temperatureC);
}

/**
 * Warps an apparent (camera) view direction to the true direction to sample the sky at, in a right-handed
 * frame whose `z` is the local up. Returns a unit vector.
 *
 * Lowering every ray by its own refraction is what produces, from one function: bodies staying visible while
 * geometrically below the horizon, the whole sky compressing slightly near the horizon, and the vertical
 * flattening of the sun and moon there, which follows from the steep `dR/da` rather than needing the disc to
 * be special-cased.
 */
export function refractViewDirection(
    direction: readonly [number, number, number],
    conditions: RefractionConditions = {},
): [number, number, number] {
    const [x, y, z] = direction;

    const horizontal = Math.hypot(x, y);
    if (horizontal < 1e-9) return [x, y, Math.sign(z) || 1]; // straight up or down, nothing to bend

    const delta = refractionAlongRay(z, horizontal, conditions) * DEG_TO_RAD;

    // Lowered by delta within its vertical plane, as the WGSL does it: a small rotation with polynomial sine and cosine.
    const c = 1 - 0.5 * delta * delta;
    const s = delta - (delta * delta * delta) / 6;
    const [vx, vy, vz] = [
        x * c + ((z * x) / horizontal) * s,
        y * c + ((z * y) / horizontal) * s,
        z * c - horizontal * s,
    ];
    const length = Math.hypot(vx, vy, vz);
    return [vx / length, vy / length, vz / length];
}

/**
 * The inverse of `refractViewDirection`: where a body in the true direction appears, lifted by refraction. Solved by
 * bisection, since the fit takes the apparent altitude it is to produce: a - R(a) only grows with a, so this always
 * finds it. A plain fixed-point iteration does not: looking down from high up, R changes faster than a and it swings.
 * For pointing a camera at the sun, or marking where it shows.
 */
export function apparentDirection(
    direction: readonly [number, number, number],
    conditions: RefractionConditions = {},
): [number, number, number] {
    const [x, y, z] = direction;
    const horizontal = Math.hypot(x, y);
    if (horizontal < 1e-9) return [x, y, Math.sign(z) || 1];

    const trueAltitude = Math.atan2(z, horizontal) / DEG_TO_RAD;
    const lowered = (a: number) =>
        a - refractionAlongRay(Math.sin(a * DEG_TO_RAD), Math.cos(a * DEG_TO_RAD), conditions);
    // Refraction never exceeds ~1.3 degrees, twice the horizon's in the coldest air, so the answer lies in this bracket.
    let [low, high] = [trueAltitude, trueAltitude + 2.5];
    for (let i = 0; i < 40; ++i) {
        const middle = (low + high) / 2;
        if (lowered(middle) < trueAltitude) low = middle;
        else high = middle;
    }
    const altitude = (low + high) / 2;

    const cosAltitude = Math.cos(altitude * DEG_TO_RAD);
    return [(x / horizontal) * cosAltitude, (y / horizontal) * cosAltitude, Math.sin(altitude * DEG_TO_RAD)];
}
