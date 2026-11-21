// Generates the blue noise the raytraced scene varies its sampling by: 64x64 texels, two independent channels, by
// Ulichney's void-and-cluster method (1993) as helldunkel's scripts/bluenoise.mjs has it, from fixed seeds, so every run
// writes the same file. The first channel is the noise helldunkel ships for its dither.
//
//     pnpm --filter @himmelszelt/sternwarte bluenoise
//
// Writes src/components/scene/bluenoise.bin: 64 x 64 x 2 bytes, row by row, the two channels interleaved, each texel's
// rank among all 4096 scaled to 0..255.

import { writeFileSync } from "node:fs";
import { blueNoiseBytes, SEED, SIZE } from "../../packages/helldunkel/scripts/bluenoise.mjs";

const N = SIZE * SIZE;
const channels = [blueNoiseBytes(SEED), blueNoiseBytes(20260927)];
const bytes = new Uint8Array(N * 2);
for (let i = 0; i < N; ++i) {
    for (let c = 0; c < 2; ++c) bytes[i * 2 + c] = channels[c][i];
}
const target = new URL("../src/components/scene/bluenoise.bin", import.meta.url);
writeFileSync(target, bytes);
console.log(`wrote ${target.pathname}, ${bytes.length} bytes`);
