import { find } from "../dom";
import { onDemand } from "../frame";

const root = find("#chromaticity");
const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);

/** Wyman, Sloan and Shirley's multi-lobe fit of the CIE 1931 color matching functions. */
const lobe = (w: number, mean: number, below: number, above: number) =>
    Math.exp(-0.5 * ((w - mean) / (w < mean ? below : above)) ** 2);
function matching(w: number) {
    const x = 1.056 * lobe(w, 599.8, 37.9, 31) + 0.362 * lobe(w, 442, 16, 26.7) - 0.065 * lobe(w, 501.1, 20.4, 26.2);
    const y = 0.821 * lobe(w, 568.8, 46.9, 40.5) + 0.286 * lobe(w, 530.9, 16.3, 31.1);
    const z = 1.217 * lobe(w, 437, 11.8, 36) + 0.681 * lobe(w, 459, 26, 13.8);
    return [x / (x + y + z), y / (x + y + z)] as const;
}

const SPACES = [
    {
        name: "sRGB",
        primaries: [
            [0.64, 0.33],
            [0.3, 0.6],
            [0.15, 0.06],
        ],
        dash: "",
    },
    {
        name: "Display P3",
        primaries: [
            [0.68, 0.32],
            [0.265, 0.69],
            [0.15, 0.06],
        ],
        dash: "6 3",
    },
    {
        name: "Rec. 2020",
        primaries: [
            [0.708, 0.292],
            [0.17, 0.797],
            [0.131, 0.046],
        ],
        dash: "2 3",
    },
];
const WHITES: Record<string, [number, number]> = { D65: [0.3127, 0.329], D50: [0.3457, 0.3585], A: [0.4476, 0.4074] };

const SIZE = 520;
const [SX, SY] = [SIZE / 0.8, SIZE / 0.9];
const px = (x: number) => x * SX;
const py = (y: number) => SIZE - y * SY;

/** Linear sRGB of a chromaticity at luminance 1, from the standard's matrix. */
function linearSrgb(x: number, y: number) {
    const [X, Z] = [x / y, (1 - x - y) / y];
    return [
        3.2406 * X - 1.5372 - 0.4986 * Z,
        -0.9689 * X + 1.8758 + 0.0415 * Z,
        0.0557 * X - 0.204 + 1.057 * Z,
    ] as const;
}
const encode = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** Linear Display P3 of the same. */
function linearP3(x: number, y: number) {
    const [X, Z] = [x / y, (1 - x - y) / y];
    return [
        2.4934969 * X - 0.9313836 - 0.4027108 * Z,
        -0.829489 * X + 1.7626641 + 0.0236247 * Z,
        0.0358458 * X - 0.0761724 + 0.9568845 * Z,
    ] as const;
}

/** Whether the screen shows more than sRGB. The canvas then holds P3 values, whichever triangle is filled. */
const WIDE = matchMedia("(color-gamut: p3)").matches;
const colorSpace = WIDE ? "display-p3" : "srgb";

function colors() {
    const canvas = field<HTMLCanvasElement>("canvas");
    Object.assign(canvas, { width: SIZE, height: SIZE });
    const context = canvas.getContext("2d", { colorSpace });
    if (!context) return;
    const fill = root.querySelector<HTMLInputElement>('input[name="chromaticity-fill"]:checked')?.value ?? "sRGB";
    context.clearRect(0, 0, SIZE, SIZE);
    const image = context.createImageData(SIZE, SIZE, { colorSpace });
    for (let j = 0; j < SIZE; ++j) {
        for (let i = 0; i < SIZE; ++i) {
            const [x, y] = [(i + 0.5) / SX, (SIZE - j - 0.5) / SY];
            if (Math.min(...(fill === "P3" ? linearP3(x, y) : linearSrgb(x, y))) < 0) continue;
            const rgb = WIDE ? linearP3(x, y) : linearSrgb(x, y);
            const top = Math.max(...rgb);
            const o = (j * SIZE + i) * 4;
            image.data.set([...rgb.map((c) => encode(c / top) * 255), 255], o);
        }
    }
    context.putImageData(image, 0, 0);
}

/** The CIE 1931 spectral locus at 380, 420, 430, 440, 450, 460 and 470 nm. */
const BLUE_END = [
    [0.1741, 0.005],
    [0.1714, 0.0051],
    [0.1689, 0.0069],
    [0.1644, 0.0109],
    [0.1566, 0.0177],
    [0.144, 0.0297],
    [0.1241, 0.0578],
] as const;

function overlay() {
    const white = root.querySelector<HTMLInputElement>('input[name="chromaticity-white"]:checked')?.value ?? "D65";
    const [wx, wy] = WHITES[white] as [number, number];
    const locus: string[] = [];
    // The fit is good where there is light to fit; up to 470 nm, whose few photons it bends into a hook, the 1931 observer's own table.
    const point = (x: number, y: number) => `${px(x).toFixed(1)},${py(y).toFixed(1)}`;
    for (const [x, y] of BLUE_END) locus.push(point(x, y));
    for (let w = 480; w <= 650; w += 2) {
        const [x, y] = matching(w);
        locus.push(point(x, y));
    }
    locus.push(point(0.7347, 0.2653));
    const labels = [460, 500, 520, 560, 600].map((w) => {
        const [x, y] = matching(w);
        return `<text x="${(px(x) + (w < 510 ? -8 : 8)).toFixed(1)}" y="${(py(y) + 3).toFixed(1)}" text-anchor="${w < 510 ? "end" : "start"}" font-size="11" fill="var(--text)">${w} nm</text>`;
    });
    const triangles = SPACES.map(({ name, primaries, dash }) => {
        const points = primaries.map(([x = 0, y = 0]) => `${px(x).toFixed(1)},${py(y).toFixed(1)}`).join(" ");
        const [gx = 0, gy = 0] = primaries[1] as number[];
        return `<polygon points="${points}" fill="none" stroke="var(--text)" stroke-dasharray="${dash}"/><text x="${(px(gx) + 8).toFixed(1)}" y="${(py(gy) + 4).toFixed(1)}" font-size="11" fill="var(--text)">${name}</text>`;
    });
    field("overlay").innerHTML =
        `<svg viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-label="The spectral locus, three gamuts and the white point">` +
        `<polyline points="${locus.join(" ")} ${locus[0]}" fill="none" stroke="var(--text)"/>${labels.join("")}${triangles.join("")}` +
        `<circle cx="${px(wx).toFixed(1)}" cy="${py(wy).toFixed(1)}" r="5" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>`;
    const rgb = linearSrgb(wx, wy);
    const top = Math.max(...rgb);
    const shown = rgb.map((c) => Math.round(encode(Math.max(c, 0) / top) * 255));
    field("swatch").style.background = `rgb(${shown.join(" ")})`;
    field("info").textContent = `x ${wx}, y ${wy}`;
}

const request = onDemand(overlay, root);
for (const radio of root.querySelectorAll<HTMLInputElement>('input[name="chromaticity-fill"]')) {
    if (radio.value === "P3") {
        radio.disabled = !WIDE;
        radio.checked = WIDE;
        if (!WIDE) (radio.parentElement as HTMLElement).title = "This screen, or browser, shows no more than sRGB";
    } else radio.checked = !WIDE;
    radio.addEventListener("change", colors);
}
colors();
for (const radio of root.querySelectorAll('input[name="chromaticity-white"]'))
    radio.addEventListener("change", request);
request();
