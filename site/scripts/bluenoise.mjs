// Generates the blue noise the raytraced scene varies its sampling by: 64x64 texels, two independent channels, by
// Ulichney's void-and-cluster method (1993), from fixed seeds, so every run writes the same file. Blue noise holds
// little energy at low frequencies: per-pixel randomness drawn from it reads as fine, even grain rather than clumps.
//
//     pnpm --filter @himmelszelt/sternwarte bluenoise
//
// Writes src/components/scene/bluenoise.bin: 64 x 64 x 2 bytes, row by row, the two channels interleaved, each texel's
// rank among all 4096 scaled to 0..255.

import { writeFileSync } from "node:fs";

const SIZE = 64;
const N = SIZE * SIZE;
const SIGMA = 1.5;

// A small linear congruential generator, seeded, so the noise never changes between runs.
function random(seed) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

// The Gaussian filter's weights by toroidal offset: the texture tiles, so its energy wraps around the edges.
const kernel = new Float64Array(N);
for (let y = 0; y < SIZE; ++y) {
    for (let x = 0; x < SIZE; ++x) {
        const dx = Math.min(x, SIZE - x);
        const dy = Math.min(y, SIZE - y);
        kernel[y * SIZE + x] = Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA));
    }
}

/** Ranks from 0 to N - 1, one per texel, by void and cluster. */
function voidAndCluster(seed) {
    const next = random(seed);
    const on = new Uint8Array(N);
    const energy = new Float64Array(N);
    const toggle = (index, value) => {
        on[index] = value;
        const ix = index % SIZE;
        const iy = Math.floor(index / SIZE);
        const sign = value ? 1 : -1;
        for (let y = 0; y < SIZE; ++y) {
            const ky = ((y - iy + SIZE) % SIZE) * SIZE;
            for (let x = 0; x < SIZE; ++x) energy[y * SIZE + x] += sign * kernel[ky + ((x - ix + SIZE) % SIZE)];
        }
    };
    // The tightest cluster, the densest texel that is on, or the largest void, the emptiest that is off.
    const extreme = (wanted, pickMax) => {
        let best = -1;
        for (let i = 0; i < N; ++i) {
            if (on[i] !== wanted) continue;
            if (best < 0 || (pickMax ? energy[i] > energy[best] : energy[i] < energy[best])) best = i;
        }
        return best;
    };

    // A random start of a tenth of the texels, then evened out: the tightest cluster moves into the largest void until
    // it lands where it came from.
    const start = Math.floor(N / 10);
    for (let count = 0; count < start; ) {
        const i = Math.floor(next() * N);
        if (!on[i]) {
            toggle(i, 1);
            ++count;
        }
    }
    for (;;) {
        const cluster = extreme(1, true);
        toggle(cluster, 0);
        const empty = extreme(0, false);
        if (empty === cluster) {
            toggle(cluster, 1);
            break;
        }
        toggle(empty, 1);
    }
    const initial = on.slice();
    const energyInitial = energy.slice();
    const rank = new Int32Array(N);

    // Ranks below the start: taken out tightest cluster first.
    for (let r = start - 1; r >= 0; --r) {
        const cluster = extreme(1, true);
        toggle(cluster, 0);
        rank[cluster] = r;
    }
    // Ranks from the start up: filled in largest void first.
    on.set(initial);
    energy.set(energyInitial);
    for (let r = start; r < N; ++r) {
        const empty = extreme(0, false);
        toggle(empty, 1);
        rank[empty] = r;
    }
    return rank;
}

const channels = [voidAndCluster(20120315), voidAndCluster(20260927)];
const bytes = new Uint8Array(N * 2);
for (let i = 0; i < N; ++i) {
    for (let c = 0; c < 2; ++c) bytes[i * 2 + c] = Math.floor((channels[c][i] * 256) / N);
}
const target = new URL("../src/components/scene/bluenoise.bin", import.meta.url);
writeFileSync(target, bytes);
console.log(`wrote ${target.pathname}, ${bytes.length} bytes`);
