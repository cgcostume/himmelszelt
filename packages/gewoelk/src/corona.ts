/** A corona: the droplets' radius in micrometers and how far their sizes vary, as a share of it. */
export interface Corona {
    /** The droplets' radius in micrometers: the smaller, the wider the corona. 10 gives a glow 2° in radius. */
    dropletRadiusUm: number;
    /** The standard deviation of the droplets' radii as a share of the radius: 0 for rings without end, 0.3 for none. */
    spread: number;
}

/** Droplets of 10 µm, varying by 15 %: a glow out to 2° with a red rim and one faint ring. */
export const DEFAULT_CORONA: Corona = { dropletRadiusUm: 10, spread: 0.15 };

/** The wavelengths in nanometers the corona is drawn at for red, green and blue. */
export const CORONA_WAVELENGTHS = [610, 550, 465] as const;

/** Bessel's J1 for `x` of 0 or more, after Abramowitz and Stegun 9.4.4 and 9.4.6: to a ten-millionth. */
function besselJ1(x: number): number {
    if (x <= 3) {
        const t = (x * x) / 9;
        const series = [0.5, -0.56249985, 0.21093573, -0.03954289, 0.00443319, -0.00031761, 0.00001109];
        return x * series.reduceRight((sum, c) => sum * t + c, 0);
    }
    const t = 3 / x;
    const amplitude = [0.79788456, 0.00000156, 0.01659667, 0.00017105, -0.00249511, 0.00113653, -0.00020033];
    const phase = [-2.35619449, 0.12499612, 0.0000565, -0.00637879, 0.00074348, 0.00079824, -0.00029166];
    const at = (c: number[]) => c.reduceRight((sum, k) => sum * t + k, 0);
    return (at(amplitude) * Math.cos(x + at(phase))) / Math.sqrt(x);
}

/**
 * The lobe a cloud's droplets diffract light of `wavelengthNm` into, per steradian and 1 over the sphere, at `angle`
 * degrees from the source: Airy's pattern of a disc as wide as the droplet, its rings fading into their mean with the
 * angle as the droplets' sizes vary. The TypeScript twin of `gwDiffractionLobe` in `wgsl.corona`, for plotting it.
 */
export function diffractionLobe(angle: number, wavelengthNm: number, corona: Corona = DEFAULT_CORONA): number {
    const size = (2 * Math.PI * corona.dropletRadiusUm * 1000) / wavelengthNm;
    const u = (size * angle * Math.PI) / 180;
    const airy = u > 1e-3 ? ((2 * besselJ1(u)) / u) ** 2 : 1;
    const mean = 4 / (Math.PI * (u ** 3 + 4));
    const rings = Math.exp(-2 * corona.spread ** 2 * u * u);
    return ((size * size) / (4 * Math.PI)) * (mean + (airy * (1 + 3 * corona.spread ** 2) - mean) * rings);
}

/**
 * How much of a source's light comes through cloud of `transmittance` diffracted once and not scattered otherwise, as
 * `gwCoronaShare` in `wgsl.corona`: times the source's illuminance and `diffractionLobe`, the corona in cd/m².
 */
export function coronaShare(transmittance: number): number {
    const through = Math.min(Math.max(transmittance, 1e-6), 1);
    return Math.log(1 / through) * through * through;
}
