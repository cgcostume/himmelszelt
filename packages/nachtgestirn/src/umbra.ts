/**
 * The light inside Earth's umbra: sunlight the atmosphere bends around the planet into its shadow, the light of every
 * sunrise and sunset on Earth at once, which leaves the eclipsed Moon copper. Integrated here over the ring of air
 * around Earth's limb as a point in the shadow sees it, after Link's model of lunar eclipses, from two functions of the
 * height a ray grazes the ground at, which the caller brings (`@himmelszelt/dunstkreis`' `refractionAngle` and
 * `airTransmittance` on the himmelszelt site): how far the air bends the ray in all, and what it lets through of it.
 */

import { EARTH_RADIUS_KM, type Vec3 } from "./orientation.js";

/** Entries of the umbra's table, from the shadow's axis to the penumbra's edge: NG_UMBRA_SAMPLES in params.wgsl. */
export const UMBRA_SAMPLES = 64;

export interface RefractedSunlightOptions {
    /** How far the air turns a ray that grazes the ground `heightKm` up, in radians, over its whole way through: twice
     *  what an observer there sees a body on the horizon lifted by. About 0.02 at sea level, a tenth of that 20 km up. */
    deflection: (heightKm: number) => number;
    /** What the air lets through of sunlight along that whole way, per channel of linear sRGB: the square of what an
     *  observer at `heightKm` sees a body on the horizon dimmed by. */
    transmittance: (heightKm: number) => Vec3;
    /** The umbra's and the penumbra's radii at the Moon's distance, in km, `eclipse.lunar` of `@himmelszelt/sternzeit`:
     *  the table runs from the axis to the penumbra's edge. */
    umbraKm: number;
    penumbraKm: number;
    /** The Moon's distance from Earth's center, in km. */
    distanceKm: number;
    /** The Sun's angular radius in radians, about 0.00465. */
    sunAngularRadius: number;
    /** Up to which height the air is counted, in km, 80 by default, in how many steps, 320 by default: above it the
     *  light goes straight, which the pass counts already. Below `cloudsKm`, 2 by default, the ray is taken as
     *  blocked, by the weather and the ground's unevenness. */
    topKm?: number;
    steps?: number;
    cloudsKm?: number;
    earthRadiusKm?: number;
}

/**
 * What Earth's air adds to the sunlight in its shadow, as a share of the sunlight above the air, per channel, at
 * `UMBRA_SAMPLES` distances from the shadow's axis, from the axis to the penumbra's edge, as the Moon pass'
 * `EarthShadow.refracted` takes it. A ray grazing the ground `h` up at one azimuth of the limb is turned towards the
 * axis by the deflection and lands `distance` times that nearer it, dimmed by the transmittance; a point of the shadow
 * adds up the light of every ring of air and azimuth whose landed ray came from somewhere on the Sun's disc, and gives
 * back what the pass' direct term counted for that ring as if there were no air. Near sea level the air bends the light
 * past the axis to the shadow's far side, dimmed to a red glow; from 10 km up it lands near the umbra's edge, where the
 * ozone of the stratosphere takes the orange out and leaves the rim turquoise.
 */
export function refractedSunlight(options: RefractedSunlightOptions): Float32Array {
    const {
        deflection,
        transmittance,
        penumbraKm,
        distanceKm,
        sunAngularRadius,
        topKm = 80,
        steps = 320,
        cloudsKm = 2,
        earthRadiusKm = EARTH_RADIUS_KM,
    } = options;
    const table = new Float32Array(UMBRA_SAMPLES * 4);
    // Each ring of air: where its ray lands from the axis, in km, and what it carries over the solid angle it fills
    // seen from the Moon.
    const dh = topKm / steps;
    const rings: { landedKm: number; weight: Vec3 }[] = [];
    for (let i = 0; i < steps; i++) {
        const h = (i + 0.5) * dh;
        if (h < cloudsKm) continue;
        const t = transmittance(h);
        const solidAngle = ((earthRadiusKm + h) * dh) / (distanceKm * distanceKm);
        rings.push({
            landedKm: earthRadiusKm + h - distanceKm * deflection(h),
            weight: [(t[0] ?? 0) * solidAngle, (t[1] ?? 0) * solidAngle, (t[2] ?? 0) * solidAngle],
        });
    }
    // The Sun's disc as a limit on the ray's direction: a ray landed at `landed` along the limb's azimuth reaches a point
    // `x` out from the axis if the Sun point it came from, their difference over the distance, lies within the disc.
    const sunArea = Math.PI * sunAngularRadius * sunAngularRadius;
    const reach = (sunAngularRadius * distanceKm) ** 2;
    for (let k = 0; k < UMBRA_SAMPLES; k++) {
        const xKm = (k / (UMBRA_SAMPLES - 1)) * penumbraKm;
        const sum = [0, 0, 0];
        for (const ring of rings) {
            // The share of the ring's azimuths whose rays reach the point: |L e(phi) - x|^2 <= reach, closed form, the
            // arc where cos(phi) >= (L^2 + x^2 - reach) / (2 L x).
            const l = ring.landedKm;
            const c = (l * l + xKm * xKm - reach) / Math.max(2 * Math.abs(l) * xKm, 1e-9);
            const share = xKm === 0 ? (l * l <= reach ? 1 : 0) : c <= -1 ? 1 : c >= 1 ? 0 : Math.acos(c) / Math.PI;
            if (share > 0) for (let ch = 0; ch < 3; ch++) sum[ch] = (sum[ch] ?? 0) + (ring.weight[ch] ?? 0) * share;
        }
        for (let ch = 0; ch < 3; ch++) table[k * 4 + ch] = ((sum[ch] ?? 0) * 2 * Math.PI) / sunArea;
    }
    return table;
}

/**
 * The umbra's light without an atmosphere model to integrate: a hand-set table after photographs of typical eclipses,
 * a hundred thousandth of the sunlight at the axis, thirty times that at the umbra's edge, copper with a turquoise
 * rim, fading out half an umbra radius beyond the edge. The pass' default, for the penumbra `ratio` times as wide as
 * the umbra, 1.78 at the Moon's mean distance.
 */
export function typicalUmbra(ratio = 1.78): Float32Array {
    const table = new Float32Array(UMBRA_SAMPLES * 4);
    const smooth = (a: number, b: number, t: number) => {
        const u = Math.min(Math.max((t - a) / (b - a), 0), 1);
        return u * u * (3 - 2 * u);
    };
    const copper = [1, 0.32, 0.1];
    const rim = [0.55, 0.8, 1];
    for (let k = 0; k < UMBRA_SAMPLES; k++) {
        const depth = (k / (UMBRA_SAMPLES - 1)) * ratio;
        const d1 = Math.min(depth, 1);
        const amount = 1e-5 * 10 ** (1.5 * d1 * d1) * (1 - smooth(1, 1.5, depth));
        const t = smooth(0.8, 1.05, depth);
        for (let c = 0; c < 3; c++) table[k * 4 + c] = ((copper[c] ?? 0) * (1 - t) + (rim[c] ?? 0) * t) * amount;
    }
    return table;
}

/** The table read between its entries, at `axisKm` from the axis, the penumbra's radius `penumbraKm`, per channel. */
export function umbraLightAt(table: Float32Array, axisKm: number, penumbraKm: number): Vec3 {
    const x = (axisKm / penumbraKm) * (UMBRA_SAMPLES - 1);
    if (x >= UMBRA_SAMPLES - 1 || x < 0) return [0, 0, 0];
    const i = Math.floor(x);
    const f = x - i;
    const at = (c: number) => (table[i * 4 + c] ?? 0) * (1 - f) + (table[(i + 1) * 4 + c] ?? 0) * f;
    return [at(0), at(1), at(2)];
}
