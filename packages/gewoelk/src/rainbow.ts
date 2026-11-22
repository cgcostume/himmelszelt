/**
 * Rainbows: what raindrops send of the sun's light into every scattering angle, as a table. A drop reflects light off
 * its outside, lets it through, and sends it back after one reflection inside, the primary bow, or two, the secondary.
 * Each of the two has a least deviation, at which its light piles up: there Airy's theory takes the place of the rays,
 * with the supernumerary bows it brings, and joins them again farther in. Per wavelength, over drops of many sizes and
 * over the sun's disc. Angles in degrees, directions unit vectors, x east, y north, z up.
 */

const DEG = Math.PI / 180;

/** The rain a bow stands in, the sun that lights it, and how finely the table holds it. */
export interface Rainbow {
    /** The drops' mean radius in mm, each drop counted by the cross-section it shows: 0.5 for a shower of 5 mm/h. */
    dropRadiusMm: number;
    /** The standard deviation of the radii as a share of the mean, on a gamma distribution: 0 for drops of one size. */
    spread: number;
    /** The sun's diameter in degrees, by which the bow is blurred: 0 for a point. */
    sunDiameter: number;
    /** Texels over the table's range. */
    texels: number;
}

/**
 * A shower's drops under the sun: half a millimeter, their sizes as widely spread as rain's are, between Marshall and
 * Palmer's 0.58 and the 0.4 of a narrower gamma distribution, at an eighth of a degree per texel.
 */
export const DEFAULT_RAINBOW: Rainbow = { dropRadiusMm: 0.5, spread: 0.5, sunDiameter: 0.53, texels: 1440 };

/** The scattering angles at the table's left and right edges, as `GW_RAINBOW_FROM` and `GW_RAINBOW_TO` in WGSL. */
export const RAINBOW_FROM = 0;
export const RAINBOW_TO = 180;

/** A table of the rain's phase function over the scattering angle, one row of rgba texels. */
export interface RainbowTable {
    /** Per texel the phase for red, green and blue in linear sRGB and for luminance, each per steradian. */
    data: Float32Array;
    width: number;
    /** The scattering angles at the row's left and right edges: a texel's center lies half a texel in. */
    from: number;
    to: number;
}

// Daimon and Masumura's (2007) Sellmeier terms for distilled water at 20 °C against vacuum, wavelengths in µm.
const WATER_SELLMEIER = [
    [5.684027565e-1, 5.101829712e-3],
    [1.726177391e-1, 1.821153936e-2],
    [2.086189578e-2, 2.620722293e-2],
    [1.130748688e-1, 1.069792721e1],
] as const;

/** The refractive index of water at 20 °C against air at a wavelength in nm: 1.3330 in sodium's yellow light. */
export function waterIndex(wavelengthNm: number): number {
    const l2 = (wavelengthNm / 1000) ** 2;
    return Math.sqrt(WATER_SELLMEIER.reduce((sum, [a, b]) => sum + (a * l2) / (l2 - b), 1)) / 1.00028;
}

/**
 * The ray of least deviation after `chords` paths through a drop of index `n`, Descartes' ray: its angle of incidence
 * and its scattering angle in radians, and how fast the deviation turns there, its second derivative by the incidence.
 */
function descartesRay(n: number, chords: number) {
    const incidence = Math.acos(Math.sqrt((n * n - 1) / (chords * chords - 1)));
    const theta = scatteringAngle(n, chords, incidence);
    return { incidence, theta, turn: (2 * Math.tan(incidence) * (chords * chords - 1)) / (chords * chords) };
}

/** The scattering angle in radians of a ray after 2 or 3 chords: its deviation, folded into 0 to π. */
function scatteringAngle(n: number, chords: number, incidence: number): number {
    const refracted = Math.asin(Math.sin(incidence) / n);
    return chords === 2 ? Math.PI + 2 * incidence - 4 * refracted : 6 * refracted - 2 * incidence;
}

/**
 * Where a bow stands, in degrees from the antisolar point, by its ray of least deviation: the primary, `order` 1, at
 * 42.3° in red and 40.6° in violet, the secondary at 50.4° and 53.5°. The brightest light lies a little to the lit side.
 */
export function bowRadius(order: 1 | 2 = 1, wavelengthNm = 550): number {
    return 180 - descartesRay(waterIndex(wavelengthNm), order + 1).theta / DEG;
}

/** The angle between a view ray and the antisolar point, for the sun's direction: 180° less the scattering angle. */
export function antisolarAngle(direction: readonly number[], sunDirection: readonly number[]): number {
    const dot = direction.reduce((sum, d, i) => sum - d * (sunDirection[i] ?? 0), 0);
    return Math.acos(Math.min(Math.max(dot, -1), 1)) / DEG;
}

/** How high a bow's top stands over the horizon for a sun at `sunElevation`: under it, no bow from the ground. */
export const bowTop = (sunElevation: number, order: 1 | 2 = 1) => bowRadius(order) - sunElevation;

/**
 * The direction `radius` degrees from the antisolar point and `around` degrees about it, from the top of that circle
 * clockwise as seen: a point on a bow of that radius. With the sun in the zenith, the top is the north.
 */
export function bowDirection(sunDirection: readonly number[], radius: number, around = 0): [number, number, number] {
    const [x = 0, y = 0, z = 0] = sunDirection;
    const length = Math.hypot(x, y, z);
    const [ax, ay, az] = [-x / length, -y / length, -z / length];
    const level = Math.hypot(ax, ay);
    // The way up from the antisolar point along the sphere, and the way to its right.
    const [tx, ty, tz] = level > 1e-9 ? [(-az * ax) / level, (-az * ay) / level, level] : [0, 1, 0];
    const [rx, ry, rz] = [ay * tz - az * ty, az * tx - ax * tz, ax * ty - ay * tx];
    const [c, s] = [Math.cos(radius * DEG), Math.sin(radius * DEG)];
    const [up, across] = [s * Math.cos(around * DEG), s * Math.sin(around * DEG)];
    return [c * ax + up * tx + across * rx, c * ay + up * ty + across * ry, c * az + up * tz + across * rz];
}

/**
 * Rain's extinction per km at `rate` mm/h, by Marshall and Palmer's (1948) drop sizes: the drops' cross-sections alone,
 * as the table counts them. The light a drop diffracts, as much again, stays so near the beam that it counts as passed.
 */
export const rainExtinction = (rate: number) => 0.18 * rate ** 0.63;

/** The drops' mean radius in mm at `rate` mm/h, each counted by its cross-section, by Marshall and Palmer's sizes. */
export const rainDropRadius = (rate: number) => 0.37 * rate ** 0.21;

/** Airy's function Ai: its series within 6 of zero, its asymptotic expansions beyond (Abramowitz and Stegun 10.4). */
function airy(x: number): number {
    if (Math.abs(x) <= 6) {
        const cube = x * x * x;
        let [f, g, tf, tg] = [1, x, 1, x];
        for (let k = 0; k < 48; ++k) {
            tf *= cube / ((3 * k + 2) * (3 * k + 3));
            tg *= cube / ((3 * k + 3) * (3 * k + 4));
            f += tf;
            g += tg;
        }
        return 0.355028053887817 * f - 0.258819403792807 * g;
    }
    const zeta = (2 / 3) * Math.abs(x) ** 1.5;
    const t = 1 / zeta;
    const [c1, c2, c3, c4] = [5 / 72, 385 / 10368, 85085 / 2239488, 37182145 / 644972544];
    if (x > 0) {
        const series = 1 - t * (c1 - t * (c2 - t * (c3 - t * c4)));
        return (Math.exp(-zeta) * series) / (2 * Math.sqrt(Math.PI) * x ** 0.25);
    }
    const [even, odd] = [1 - t * t * (c2 - t * t * c4), t * (c1 - t * t * c3)];
    const phase = zeta + Math.PI / 4;
    return (Math.sin(phase) * even - Math.cos(phase) * odd) / (Math.sqrt(Math.PI) * (-x) ** 0.25);
}

// Where the mean bow's table starts on the dark side and how finely it steps, in Airy's argument.
const DARK = -12;
const STEP = 0.02;

/**
 * Airy's bow as drops of many sizes draw it together: the mean of ∛(a/ā) Ai²(-z (a/ā)^⅔) over the radii a, tabulated
 * over z, the argument a drop of the mean radius ā has, from `DARK` on. A drop's fringes are as fine as it is large, so
 * the sizes' fringes fall apart with z and leave their mean, 1 / (2π √z), which is the light of the two rays without
 * their interference. Past `reach`, fringes finer than the table could hold, the mean stands alone.
 */
function meanBow(spread: number, reach: number): Float64Array {
    const table = new Float64Array(Math.ceil((reach - DARK) / STEP) + 1);
    const shape = spread > 0 ? 1 / (spread * spread) : 0;
    const [low, high] = [Math.max(1 - 5 * spread, 0.02), 1 + 7 * spread];
    for (let i = 0; i < table.length; ++i) {
        const z = DARK + i * STEP;
        const mean = z > 0 ? 1 / (2 * Math.PI * Math.sqrt(z)) : 0;
        // The phase between the two rays, 4/3 z^(3/2), grows as the radius, and its fringes fade as the gamma
        // distribution's characteristic function does.
        const frequency = (4 / 3) * Math.max(z, 0) ** 1.5;
        const fringes = shape > 0 ? (1 + (frequency / shape) ** 2) ** (-shape / 2) : 1;
        if (z > 2 && fringes < 1e-5) {
            table[i] = mean;
            continue;
        }
        let [sum, weights] = [0, 0];
        const count = shape > 0 ? Math.ceil(Math.max(48, ((high - low) * frequency) / 0.4)) : 1;
        for (let k = 0; k < count; ++k) {
            const a = shape > 0 ? low + ((k + 0.5) / count) * (high - low) : 1;
            const weight = Math.exp((shape - 1) * Math.log(a) - shape * (a - 1));
            sum += weight * Math.cbrt(a) * airy(-z * Math.cbrt(a * a)) ** 2;
            weights += weight;
        }
        const t = Math.min(Math.max((z - 0.7 * reach) / (0.3 * reach), 0), 1);
        table[i] = mean + (sum / weights - mean) * (1 - t * t * (3 - 2 * t));
    }
    return table;
}

/** The share of a ray's light that leaves the drop after `chords` paths through it, 0 for the reflection outside. */
function leaving(n: number, chords: number, cosI: number, cosR: number): number {
    const across = ((cosI - n * cosR) / (cosI + n * cosR)) ** 2;
    const along = ((n * cosI - cosR) / (n * cosI + cosR)) ** 2;
    if (chords === 0) return (across + along) / 2;
    return ((1 - across) ** 2 * across ** (chords - 1) + (1 - along) ** 2 * along ** (chords - 1)) / 2;
}

const BRANCH_NODES = 160;

/**
 * One of a bow's two families of rays, from Descartes' ray to a grazing one or to one through the drop's middle, `end`:
 * its phase function times s, s² the scattering angle's distance from the bow, over s in `BRANCH_NODES` even steps up
 * to the returned `reach`. Alone the phase function has a pole at the bow, times s it has none.
 */
function rayBranch(n: number, chords: number, ray: ReturnType<typeof descartesRay>, end: number) {
    const [distances, values] = [new Float64Array(BRANCH_NODES), new Float64Array(BRANCH_NODES)];
    for (let k = 0; k < BRANCH_NODES; ++k) {
        const incidence = ray.incidence + (k / (BRANCH_NODES - 1)) * (end - ray.incidence);
        const [sinI, cosI] = [Math.sin(incidence), Math.max(Math.cos(incidence), 0)];
        const cosR = Math.sqrt(1 - (sinI / n) ** 2);
        const theta = scatteringAngle(n, chords, incidence);
        const s = Math.sqrt(Math.abs(theta - ray.theta));
        const rate = Math.abs(2 - (2 * chords * cosI) / (n * cosR));
        // Through the drop's middle the ray's ring and the ring it lights shrink alike.
        const rings = sinI > 1e-6 ? sinI / Math.sin(theta) : 1 / rate;
        distances[k] = s;
        values[k] =
            k === 0
                ? (leaving(n, chords, cosI, cosR) * sinI * cosI) / (Math.PI * Math.sin(theta) * Math.sqrt(2 * ray.turn))
                : (leaving(n, chords, cosI, cosR) * rings * cosI * s) / (Math.PI * rate);
    }
    const reach = distances[BRANCH_NODES - 1] as number;
    const even = new Float64Array(BRANCH_NODES);
    for (let u = 0, k = 0; u < BRANCH_NODES; ++u) {
        const s = (u / (BRANCH_NODES - 1)) * reach;
        while (k < BRANCH_NODES - 2 && (distances[k + 1] as number) < s) ++k;
        const f =
            (s - (distances[k] as number)) / Math.max((distances[k + 1] as number) - (distances[k] as number), 1e-12);
        even[u] = (values[k] as number) + ((values[k + 1] as number) - (values[k] as number)) * Math.min(f, 1);
    }
    return { even, reach };
}

function lookup(table: Float64Array, x: number): number {
    const i = Math.min(Math.max(Math.floor(x), 0), table.length - 2);
    return (table[i] as number) + ((table[i + 1] as number) - (table[i] as number)) * Math.min(Math.max(x - i, 0), 1);
}

/** What a drop reflects off its outside and what it lets straight through, per steradian, at `theta` radians. */
function plainRays(n: number, theta: number): number {
    const half = (Math.PI - theta) / 2;
    const [sinH, cosH] = [Math.sin(half), Math.cos(half)];
    let phase = leaving(n, 0, cosH, Math.sqrt(1 - (sinH / n) ** 2)) / (4 * Math.PI);
    // Light let through leaves within twice the angle a grazing ray is bent by, 83° off the sun.
    if (n * sinH > 1) {
        const incidence = Math.atan2(n * cosH, n * sinH - 1);
        const [sinI, cosI] = [Math.sin(incidence), Math.cos(incidence)];
        const cosR = Math.sqrt(1 - (sinI / n) ** 2);
        phase += (leaving(n, 1, cosI, cosR) * sinI * cosI) / (Math.PI * Math.sin(theta) * 2 * (1 - cosI / (n * cosR)));
    }
    return phase;
}

/** CIE 1931 2° color matching functions, x̄ ȳ z̄, by the multi-lobe fit of Wyman, Sloan and Shirley (2013). */
function colorMatching(wavelength: number): [number, number, number] {
    const g = (mean: number, below: number, above: number) =>
        Math.exp(-0.5 * ((wavelength - mean) / (wavelength < mean ? below : above)) ** 2);
    return [
        1.056 * g(599.8, 37.9, 31.0) + 0.362 * g(442.0, 16.0, 26.7) - 0.065 * g(501.1, 20.4, 26.2),
        0.821 * g(568.8, 46.9, 40.5) + 0.286 * g(530.9, 16.3, 31.1),
        1.217 * g(437.0, 11.8, 36.0) + 0.681 * g(459.0, 26.0, 13.8),
    ];
}

const XYZ_TO_LINEAR_SRGB = [
    [3.2404542, -1.5371385, -0.4985314],
    [-0.969266, 1.8760108, 0.041556],
    [0.0556434, -0.2040259, 1.0572252],
] as const;

/**
 * The wavelengths the table is summed over, 380 to 720 nm every 5, each with what it adds to red, green and blue in
 * linear sRGB and to luminance under a black body of the sun's 5772 K: every column sums to 1, so the sun itself is 1,
 * 1, 1 and a drop that scatters every wavelength alike has one phase function in every channel.
 */
function spectrum(): { wavelength: number; weights: [number, number, number, number] }[] {
    const samples: { wavelength: number; weights: [number, number, number, number] }[] = [];
    const sums = [0, 0, 0, 0];
    for (let wavelength = 380; wavelength <= 720; wavelength += 5) {
        const sun = wavelength ** -5 / (Math.exp(1.438777e7 / (wavelength * 5772)) - 1);
        const [x, y, z] = colorMatching(wavelength);
        const rgb = XYZ_TO_LINEAR_SRGB.map(([a, b, c]) => (a * x + b * y + c * z) * sun);
        const weights = [rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0, y * sun] as [number, number, number, number];
        weights.forEach((w, c) => {
            sums[c] = (sums[c] as number) + w;
        });
        samples.push({ wavelength, weights });
    }
    for (const { weights } of samples)
        for (let c = 0; c < 4; ++c) weights[c] = (weights[c] as number) / (sums[c] as number);
    return samples;
}

// Points per texel the bows are computed at before the sun's disc blurs them.
const FINE = 5;

/**
 * The sun's disc of `radius` fine points as it blurs a bow: every chord of the disc shifts the bow by its distance
 * from the middle. A texel's own width is laid over it, so no fringe finer than the table falls between its texels.
 */
function discKernel(radius: number): Float64Array {
    const half = Math.ceil(radius) + FINE;
    const kernel = new Float64Array(2 * half + 1);
    let sum = 0;
    for (let i = -half; i <= half; ++i) {
        for (let j = 1 - FINE; j < FINE; ++j) {
            const chord = Math.abs(i - j) < radius ? Math.sqrt(1 - ((i - j) / radius) ** 2) : i === j ? 1 : 0;
            kernel[i + half] = (kernel[i + half] as number) + chord * (FINE - Math.abs(j));
        }
        sum += kernel[i + half] as number;
    }
    return kernel.map((k) => k / sum);
}

/**
 * The rain's phase function over the scattering angle, per steradian in red, green, blue and luminance: the light
 * reflected off the drops, let through them, and sent back after one and two reflections inside, the two bows by Airy's
 * theory. Times the sun's illuminance and the rain's optical depth along a ray, where that is thin, the rain's light in
 * cd/m²; the optical depth counts the drops' cross-sections, see `rainExtinction`. The four orders hold 99.7 % of what
 * a drop scatters; colors no screen shows are drawn towards gray at their luminance.
 */
export function rainbowTable(options: Partial<Rainbow> = {}): RainbowTable {
    const { dropRadiusMm, spread, sunDiameter, texels } = { ...DEFAULT_RAINBOW, ...options };
    const step = ((RAINBOW_TO - RAINBOW_FROM) / texels) * DEG;
    const fine = step / FINE;
    const kernel = discKernel(((sunDiameter / 2) * DEG) / fine);
    const pad = (kernel.length - 1) / 2;
    const nodes = (texels - 1) * FINE + kernel.length;
    const samples = spectrum().map((sample) => ({ ...sample, n: waterIndex(sample.wavelength) }));
    const sizeAt = (wavelength: number) => (2 * Math.PI * dropRadiusMm * 1e6) / wavelength;
    // How fast Airy's argument grows with the angle from the bow, per radian.
    const pace = (ray: ReturnType<typeof descartesRay>, size: number) =>
        Math.cbrt((2 * size * size * Math.cos(ray.incidence) ** 2) / ray.turn);
    // Fringes are held as far as a fine point in four still follows them, in the bluest light.
    const bluest = pace(descartesRay(waterIndex(380), 2), sizeAt(380));
    const reach = Math.min(Math.max((Math.PI / (4 * fine * bluest)) ** 2, 4), 48);
    const mean = meanBow(spread, reach);
    const bows = new Float64Array(nodes * 4);
    for (const { wavelength, weights, n } of samples) {
        for (const chords of [2, 3]) {
            const ray = descartesRay(n, chords);
            const q = pace(ray, sizeAt(wavelength));
            const branches = [rayBranch(n, chords, ray, 0), rayBranch(n, chords, ray, Math.PI / 2)];
            for (let j = 0; j < nodes; ++j) {
                const angle = RAINBOW_FROM * DEG + step / 2 + (j - pad) * fine;
                const theta = angle < 0 ? -angle : angle > Math.PI ? 2 * Math.PI - angle : angle;
                // The primary's light lies inside its bow, the secondary's outside.
                const lit = chords === 2 ? theta - ray.theta : ray.theta - theta;
                const z = q * lit;
                if (z <= DARK) continue;
                const s = Math.sqrt(Math.max(lit, 0));
                let rays = 0;
                for (const { even, reach: end } of branches)
                    if (s <= end) rays += lookup(even, (s / end) * (BRANCH_NODES - 1));
                const fringed = z < reach ? lookup(mean, (z - DARK) / STEP) : 1 / (2 * Math.PI * Math.sqrt(z));
                const phase = 2 * Math.PI * Math.sqrt(q) * fringed * rays;
                for (let c = 0; c < 4; ++c)
                    bows[j * 4 + c] = (bows[j * 4 + c] as number) + (weights[c] as number) * phase;
            }
        }
    }
    const data = new Float32Array(texels * 4);
    for (let k = 0; k < texels; ++k) {
        const texel = [0, 0, 0, 0];
        for (let m = 0; m < kernel.length; ++m)
            for (let c = 0; c < 4; ++c)
                texel[c] = (texel[c] as number) + (kernel[m] as number) * (bows[(k * FINE + m) * 4 + c] as number);
        const theta = RAINBOW_FROM * DEG + (k + 0.5) * step;
        for (const { weights, n } of samples) {
            const phase = plainRays(n, theta);
            for (let c = 0; c < 4; ++c) texel[c] = (texel[c] as number) + (weights[c] as number) * phase;
        }
        const [r = 0, g = 0, b = 0, luminance = 0] = texel;
        const least = Math.min(r, g, b);
        const kept = least < 0 ? luminance / (luminance - least) : 1;
        data.set(
            [
                luminance + (r - luminance) * kept,
                luminance + (g - luminance) * kept,
                luminance + (b - luminance) * kept,
                luminance,
            ],
            k * 4,
        );
    }
    return { data, width: texels, from: RAINBOW_FROM, to: RAINBOW_TO };
}

/** The table at a scattering `angle` in degrees, between its texels as `gwRainbowPhase` in `wgsl.rainbow` reads it. */
export function rainbowPhase(table: RainbowTable, angle: number): [number, number, number, number] {
    const x = ((angle - table.from) / (table.to - table.from)) * table.width - 0.5;
    const i = Math.min(Math.max(Math.floor(x), 0), table.width - 2);
    const f = Math.min(Math.max(x - i, 0), 1);
    const at = (c: number) => (table.data[i * 4 + c] as number) * (1 - f) + (table.data[i * 4 + 4 + c] as number) * f;
    return [at(0), at(1), at(2), at(3)];
}
