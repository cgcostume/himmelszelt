/**
 * The air's turbulence, and what it does to light from beyond it: it moves and blurs an image, the seeing, and makes a
 * point of light flicker, the scintillation. One model for both: the Hufnagel-Valley 5/7 profile of the turbulence's
 * strength Cn² over the height, carried by Bufton's wind, summed along the bent rays of the air table (`airTable`) and
 * scaled by Fried's parameter. So it holds wherever the table does: from the ground, from a mountain above most of it,
 * and from orbit through the limb, where the turbulence lies thousands of kilometers away.
 */

/** The wavelength the seeing is given at, in meters: green, where Fried's parameter is quoted. */
export const SEEING_WAVELENGTH_M = 550e-9;

/** Above this height in meters the profile holds nothing worth summing. */
const TURBULENCE_TOP_M = 30_000;

/**
 * The turbulence's strength Cn² at a height above sea level in meters, in m^(-2/3): the Hufnagel-Valley 5/7 profile, a
 * layer hugging the ground, a slowly thinning troposphere, and a bump at the tropopause, around 10 km, where the jet
 * stream shears the air. Named after what it gives at 500 nm from the ground: Fried's parameter of 5 cm and an
 * isoplanatic angle of 7 µrad.
 */
export function turbulenceStrength(heightM: number): number {
    if (heightM >= TURBULENCE_TOP_M) return 0;
    const h = Math.max(heightM, 0);
    const k2 = (1e-5 * h) ** 2;
    const k10 = k2 * k2 * k2 * k2 * k2;
    return (
        0.00594 * (21 / 27) ** 2 * k10 * Math.exp(-h / 1000) +
        2.7e-16 * Math.exp(-h / 1500) +
        1.7e-14 * Math.exp(-h / 100)
    );
}

// The root mean square of Bufton's 5 + 30 exp(...) m/s between 5 and 20 km, which the profile's 21 m/s stands for.
const BUFTON_RMS = 22.96;

/**
 * The wind at a height in meters that carries the turbulence across the line of sight, as a share of `Seeing.wind`:
 * Bufton's profile, a breeze near the ground and the jet stream around 9.4 km, over its root mean square between 5
 * and 20 km. A quarter near the ground, one and a half in the jet.
 */
export function turbulenceWind(heightM: number): number {
    return (5 + 30 * Math.exp(-(((heightM - 9400) / 4800) ** 2))) / BUFTON_RMS;
}

/** The turbulence a ray crosses, as an entry of the air table holds it. */
export interface Turbulence {
    /**
     * How much of it: for the seeing, the sum of Cn² along the ray; for the scintillation, each part weighed by its
     * distance from the observer to the power 5/6, as the flicker grows on the way. Both over what a ray straight up
     * from sea level crosses, so 1 there, and about the airmass, or its power 11/6, towards the horizon.
     */
    amount: number;
    /** How far away it lies, in meters, weighed the same way: the isoplanatic distance for the seeing, the mean one
     *  for the scintillation. */
    distanceM: number;
    /** The wind that carries it across the ray, weighed the same way, as a share of `Seeing.wind`. */
    wind: number;
}

/** The turbulence along a ray, for the image's motion and for a point's flicker. */
export interface PathTurbulence {
    seeing: Turbulence;
    scintillation: Turbulence;
}

interface Sums {
    strength: number;
    isoplanatic: number;
    wind: number;
    flicker: number;
    flickerDistance: number;
    flickerWind: number;
}

const noSums = (): Sums => ({ strength: 0, isoplanatic: 0, wind: 0, flicker: 0, flickerDistance: 0, flickerWind: 0 });

/** Adds a stretch of `lengthM` at `heightM`, `distanceM` from the observer. */
function add(sums: Sums, heightM: number, distanceM: number, lengthM: number) {
    const cn2 = turbulenceStrength(heightM) * lengthM;
    const wind = turbulenceWind(heightM);
    const weight = distanceM ** (5 / 6);
    sums.strength += cn2;
    sums.isoplanatic += cn2 * weight * weight;
    sums.wind += cn2 * wind;
    sums.flicker += cn2 * weight;
    sums.flickerDistance += cn2 * weight * distanceM;
    sums.flickerWind += cn2 * weight * wind;
}

let zenith: Sums | undefined;

/** The sums straight up from sea level, which the table's amounts are shares of. Steps a percent longer each. */
function zenithSums(): Sums {
    if (zenith) return zenith;
    zenith = noSums();
    for (let h = 0.01; h < TURBULENCE_TOP_M; h *= 1.01) add(zenith, h * 1.005, h * 1.005, h * 0.01);
    return zenith;
}

function turbulenceOf(sums: Sums): PathTurbulence {
    const reference = zenithSums();
    const none = { amount: 0, distanceM: 0, wind: 0 };
    if (sums.strength <= 0) return { seeing: none, scintillation: { ...none } };
    return {
        seeing: {
            amount: sums.strength / reference.strength,
            distanceM: (sums.isoplanatic / sums.strength) ** (3 / 5),
            wind: sums.wind / sums.strength,
        },
        scintillation: {
            amount: sums.flicker / reference.flicker,
            distanceM: sums.flickerDistance / sums.flicker,
            wind: sums.flickerWind / sums.flicker,
        },
    };
}

/**
 * The turbulence a ray crosses that has passed `airmass` zenith columns of air from sea level, where no path is
 * known: the flat Earth's, every layer `airmass` times as long and as far, which holds well above the horizon.
 */
export function turbulenceThrough(airmass: number): PathTurbulence {
    const { seeing, scintillation } = turbulenceOf(zenithSums());
    const x = Math.max(airmass, 0);
    return {
        seeing: { amount: x, distanceM: seeing.distanceM * x, wind: seeing.wind },
        scintillation: { amount: x ** (11 / 6), distanceM: scintillation.distanceM * x, wind: scintillation.wind },
    };
}

/**
 * The turbulence along a traced ray: `path` holds `steps + 1` points of it in its vertical plane, x and y in km, as
 * `traceSeen` fills it, around a point `centerKm` from the planet's center and `startKm` along the ray from the
 * observer. Each step is split where the height changes fast: the layer on the ground thins out within 100 m.
 */
export function turbulenceAlong(
    path: Float64Array,
    steps: number,
    centerKm: number,
    groundRadiusKm: number,
    startKm: number,
): PathTurbulence {
    const heightAt = (x: number, y: number) =>
        (Math.sqrt(x * x + (centerKm + y) * (centerKm + y)) - groundRadiusKm) * 1000;
    const sums = noSums();
    let distance = startKm * 1000;
    let [x0, y0] = [path[0] as number, path[1] as number];
    let h0 = heightAt(x0, y0);
    for (let i = 1; i <= steps; ++i) {
        const [x1, y1] = [path[2 * i] as number, path[2 * i + 1] as number];
        const h1 = heightAt(x1, y1);
        const length = Math.hypot(x1 - x0, y1 - y0) * 1000;
        if (Math.min(h0, h1) < TURBULENCE_TOP_M && length > 0) {
            const finest = Math.min(h0, h1) < 1000 ? 15 : 200;
            const parts = Math.min(Math.max(Math.ceil(Math.abs(h1 - h0) / finest), 1), 32);
            for (let j = 0; j < parts; ++j) {
                const u = (j + 0.5) / parts;
                const height = Math.max(heightAt(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u), 0);
                add(sums, height, distance + length * u, length / parts);
            }
        }
        distance += length;
        [x0, y0, h0] = [x1, y1, h1];
    }
    return turbulenceOf(sums);
}

/**
 * How steady the air is, and what looks through it. The first two describe the night, the last two the eye or the
 * camera: the same air moves a telescope's image less than a pupil's, and flickers less over a long exposure.
 */
export interface Seeing {
    /**
     * Fried's parameter at 550 nm straight up from sea level, in meters: the width of the lens the air still lets
     * resolve what it could. 0.1 by default, a fair night with an arcsecond of seeing; 0.05 a poor one, 0.2 a very good
     * one. It scales the whole profile.
     */
    r0?: number;
    /** The wind up high, in m/s: the root mean square between 5 and 20 km, 21 by default, as the profile's. How fast
     *  the turbulence crosses the line of sight, and so how fast the image moves and a star flickers. */
    wind?: number;
    /** The observer's own speed across the line of sight, in m/s: 0 by default, 7700 in the space station's orbit,
     *  where it, not the wind, sweeps the ray through the turbulence. */
    speed?: number;
    /** The width of the lens, in meters: 0.007 by default, the eye's pupil at night. 0.1 for a telephoto lens. */
    aperture?: number;
    /** How long the light is gathered, in seconds: 0.1 by default, the eye's; a camera's exposure. Only the flicker
     *  of a point takes it: the shimmer of an image is drawn as one short exposure. */
    exposure?: number;
}

const settled = ({ r0 = 0.1, wind = 21, speed = 0, aperture = 0.007, exposure = 0.1 }: Seeing) => ({
    r0: Math.max(r0, 1e-6),
    wind,
    speed,
    aperture: Math.max(aperture, 1e-6),
    exposure,
});

/** How fast the turbulence crosses a ray, in m/s: the wind and the observer's own speed, at right angles on average. */
const crossing = (seeing: Seeing, turbulence: Turbulence) =>
    Math.max(Math.hypot(settled(seeing).wind * turbulence.wind, settled(seeing).speed), 1e-6);

/**
 * How far the image moves straight up from sea level: the standard deviation of its place along each axis, in radians.
 * The one-axis image motion of a lens in Kolmogorov turbulence, 0.18 λ² D^(-1/3) r0^(-5/3) for its variance: 0.75
 * arcseconds for a pupil on a fair night, 0.48 for a 10 cm lens.
 */
export function zenithTilt(seeing: Seeing = {}): number {
    const { r0, aperture } = settled(seeing);
    return Math.sqrt(0.18 * SEEING_WAVELENGTH_M ** 2 * aperture ** (-1 / 3) * r0 ** (-5 / 3));
}

/**
 * How much a star flickers straight up from sea level, to a lens far smaller than the pattern the flicker casts on the
 * ground and before any exposure averages it: the variance of its light over its mean's square, by the weak
 * turbulence's 2.25 k^(7/6) ∫ Cn² h^(5/6) dh, the profile scaled to `r0`. 0.08 on a fair night.
 */
export function zenithScintillation(seeing: Seeing = {}): number {
    const { r0 } = settled(seeing);
    const { strength, flicker } = zenithSums();
    const k = (2 * Math.PI) / SEEING_WAVELENGTH_M;
    return (2.25 / 0.423) * k ** (-5 / 6) * (flicker / strength) * r0 ** (-5 / 3);
}

/**
 * What the shimmer makes of the turbulence along a ray, `airAt(table, altitude).seeing`: `tilt`, the standard deviation
 * of the image's place along each axis, in radians, growing with the root of the turbulence crossed; `cell`, the finest
 * patch of sky that still moves as one, the lens' width seen from the turbulence, in radians; `drift`, how fast the
 * wind carries the pattern across the sky, in radians a second.
 */
export function shimmerScales(seeing: Seeing, turbulence: Turbulence) {
    const { aperture } = settled(seeing);
    const distance = Math.max(turbulence.distanceM, 1);
    return {
        tilt: zenithTilt(seeing) * Math.sqrt(Math.max(turbulence.amount, 0)),
        cell: aperture / distance,
        drift: crossing(seeing, turbulence) / distance,
    };
}

/**
 * How a star flickers through the turbulence along a ray, `airAt(table, altitude).scintillation`: `variance`, that of
 * its light over its mean's square as the lens and the exposure leave it, and `time`, how long the flicker stays
 * alike, in seconds. The unaveraged variance grows with the turbulence and saturates at 1. A lens wider than the
 * pattern the flicker casts, the Fresnel scale √(λ distance), some 6 cm from the ground, averages over it, by Andrews
 * and Phillips' aperture averaging factor; an exposure of many times the pattern's crossing time averages over those,
 * leaving the variance of an exponentially correlated signal's mean.
 */
export function scintillation(seeing: Seeing, turbulence: Turbulence) {
    const { aperture, exposure } = settled(seeing);
    const distance = Math.max(turbulence.distanceM, 1);
    const k = (2 * Math.PI) / SEEING_WAVELENGTH_M;
    const instant = Math.min(zenithScintillation(seeing) * Math.max(turbulence.amount, 0), 1);
    const gathered = instant * (1 + (1.062 * k * aperture * aperture) / (4 * distance)) ** (-7 / 6);
    const time = Math.max(Math.sqrt(SEEING_WAVELENGTH_M * distance), aperture) / crossing(seeing, turbulence);
    const x = Math.max(exposure / time, 1e-3);
    return { variance: (gathered * 2 * (x - 1 + Math.exp(-x))) / (x * x), time };
}

/**
 * How strongly a star twinkles: the standard deviation of the logarithm of its light, which is lognormal. 0.08 at the
 * zenith for the eye on a fair night, 0.17 at 30° up, 0.39 at 10°.
 */
export function scintillationIndex(seeing: Seeing, turbulence: Turbulence): number {
    return Math.sqrt(Math.log(1 + scintillation(seeing, turbulence).variance));
}

/** The size of the `DkSeeing` uniform block of `wgsl.seeing`, in bytes. */
export const SEEING_UNIFORM_SIZE = 32;

/**
 * Packs a seeing into the `DkSeeing` layout of `wgsl.seeing`: the image's motion and a star's flicker straight up from
 * sea level, which the shaders scale by each ray's turbulence from the air table, the lens, the exposure and the wind.
 * Pass `target` to write into a buffer of your own.
 */
export function seeingUniformData(seeing: Seeing = {}, target?: Float32Array): Float32Array {
    const data = target ?? new Float32Array(SEEING_UNIFORM_SIZE / 4);
    const { wind, speed, aperture, exposure } = settled(seeing);
    data.set([zenithTilt(seeing), zenithScintillation(seeing), aperture, exposure, wind, speed, 0, 0]);
    return data;
}
