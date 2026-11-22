// A solar eclipse on the CPU: what the sky pass packs for `dkEclipse` in raymarch.wgsl, and the share of the Sun's disc
// the Moon leaves uncovered, for whoever needs the Sun's light without reading it back.

/** The Moon's mean radius in km. */
const MOON_RADIUS_KM = 1737.4;
/** Within how many arcseconds of an inner contact Baily's beads are drawn: most of a minute either side of it. */
const BEADS_REACH = 20;
/** How far from the Sun the Moon may stand, in degrees, and still cover it for some of the air an observer sees. */
const ECLIPSE_REACH = 1.6;

/**
 * A solar eclipse as `DkSkyParams` holds it: where the Moon's center stands off the line from the observer towards the
 * Sun, across it, how far along it the Moon is, and the Moon's radius, all in km. The Moon's distance is its radius over
 * the sine of half the diameter it shows. The radius is 0, and with it the eclipse, without a Moon or with it farther
 * from the Sun than `ECLIPSE_REACH`: its half shadow then lies beyond all the air the observer looks through. Last, 1 while
 * Baily's beads show.
 */
export function solarEclipse(
    sun: readonly number[],
    moon: readonly number[],
    moonAngularDiameter: number,
    sunAngularDiameter: number,
) {
    const [sx = 0, sy = 0, sz = 1] = sun;
    const [mx = 0, my = 0, mz = 1] = moon;
    const cos = sx * mx + sy * my + sz * mz;
    if (!(moonAngularDiameter > 0) || cos < Math.cos((ECLIPSE_REACH * Math.PI) / 180)) return [0, 0, 0, 0, 0, 0];
    const distance = MOON_RADIUS_KM / Math.sin((moonAngularDiameter * Math.PI) / 360);
    const offset = [mx - sx * cos, my - sy * cos, mz - sz * cos].map((c) => c * distance);
    // Baily's beads while the two limbs are within `BEADS_REACH` of touching from inside, a total or an annular
    // eclipse's second and third contact.
    const apart = Math.hypot(mx - sx, my - sy, mz - sz);
    const inside = Math.abs(((moonAngularDiameter - sunAngularDiameter) * Math.PI) / 360);
    const beads = Math.abs(apart - inside) < (BEADS_REACH * Math.PI) / 648000 ? 1 : 0;
    return [...offset, distance * cos, MOON_RADIUS_KM, beads];
}

/**
 * The share of the Sun's disc the Moon leaves uncovered, 1 with nothing in front and 0 in a total eclipse: what two
 * discs of angular radius `sun` and `moon` overlap by with their centers `apart`, all three in the same unit, the Sun's
 * taken as evenly bright. Times it, the Sun's illuminance is what the sky pass' `sunIlluminance()` reads in an
 * eclipse. The TypeScript twin of `dkDiscUncovered` in `wgsl.raymarch`.
 */
export function discUncovered(sun: number, moon: number, apart: number): number {
    if (apart >= sun + moon) return 1;
    if (apart <= Math.abs(moon - sun)) return 1 - Math.min((moon * moon) / (sun * sun), 1);
    const towardsSun = (apart * apart + sun * sun - moon * moon) / (2 * apart * sun);
    const towardsMoon = (apart * apart + moon * moon - sun * sun) / (2 * apart * moon);
    const kite = Math.max((sun + moon - apart) * (apart + sun - moon) * (apart - sun + moon) * (apart + sun + moon), 0);
    const clamped = (x: number) => Math.min(Math.max(x, -1), 1);
    const lens =
        sun * sun * Math.acos(clamped(towardsSun)) +
        moon * moon * Math.acos(clamped(towardsMoon)) -
        0.5 * Math.sqrt(kite);
    return Math.min(Math.max(1 - lens / (Math.PI * sun * sun), 0), 1);
}
