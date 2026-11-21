// What the budget figure measures: one row per configuration of the stars pass, the same list for the figure, for the
// reader's own run and for `scripts/stars-budget.mjs`, which writes the reference into budget-reference.json.

/** One configuration: what the pass gets, what it draws, and the target it draws into. */
export interface BudgetRow {
    /** The key of its measures in budget-reference.json, and of its bars in the figure. */
    id: string;
    /** What the row adds to the one before, and a note under it. */
    label: string;
    note: string;
    width: number;
    height: number;
    /** The Hipparcos stars besides the catalog's. */
    faintStars: boolean;
    /** The Tycho-2 stars besides both, which the package makes but does not ship: where their file is missing, the
     *  row is left out of a run. */
    deepStars?: boolean;
    milkyWay: "small" | "large" | null;
    halo: boolean;
    air: boolean;
    twinkle: boolean;
    constellations: boolean;
    /** The stars a tile holds: the pass' 64, and 256 with the faint stars, as the chapter's sky has it. */
    capacity: number;
    /** Shown among the target sizes too. */
    bySize?: boolean;
    /** The catalogs in their full layouts, as the data has them, in place of the compact ones the package loads by
     *  default. */
    full?: boolean;
}

const HD = { width: 1920, height: 1080 };
const CATALOG = {
    ...HD,
    faintStars: false,
    milkyWay: null,
    halo: false,
    air: false,
    twinkle: false,
    constellations: false,
    capacity: 64,
} as const;
// The sky the chapter opens with: both catalogs, the halos, the 2K map, the air.
const SKY = { ...CATALOG, halo: true, faintStars: true, capacity: 256, milkyWay: "small", air: true } as const;

/** The configurations at 1920 by 1080, each adding to the one before, then the chapter's sky at other sizes, and with
 *  the deep stars. */
export const BUDGET_ROWS: readonly BudgetRow[] = [
    { id: "catalog", label: "the catalog alone", note: "9,093 stars as points", ...CATALOG },
    { id: "halo", label: "with halos", note: "the light past the knee", ...CATALOG, halo: true },
    {
        id: "faint",
        label: "with the faint stars",
        note: "108,883 more, 256 a tile",
        ...CATALOG,
        halo: true,
        faintStars: true,
        capacity: 256,
    },
    { id: "milkyway", label: "with the Milky Way", note: "the 2K map", ...SKY, air: false },
    { id: "air", label: "through the air", note: "lifted, dimmed, reddened", ...SKY, bySize: true },
    { id: "twinkle", label: "twinkling", note: "a factor per star and channel", ...SKY, twinkle: true },
    {
        id: "lines",
        label: "with the constellations",
        note: "743 lines, all 88",
        ...SKY,
        twinkle: true,
        constellations: true,
    },
    {
        id: "large",
        label: "with the 4K map",
        note: "in place of the 2K",
        ...SKY,
        twinkle: true,
        constellations: true,
        milkyWay: "large",
    },
    { id: "720p", label: "1280 × 720", note: "", ...SKY, width: 1280, height: 720 },
    { id: "1440p", label: "2560 × 1440", note: "", ...SKY, width: 2560, height: 1440 },
    { id: "2160p", label: "3840 × 2160", note: "", ...SKY, width: 3840, height: 2160 },
    { id: "deep", label: "with the deep stars", note: "2.4 million more", ...SKY, deepStars: true },
    { id: "catalog-full", label: "the catalog alone", note: "32 bytes a star", ...CATALOG, full: true },
    {
        id: "faint-full",
        label: "with the faint stars",
        note: "8 bytes a star",
        ...CATALOG,
        halo: true,
        faintStars: true,
        capacity: 256,
        full: true,
    },
    { id: "deep-full", label: "with the deep stars", note: "8 bytes a star", ...SKY, deepStars: true, full: true },
];

/** The rows by what is drawn, the chapter's sky by the target's size, smallest first, and with the deep stars. */
const atHD = (row: BudgetRow) => row.width === HD.width && row.height === HD.height;
const compact = BUDGET_ROWS.filter((row) => !row.full);
export const BY_CONFIGURATION = compact.filter((row) => atHD(row) && !row.deepStars);
export const BY_SIZE = compact
    .filter((row) => (row.bySize || !atHD(row)) && !row.deepStars)
    .sort((a, b) => a.width * a.height - b.width * b.height);
export const DEEP = compact.filter((row) => row.deepStars);
export const FULL = BUDGET_ROWS.filter((row) => row.full);

/** What holds the GPU memory, by the labels of the pass' buffers and textures after "sternenheer:". */
export const MEMORY_PARTS = {
    stars: [
        "catalog",
        "faintStars",
        "faintColors",
        "splats",
        "params",
        "deepStars",
        "deepBlocks",
        "deepParams",
        "deepSums",
        "noDeepSums",
    ],
    lines: ["lines", "linePieces"],
    tiles: ["tileCounts", "tileEntries", "lineCounts", "lineEntries"],
    halos: ["haloSums", "haloDown", "haloUp", "haloSteps"],
    map: ["milkyway"],
} as const;

/** The files a row downloads, by what they hold. */
export type FileName =
    | "catalog"
    | "faintStars"
    | "deepStars"
    | "catalogFull"
    | "faintStarsFull"
    | "deepStarsFull"
    | "constellations"
    | "small"
    | "large";
export const filesOf = (row: BudgetRow): FileName[] => [
    row.full ? "catalogFull" : "catalog",
    ...(row.faintStars ? ([row.full ? "faintStarsFull" : "faintStars"] as const) : []),
    ...(row.deepStars ? ([row.full ? "deepStarsFull" : "deepStars"] as const) : []),
    ...(row.constellations ? (["constellations"] as const) : []),
    ...(row.milkyWay ? [row.milkyWay] : []),
];

/** A row's measures: milliseconds a frame, per pass and from the first pass' start to the last one's end, the medians
 *  over the rounds and the frame's 10th and 90th percentiles; and the bytes its pass holds on the GPU, by label. */
export interface RowMeasure {
    passes: Record<string, number>;
    frame: number;
    spread: { p10: number; p90: number };
    memory?: Record<string, number>;
}

/** A run of the benchmark: where, how, and each row's measures by its id. */
export interface BudgetMeasure {
    gpu: string;
    /** Whether the GPU's clock timed the passes, and whether the browser rounded it; without a clock, a
     *  frame's time is from submitting to done, and not split by pass. */
    timestamps: boolean;
    quantized: boolean;
    /** The step of a rounded clock, in milliseconds. */
    quantum?: number;
    rounds: number;
    frames: number;
    rows: Record<string, RowMeasure>;
    /** The shipped files' sizes in bytes. */
    files?: Partial<Record<FileName, number>>;
    browser?: string;
    date?: string;
}

/** An axis for values up to `max`: its end, a little past the longest bar, so the bar's value fits in its panel, and
 *  the step of its grid, some `steps` of them. */
export function axisFor(max: number, room = 1.15, steps = 6): { end: number; step: number } {
    const rough = (max * room) / steps;
    const power = 10 ** Math.floor(Math.log10(rough));
    const step = ([1, 2, 2.5, 5, 10].find((nice) => nice * power >= rough) ?? 10) * power;
    return { end: Math.ceil((max * room) / step - 1e-9) * step, step };
}
/** The numbers along an axis. */
export const ticksOf = ({ end, step }: { end: number; step: number }) =>
    Array.from({ length: Math.round(end / step) + 1 }, (_, i) => Math.round(i * step * 1e4) / 1e4);

/** A frame's time in the bar's parts: the passes that ran, in their order, and the rest of the frame with the last. */
export function timeParts({ passes, frame }: RowMeasure): [name: string, ms: number][] {
    const ran = Object.entries(passes).filter(([, ms]) => ms > 0);
    const rest = Math.max(0, frame - ran.reduce((sum, [, ms]) => sum + ms, 0));
    if (ran.length === 0) return [["frame", frame]];
    return ran.map(([name, ms], i) => [name, i === ran.length - 1 ? ms + rest : ms]);
}

/** The bytes a pass holds, summed into the bar's parts; a label the list does not know counts with the stars. */
export function memoryParts(memory: Record<string, number>): Record<keyof typeof MEMORY_PARTS, number> {
    const parts = { stars: 0, lines: 0, tiles: 0, halos: 0, map: 0 };
    for (const [label, bytes] of Object.entries(memory)) {
        const part = (Object.keys(MEMORY_PARTS) as (keyof typeof MEMORY_PARTS)[]).find((name) =>
            (MEMORY_PARTS[name] as readonly string[]).includes(label),
        );
        parts[part ?? "stars"] += bytes;
    }
    return parts;
}

/** Milliseconds and mebibytes as the bars' values show them. */
export const formatMs = (ms: number) => (ms < 1 ? ms.toFixed(2) : ms < 10 ? ms.toFixed(1) : ms.toFixed(0));
export const formatMiB = (mib: number) => (mib < 10 ? mib.toFixed(1) : mib.toFixed(0));
