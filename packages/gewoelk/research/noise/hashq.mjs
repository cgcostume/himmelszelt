// Are the four bits a gradient is picked by uniform, and independent of the neighbor's along every axis and of the next
// seed's? Chi squares over a 48³ lattice as z scores, for pcg3d's low bits, which picked the gradient before 2026-11-22,
// its top bits, and the corners' hash since, lowbias32 of a product per axis, at the bits each of the curl's three
// noises takes. |z| under about 3 is chance; before, the low bits failed along x, with z of 25 and over 100.
const lowbias = (h) => {
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return (h ^ (h >>> 16)) >>> 0;
};
const corners = (x, y, z, seed) =>
    lowbias(
        (Math.imul(x, 0x8da6b343) + Math.imul(y, 0xd8163841) + Math.imul(z, 0xcb1ab31f) + Math.imul(seed, 0x9e3779b9)) |
            0,
    );
const pcg3d = (x, y, z, seed) => {
    x = (Math.imul(x + Math.imul(seed, 0x9e3779b9), 1664525) + 1013904223) | 0;
    y = (Math.imul(y + Math.imul(seed, 0x85ebca6b) + 1, 1664525) + 1013904223) | 0;
    z = (Math.imul(z + Math.imul(seed, 0xc2b2ae35) + 2, 1664525) + 1013904223) | 0;
    x = (x + Math.imul(y, z)) | 0;
    y = (y + Math.imul(z, x)) | 0;
    z = (z + Math.imul(x, y)) | 0;
    x ^= x >>> 16;
    y ^= y >>> 16;
    z ^= z >>> 16;
    x = (x + Math.imul(y, z)) | 0;
    return x >>> 0;
};

const N = 48;
const OFFSETS = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 1, 0],
    [1, 1, 1],
    [2, 0, 0],
];
const z = (chi, dof) => (chi - dof) / Math.sqrt(2 * dof);
const chi = (counts, total) =>
    counts.reduce((s, c) => s + (c - total / counts.length) ** 2 / (total / counts.length), 0);

function test(name, nibble) {
    console.log(`${name}\n  seeds 0, 1, 3, 977: z of [uniform, +x, +y, +z, +xy, +xyz, +2x, next seed]`);
    for (const seed of [0, 1, 3, 977]) {
        const one = new Float64Array(16);
        const pairs = Array.from({ length: OFFSETS.length + 1 }, () => new Float64Array(256));
        for (let x = 0; x < N; x++)
            for (let y = 0; y < N; y++)
                for (let k = 0; k < N; k++) {
                    const a = nibble(x, y, k, seed);
                    one[a]++;
                    for (const [i, [dx, dy, dz]] of OFFSETS.entries())
                        pairs[i][a * 16 + nibble(x + dx, y + dy, k + dz, seed)]++;
                    pairs[OFFSETS.length][a * 16 + nibble(x, y, k, seed + 1)]++;
                }
        const scores = [z(chi(one, N ** 3), 15), ...pairs.map((p) => z(chi(p, N ** 3), 255))];
        console.log(`  ${scores.map((v) => v.toFixed(1).padStart(5)).join(" ")}`);
    }
}
test("pcg3d, low 4 bits (before)", (x, y, k, s) => pcg3d(x, y, k, s) & 15);
test("pcg3d, top 4 bits", (x, y, k, s) => pcg3d(x, y, k, s) >>> 28);
test("corners, top 4 bits (gwPerlin, the curl's first noise)", (x, y, k, s) => corners(x, y, k, s) >>> 28);
test("corners, bits 22 to 25 (the curl's second)", (x, y, k, s) => (corners(x, y, k, s) >>> 22) & 15);
test("corners, bits 16 to 19 (the curl's third)", (x, y, k, s) => (corners(x, y, k, s) >>> 16) & 15);
const shared = new Float64Array(256);
for (let x = 0; x < N; x++)
    for (let y = 0; y < N; y++)
        for (let k = 0; k < N; k++) {
            const h = corners(x, y, k, 3);
            shared[(h >>> 28) * 16 + ((h >>> 22) & 15)]++;
        }
console.log(
    `corners, the first noise's bits against the second's, of one hash: z ${z(chi(shared, N ** 3), 255).toFixed(1)}`,
);
