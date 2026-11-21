/**
 * How many spikes an aperture of `blades` straight blades draws around a bright point source, as `hdStarburst` in
 * `wgsl.lens` does: every edge diffracts the light into a line across it, and two parallel edges share one, so an even
 * count draws as many spikes as blades, an odd one twice as many.
 */
export function starburstSpikes(blades: number): number {
    return blades % 2 === 0 ? blades : 2 * blades;
}
