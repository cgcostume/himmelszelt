import {
    type AtmosphereLUTs,
    createIrradiancePass,
    createSkyPass,
    type IrradiancePass,
    precomputeAtmosphere,
    type SkyCubePass,
    type SkyPass,
    spectrumToRgb,
} from "@himmelszelt/dunstkreis";
import { find } from "../dom";
import { onDemand } from "../frame";
import { drawSvg, escapeText, svgText } from "../sternzeit/figure";
import {
    currentSky,
    environment,
    gpu,
    gpuDevice,
    needEnvironment,
    onEnvironment,
    onSkyView,
    onTables,
    quality,
    type Sky,
    tables,
} from "./atmosphere";
import { type PreviewOptions, renderPixels, SCALE, TABLE_PREVIEW } from "./preview";

// Four pieces, four clocks: every texture and buffer dunstkreis computes, laned by what makes it run again, with its
// size, its memory, a thumbnail of what it holds, and its cost measured on this GPU.

type Piece = "tables" | "skyView" | "aerial" | "cube" | "ibl" | "sky";
/** What the renderer asks for: a live sky rather than a static one, a cube map written once; the sky's indirect light,
 *  the Sun's direct light, and aerial perspective. */
type Asked = "live" | "indirect" | "direct" | "aerial";

/** What runs for what is asked: once at startup, or again on each occasion. The direct light comes with the sky view. */
function runs(): Piece[] {
    const pieces: Piece[] = ["tables", "skyView"];
    if (asked.live) pieces.push("sky");
    if (asked.indirect || !asked.live) pieces.push("cube");
    if (asked.indirect) pieces.push("ibl");
    if (asked.aerial) pieces.push("aerial");
    return pieces;
}

// What the chapter states for a desktop GPU, shown only where this page cannot measure.
const TYPICAL: Record<Piece, number> = {
    tables: 0.6,
    skyView: 0.25,
    aerial: Number.NaN,
    cube: Number.NaN,
    ibl: Number.NaN,
    sky: 0.05,
};
// The sky pass is timed into a full HD target; the aerial perspective volume at its default shape.
const FULL_HD = [1920, 1080] as const;
const FROXELS = 32;
const BUSY_MS = 15;
const MAX_REPEAT = 512;

const root = find("#clocks");
const svgEl = find<SVGSVGElement>(".clocks-panel > svg", root);
const measuredEl = find('[data-field="measured"]', root);
const requestRender = onDemand(render, svgEl);

const asked: Record<Asked, boolean> = { live: true, indirect: true, direct: true, aerial: false };
let costs: Partial<Record<Piece, number>> = {};
let measuring = false;
let measuredFor = "";

const KiB = 1024;
const memory = (bytes: number) =>
    bytes >= KiB * KiB ? `${(bytes / KiB / KiB).toFixed(1)} MiB` : `${Math.round(bytes / KiB)} KiB`;
const ms = (value: number | undefined) =>
    value === undefined || Number.isNaN(value)
        ? "…"
        : value < 0.1
          ? `${value.toFixed(3)} ms`
          : `${value.toFixed(2)} ms`;
// A cube map of half floats with every mip level down to one texel.
const cubeBytes = (size: number) => {
    let texels = 0;
    for (let edge = size; edge >= 1; edge >>= 1) texels += edge * edge;
    return 6 * 8 * texels;
};
// The light meter's buffer: its reading, its 4096 samples of a vec2f, and the horizon's bend per sky-view row.
const meterBytes = (rows: number) => 64 + 4096 * 8 + 4 * rows;

interface Box {
    id: Piece | "frame" | "multi" | "coefficients";
    piece?: Piece;
    lane: number;
    column: number;
    name: string[];
    lines: string[];
    title: string;
    yours?: boolean;
}

function boxes(): Box[] {
    const { transmittance: t, multiScattering: m, skyView: v } = quality.config;
    const [cube, irradiance] = [environment.size, environment.irradianceSize];
    return [
        {
            id: "tables",
            piece: "tables",
            lane: 0,
            column: 0,
            name: ["Transmittance"],
            lines: [`${t.width}×${t.height}`, memory(t.width * t.height * 8)],
            title:
                "How much of the light crosses the air from any height in any direction to the top of the atmosphere. " +
                "Computed from the model alone, read by every pass after it.",
        },
        {
            id: "multi",
            piece: "tables",
            lane: 0,
            column: 1,
            name: ["Multiple", "scattering"],
            lines: [`${m.width}×${m.height}`, memory(m.width * m.height * 8)],
            title:
                "The light scattered more than once, the whole infinite sum, by height and the Sun's altitude. " +
                "Computed from the model and the transmittance, read by every pass after it.",
        },
        {
            id: "skyView",
            piece: "skyView",
            lane: 1,
            column: 0,
            name: ["Sky view", "+ light meter"],
            lines: [`${v.width}×${v.height}`, memory(v.width * v.height * 8 + meterBytes(v.height))],
            title:
                "The whole sky from where the observer stands, and the meter's reading of it: the exposure, the " +
                "sunlight, the horizon. Computed from both tables, the Sun and the height, read by the sky pass and the cube map.",
        },
        {
            id: "cube",
            piece: "cube",
            lane: 1,
            column: 1,
            name: ["Cube map"],
            lines: [`6×${cube}², mips`, memory(cubeBytes(cube))],
            title:
                "The sky in every direction, with mip levels, to light a scene and reflect in it. Computed like the " +
                "sky pass, from the sky view and the tables, read by your shading and by the coefficients.",
        },
        {
            id: "coefficients",
            piece: "ibl",
            lane: 1,
            column: 2,
            name: ["Coefficients", "+ irradiance"],
            lines: [`9 + 6×${irradiance}²`, memory(9 * 16 + cubeBytes(irradiance))],
            title:
                "Nine spherical harmonics coefficients of the cube map, and the irradiance for every normal from them. " +
                "Computed from the cube map, read by your shading.",
        },
        {
            id: "aerial",
            piece: "aerial",
            lane: 2,
            column: 2,
            name: ["Aerial", "perspective"],
            lines: [`2×${FROXELS}³`, memory(2 * FROXELS ** 3 * 8)],
            title:
                "The light the air adds and lets through in front of the camera, out to 32 km, as a volume. Computed " +
                "from the tables, the Sun and the camera, read by your shading.",
        },
        {
            id: "sky",
            piece: "sky",
            lane: 2,
            column: 0,
            name: ["Sky pass"],
            lines: ["one lookup", "per pixel"],
            title:
                "The sky for the camera, one lookup into the sky view per pixel, exposed by the meter and tone mapped " +
                "or not. Writes into your target.",
        },
        {
            id: "frame",
            lane: 2,
            column: 1,
            name: ["Your frame"],
            lines: ["target, shading"],
            title: "Yours: the target the sky pass writes into, and the shading that reads the cube map, the coefficients and the volume.",
            yours: true,
        },
    ];
}

const LANES = [
    { clock: "Per atmosphere", trigger: "or its sizes" },
    { clock: "Per Sun move", trigger: "or height move" },
    { clock: "Per frame", trigger: "and per camera move" },
];
/** The pieces a lane's clock sums: the volume has its own clock, and shows its cost by itself. */
const LANE_PIECES: Piece[][] = [["tables"], ["skyView", "cube", "ibl"], ["sky"]];

/**
 * What each occasion costs for what is asked, at startup, when the Sun moves, when the camera does, every frame; null
 * where nothing runs on it.
 */
function sums() {
    const running = runs();
    const sum = (pieces: Piece[]) => {
        const some = pieces.filter((piece) => running.includes(piece));
        return some.length ? some.reduce((total, piece) => total + (costs[piece] ?? Number.NaN), 0) : null;
    };
    const startup = sum(running) ?? 0;
    const sun = asked.live ? sum(["skyView", "cube", "ibl", "aerial"]) : sum(["aerial"]);
    return { startup, sun, camera: sum(["aerial"]), frame: sum(["sky"]) };
}

const f = (n: number) => n.toFixed(1);

function arrow(points: [number, number][], active: boolean) {
    const d = points.map(([x, y], i) => `${i ? "L" : "M"}${f(x)} ${f(y)}`).join(" ");
    return `<path d="${d}" class="clocks-arrow${active ? " active" : ""}" marker-end="url(#clocks-head${active ? "-active" : ""})"/>`;
}

function renderDataflow(width: number) {
    // Each lane's clock heads it, so three columns fit the reading column, and roughly a phone.
    const gap = 14;
    const columnWidth = (width - 2 * gap) / 3;
    // A square thumbnail over the text; a pass without a texture is an empty square of the same size.
    const inset = 6;
    const thumbWidth = Math.min(columnWidth - 2 * inset, 96);
    // A name and its sizes on one line each where the column is wide enough, on two where not.
    const joined = columnWidth >= 160;
    const textHeight = joined ? 52 : 80;
    const fullHeight = textHeight + thumbWidth + inset;
    // The second lane's head leaves room for the rule's arrows into it; every lane, for the routes under its boxes.
    const headers = [22, 38, 22];
    const laneHeights = headers.map((header) => header + fullHeight + 42);
    const laneTop = (lane: number) => laneHeights.slice(0, lane).reduce((sum, h) => sum + h, 0);
    const height = laneTop(LANES.length);
    const running = runs();
    const x = (column: number) => column * (columnWidth + gap);
    const all = boxes();
    const at = (id: Box["id"]) => all.find((box) => box.id === id) as Box;
    const on = (box: Box) => (box.piece ? running.includes(box.piece) : true);
    const hasThumb = (box: Box) => THUMBS.includes(box.id as Thumb);
    // What an arrow starts from or ends at: the thumbnail, or the text's extent where there is none.
    const body = (box: Box) => ({
        x: x(box.column) + (columnWidth - thumbWidth) / 2,
        y: laneTop(box.lane) + (headers[box.lane] ?? 0) + 14 + inset,
        w: thumbWidth,
        h: thumbWidth,
    });

    let svg = `<defs><pattern id="clocks-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" class="clocks-hatch-line"/></pattern>${["", "-active"].map((suffix) => `<marker id="clocks-head${suffix}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1L10 5L0 9z" class="clocks-head${suffix}"/></marker>`).join("")}</defs>`;
    let labels = "";
    LANES.forEach((lane, i) => {
        const y0 = laneTop(i);
        if (i % 2 === 0)
            svg += `<rect x="0" y="${y0}" width="${width}" height="${laneHeights[i]}" class="clocks-lane"/>`;
        const pieces = LANE_PIECES[i] as Piece[];
        const some = pieces.filter((piece) => running.includes(piece));
        const cost = some.length ? some.reduce((sum, piece) => sum + (costs[piece] ?? Number.NaN), 0) : null;
        const once = !asked.live && i === 1 && some.length;
        const clock = once ? "Once" : lane.clock;
        const timing = cost === null ? "" : ms(cost);
        // Drawn over the arrows, each on a halo of its lane's color, which the arrows pass under.
        const halo = ` clocks-halo${i % 2 === 0 ? " on-surface" : ""}`;
        const text = `${clock}${lane.trigger && !once ? ` ${lane.trigger}` : ""}`;
        const costSpan = timing && ` <tspan class="figure-label clocks-cost">${timing}</tspan>`;
        labels += `<text x="6" y="${y0 + (headers[i] ?? 0) - 7}" class="figure-note figure-anchor-start${halo}">${escapeText(text)}${costSpan}</text>`;
    });

    // The routes: across the gaps between thumbnails, and straight down from the sky view to the sky pass and from the
    // cube map to your frame. The meter's sunlight branches off the sky view's route, the coefficients come down and
    // over, the volume comes in from the right.
    const [tb, mb, sb, cb, kb, ab, yb, fb] = [
        "tables",
        "multi",
        "skyView",
        "cube",
        "coefficients",
        "aerial",
        "sky",
        "frame",
    ].map((id) => body(at(id as Box["id"]))) as ReturnType<typeof body>[];
    const pad = 3;
    const centerX = (b: typeof tb) => b.x + b.w / 2;
    const centerY = (b: typeof tb) => b.y + b.h / 2;
    // A route leaves downward under the text, not through it.
    const under = (b: typeof tb) => b.y + b.h + textHeight + pad;
    const across = (from: typeof tb, to: typeof tb, active: boolean) =>
        arrow(
            [
                [from.x + from.w + pad, centerY(from)],
                [to.x - pad, centerY(to)],
            ],
            active,
        );
    const line = (points: [number, number][], active: boolean) =>
        `<path d="${points.map(([px, py], i) => `${i ? "L" : "M"}${f(px)} ${f(py)}`).join(" ")}" class="clocks-arrow${active ? " active" : ""}"/>`;
    svg += across(tb, mb, on(at("multi")));
    svg += across(sb, cb, on(at("cube")));
    svg += across(cb, kb, on(at("coefficients")));
    // The row under the second lane's boxes, where the sunlight and the coefficients turn toward your frame.
    const below = laneTop(2) - 14;
    svg += line(
        [
            [centerX(sb), under(sb)],
            [centerX(sb), below],
        ],
        on(at("sky")) || asked.direct,
    );
    svg += arrow(
        [
            [centerX(sb), below],
            [centerX(sb), yb.y - pad],
        ],
        on(at("sky")),
    );
    svg += arrow(
        [
            [centerX(sb), below],
            [centerX(fb) - 20, below],
            [centerX(fb) - 20, fb.y - pad],
        ],
        asked.direct,
    );
    svg += arrow(
        [
            [centerX(cb), under(cb)],
            [centerX(cb), fb.y - pad],
        ],
        on(at("cube")) && (asked.indirect || !asked.live),
    );
    svg += arrow(
        [
            [centerX(kb), under(kb)],
            [centerX(kb), below],
            [centerX(fb) + 20, below],
            [centerX(fb) + 20, fb.y - pad],
        ],
        on(at("coefficients")),
    );
    svg += across(yb, fb, on(at("sky")));
    svg += arrow(
        [
            [ab.x - pad, centerY(ab)],
            [fb.x + fb.w + pad, centerY(ab)],
        ],
        on(at("aerial")),
    );
    // Both tables feed every piece below them: a rule under their lane says so once, with an arrow into each column.
    const ruleY = laneTop(1) - 1;
    svg += `<line x1="0" y1="${ruleY}" x2="${width}" y2="${ruleY}" class="clocks-rule"/>`;
    for (const column of [0, 1, 2])
        svg += arrow(
            [
                [x(column) + columnWidth / 2, ruleY],
                [x(column) + columnWidth / 2, ruleY + 14],
            ],
            true,
        );
    svg += svgText(
        width - 6,
        ruleY - 9,
        "both tables, read by every pass below but the coefficients",
        "figure-label figure-anchor-end",
    );

    svg += labels;
    for (const box of all) {
        const b = body(box);
        const cls = `clocks-box${on(box) ? " active" : ""}${box.yours ? " yours" : ""}`;
        svg += `<g class="${cls}"><title>${escapeText(box.title)}</title>`;
        if (!hasThumb(box))
            svg += `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" rx="4" class="clocks-frame"/>`;
        const lines = joined
            ? [
                  [box.name.join(" "), "clocks-name"],
                  [box.lines.join(box.id === "sky" ? " " : ", "), "clocks-size"],
              ]
            : [...box.name.map((text) => [text, "clocks-name"]), ...box.lines.map((text) => [text, "clocks-size"])];
        // The pieces with a clock of their own among others show their cost themselves.
        if (box.piece && box.piece !== "tables" && box.piece !== "sky")
            lines.push([ms(costs[box.piece]), "clocks-cost"]);
        const textX = x(box.column) + columnWidth / 2;
        const textY = b.y + b.h + textHeight / 2;
        if (hasThumb(box)) {
            const size = `x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}"`;
            svg += `<clipPath id="clocks-clip-${box.id}"><rect ${size} rx="4"/></clipPath>`;
            svg += `<rect ${size} rx="4" class="clocks-thumb"/>`;
            const url = thumbs[box.id as Thumb];
            const pixelated = box.id === "aerial" ? " pixelated" : "";
            if (url)
                svg += `<image ${size} href="${url}" preserveAspectRatio="none" clip-path="url(#clocks-clip-${box.id})" class="clocks-image${pixelated}"/>`;
            if (!on(box)) svg += `<rect ${size} rx="4" class="clocks-hatched"/>`;
        }
        const step = 14;
        const first = textY - ((lines.length - 1) * step) / 2;
        lines.forEach(([text, cls], i) => {
            svg += svgText(textX, first + i * step, text ?? "", `figure-note ${cls}`);
        });
        svg += "</g>";
    }
    return { svg, height };
}

// The thumbnails, as image URLs: what each texture holds, mapped for display as the tables and the cube maps figures
// map it, read from the page's own textures whenever they change, while the figure is near the screen.
type Thumb = "tables" | "multi" | "skyView" | "cube" | "coefficients" | "aerial";
const THUMBS: Thumb[] = ["tables", "multi", "skyView", "cube", "coefficients", "aerial"];
const THUMB = { width: 128, height: 64 };
const thumbs: Partial<Record<Thumb, string>> = {};

function imageUrl(pixels: Uint8ClampedArray<ArrayBuffer>, width: number, height: number) {
    const canvas = Object.assign(document.createElement("canvas"), { width, height });
    canvas.getContext("2d")?.putImageData(new ImageData(pixels, width, height), 0, 0);
    return canvas.toDataURL();
}

async function thumbnail(name: Thumb, texture: GPUTexture | null | undefined, options: PreviewOptions) {
    if (!texture) return;
    const pixels = await renderPixels(texture, options, THUMB.width, THUMB.height);
    thumbs[name] = imageUrl(pixels as Uint8ClampedArray<ArrayBuffer>, THUMB.width, THUMB.height);
    requestRender();
}

function showTables() {
    const luts = tables()?.luts;
    thumbnail("tables", luts?.transmittance, { ...TABLE_PREVIEW.transmittance, filter: "linear" });
    thumbnail("multi", luts?.multiScattering, { ...TABLE_PREVIEW.multiScattering, filter: "linear" });
}

function showEnvironment() {
    const { cube, ibl, cubified = false } = environment;
    // The cube map from the mip level about as fine as the thumbnail, four faces across it.
    const level = cube ? Math.max(0, Math.round(Math.log2((4 * cube.width) / THUMB.width))) : 0;
    const panorama = { cube: true, filter: "linear", scale: SCALE.mean } as const;
    thumbnail("cube", cube, { ...panorama, level, cubified });
    thumbnail("coefficients", ibl?.irradiance, panorama);
}

// The page draws no aerial perspective of its own sky: a pass of the figure's own builds the volume from the page's
// tables, Sun and height, for a camera looking at the horizon under the Sun, 90 degrees high and twice as wide.
let aerialPass: SkyPass | null = null;
let aerialFor: AtmosphereLUTs | null = null;
// Its last slice, 32 km out.
const SLICES = [FROXELS - 1];

/** A half float's value from its 16 bits. */
function half(bits: number) {
    const [sign, exponent, mantissa] = [bits & 0x8000 ? -1 : 1, (bits >> 10) & 31, bits & 1023];
    if (exponent === 0) return sign * mantissa * 2 ** -24;
    if (exponent === 31) return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY;
    return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

async function showAerial(sky: Sky) {
    const luts = tables()?.luts;
    if (!luts) return;
    const device = gpuDevice();
    if (aerialFor !== luts) {
        aerialFor = luts;
        const next = await createSkyPass(device, { luts, format: "rgba8unorm", aerialPerspective: true });
        if (aerialFor !== luts) return next.destroy();
        aerialPass?.destroy();
        aerialPass = next;
    }
    const pass = aerialPass;
    const volume = pass?.aerialPerspective;
    if (!pass || !volume) return;
    const [sx, sy] = sky.sunDirection;
    const yaw = Math.atan2(sx, sy);
    const [forward, right] = [
        [Math.sin(yaw), Math.cos(yaw), 0],
        [2 * Math.cos(yaw), -2 * Math.sin(yaw), 0],
    ];
    const camera = new Float32Array([...right, 0, 0, 0, 1, 0, 0, 0, 0, 1, ...forward, 0]);
    const encoder = device.createCommandEncoder({ label: "sternwarte:clocksAerial" });
    pass.update(
        { sunDirection: sky.sunDirection, observerHeightM: sky.observerHeightM, inverseViewProjection: camera },
        encoder,
    );
    // One row of 32 texels of four half floats is 256 bytes, as a copy's rows must be.
    const sliceBytes = FROXELS * FROXELS * 8;
    const readback = device.createBuffer({
        size: SLICES.length * sliceBytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    SLICES.forEach((z, i) => {
        encoder.copyTextureToBuffer(
            { texture: volume.luminance, origin: [0, 0, z] },
            { buffer: readback, offset: i * sliceBytes, bytesPerRow: FROXELS * 8, rowsPerImage: FROXELS },
            [FROXELS, FROXELS, 1],
        );
    });
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const bits = new Uint16Array(readback.getMappedRange().slice(0));
    readback.destroy();
    // The four wavelengths into linear RGB by the model's matrix, scaled so the brightest froxel is white.
    const matrix = spectrumToRgb(luts.model);
    const width = SLICES.length * FROXELS;
    const rgb = new Float32Array(width * FROXELS * 3);
    let top = 1e-30;
    for (let i = 0; i < SLICES.length; ++i) {
        for (let y = 0; y < FROXELS; ++y) {
            for (let x = 0; x < FROXELS; ++x) {
                const texel = ((i * FROXELS + y) * FROXELS + x) * 4;
                const light = [0, 1, 2, 3].map((c) => half(bits[texel + c] ?? 0));
                const pixel = (y * width + i * FROXELS + x) * 3;
                for (let c = 0; c < 3; ++c) {
                    const row = matrix[c] ?? [];
                    const value = Math.max(
                        0,
                        light.reduce((sum, l, j) => sum + l * (row[j] ?? 0), 0),
                    );
                    rgb[pixel + c] = value;
                    top = Math.max(top, value);
                }
            }
        }
    }
    const encode = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
    const pixels = new Uint8ClampedArray(width * FROXELS * 4);
    for (let p = 0; p < width * FROXELS; ++p) {
        for (let c = 0; c < 3; ++c) pixels[p * 4 + c] = encode(Math.min((rgb[p * 3 + c] ?? 0) / top, 1));
        pixels[p * 4 + 3] = 255;
    }
    thumbs.aerial = imageUrl(pixels, width, FROXELS);
    requestRender();
}

function showSky(sky: Sky | null) {
    if (!sky) return;
    thumbnail("skyView", sky.pass.skyViewTexture, { ...TABLE_PREVIEW.skyView, filter: "linear" });
    showAerial(sky);
}

function render() {
    const width = svgEl.clientWidth || 700;
    const { svg, height } = renderDataflow(width);
    svgEl.style.height = `${height}px`;
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    drawSvg(svgEl, svg, 1);
    showSums();
}

function showSums() {
    const { startup, sun, camera, frame } = sums();
    const parts = [`at the start ${ms(startup)}`];
    if (sun !== null) parts.push(`when the Sun moves ${ms(sun)}`);
    if (camera !== null) parts.push(`when the camera moves ${ms(camera)}`);
    parts.push(frame !== null ? `every frame ${ms(frame)}` : "every frame nothing, a lookup in your shading");
    const where = gpu.error
        ? "Typical of a desktop GPU, not measured here."
        : measuring
          ? `Measuring on ${gpu.adapterName}…`
          : `Measured on ${gpu.adapterName}, the sky pass at ${FULL_HD.join("×")}.`;
    measuredEl.textContent = `${parts.join(" · ")}. ${where}`;
}

type Recorder = (n: number) => Promise<{ buffers: GPUCommandBuffer[]; dispose?: () => void }>;

/**
 * The GPU time of one repetition of what `record` records n times over, from submission to done, less an empty
 * submission's: the queue reports back only every few milliseconds, so the work is repeated until it takes far longer
 * than that, and the median of three rounds kept.
 */
async function timeGpu(device: GPUDevice, record: Recorder) {
    const submit = async (n: number) => {
        const { buffers, dispose } = await record(n);
        const started = performance.now();
        device.queue.submit(buffers);
        await device.queue.onSubmittedWorkDone();
        const elapsed = performance.now() - started;
        dispose?.();
        return elapsed;
    };
    const run = async (n: number) => {
        const empty = await submit(0);
        return Math.max((await submit(n)) - empty, 0);
    };
    await submit(1);
    let times = 2;
    while (times < MAX_REPEAT && (await run(times)) < BUSY_MS) times *= 2;
    const rounds: number[] = [];
    for (let round = 0; round < 3; ++round) rounds.push((await run(times)) / times);
    return rounds.sort((x, y) => x - y)[1] as number;
}

/** Records `encode` n times into one command buffer, counted across calls, so no two in a row are the same work. */
function encoding(device: GPUDevice, encode: (encoder: GPUCommandEncoder, call: number) => void): Recorder {
    let calls = 0;
    return async (n) => {
        const encoder = device.createCommandEncoder({ label: "sternwarte:clocks" });
        for (let i = 0; i < n; ++i) encode(encoder, calls++);
        return { buffers: [encoder.finish()] };
    };
}

/** The tables' precomputation n times over, its submissions held back by a device that only collects them. */
function precomputing(device: GPUDevice, luts: AtmosphereLUTs): Recorder {
    return async (n) => {
        const buffers: GPUCommandBuffer[] = [];
        const queue = {
            submit: (more: GPUCommandBuffer[]) => buffers.push(...more),
            writeBuffer: device.queue.writeBuffer.bind(device.queue),
        };
        const collecting = new Proxy(device, {
            get: (target, name) => {
                if (name === "queue") return queue;
                const value = Reflect.get(target, name, target);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        const made: AtmosphereLUTs[] = [];
        for (let i = 0; i < n; ++i)
            made.push(await precomputeAtmosphere(collecting, { model: luts.model, config: luts.config }));
        return {
            buffers,
            dispose: () => {
                for (const tables of made) tables.destroy();
            },
        };
    };
}

// A Sun a little higher each time, so every update rebuilds the sky view.
const sunAt = (i: number): [number, number, number] => {
    const altitude = (10 + (i % 20)) * (Math.PI / 180);
    return [0, Math.cos(altitude), Math.sin(altitude)];
};
// A camera turned a little each time, so every update rebuilds the volume.
function cameraAt(i: number) {
    const [c, s] = [Math.cos(i * 0.01), Math.sin(i * 0.01)];
    return new Float32Array([c, s, 0, 0, 0, 0, 1, 0, s, -c, 0, 1, 0, 1, 0, 0]);
}

async function measure() {
    const current = tables();
    if (!current || measuring || gpu.error) return;
    const device = gpuDevice();
    const key = `${JSON.stringify(quality.config)},${quality.model},${quality.refraction},${environment.size},${environment.irradianceSize}`;
    if (key === measuredFor) return;
    measuring = true;
    costs = {};
    requestRender();
    const { luts } = current;
    const passes: { destroy(): void }[] = [];
    let target: GPUTexture | null = null;
    let cube: GPUTexture | null = null;
    try {
        costs.tables = await timeGpu(device, precomputing(device, luts));
        requestRender();

        const sky: SkyPass = await createSkyPass(device, { luts, format: "rgba8unorm", autoExposure: true });
        passes.push(sky);
        costs.skyView = await timeGpu(
            device,
            encoding(device, (encoder, i) => sky.update({ sunDirection: sunAt(i), observerHeightM: 10 }, encoder)),
        );
        requestRender();

        target = device.createTexture({
            label: "sternwarte:clocksTarget",
            size: [...FULL_HD],
            format: "rgba8unorm",
            usage: GPUTextureUsage.STORAGE_BINDING,
        });
        const output = target;
        costs.sky = await timeGpu(
            device,
            encoding(device, (encoder) => sky.encode(encoder, output)),
        );
        requestRender();

        // As the page builds its environment: eight samples per texel, every mip level, and the irradiance from it.
        const { size, irradianceSize } = environment;
        cube = device.createTexture({
            label: "sternwarte:clocksCube",
            size: { width: size, height: size, depthOrArrayLayers: 6 },
            mipLevelCount: Math.floor(Math.log2(size)) + 1,
            format: "rgba16float",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            textureBindingViewDimension: "cube",
        });
        const cubeTarget = cube;
        const cubePass: SkyCubePass = await sky.createCubePass({ format: "rgba16float", samples: 8 });
        const ibl: IrradiancePass = await createIrradiancePass(device, { size: irradianceSize });
        passes.push(ibl);
        costs.cube = await timeGpu(
            device,
            encoding(device, (encoder) => cubePass.encode(encoder, cubeTarget)),
        );
        costs.ibl = await timeGpu(
            device,
            encoding(device, (encoder) => ibl.encode(encoder, cubeTarget)),
        );
        requestRender();

        const aerial = await createSkyPass(device, { luts, format: "rgba8unorm", aerialPerspective: true });
        passes.push(aerial);
        aerial.update({ sunDirection: sunAt(0), observerHeightM: 10 });
        costs.aerial = await timeGpu(
            device,
            encoding(device, (encoder, i) => aerial.update({ inverseViewProjection: cameraAt(i + 1) }, encoder)),
        );
    } finally {
        // Kept even after a failure, so a pass that cannot be built is not tried over and over.
        measuredFor = key;
        for (const pass of passes) pass.destroy();
        target?.destroy();
        cube?.destroy();
        measuring = false;
        requestRender();
    }
    // The sizes may have changed while it ran.
    if (near) measure();
}

if (gpu.error) costs = { ...TYPICAL };

// Measured once the figure is near the screen, and again whenever the tables or the cube map change size.
let near = false;
new IntersectionObserver(
    ([entry]) => {
        const was = near;
        near = entry?.isIntersecting ?? false;
        if (!near || was) return;
        measure();
        // Whatever changed while the figure was away.
        showTables();
        showSky(currentSky());
        showEnvironment();
    },
    { rootMargin: "50% 0px" },
).observe(root);
onTables(() => {
    requestRender();
    if (!near) return;
    measure();
    showTables();
});
onSkyView((sky) => {
    if (near) showSky(sky);
});
onEnvironment(() => {
    requestRender();
    if (!near) return;
    measure();
    showEnvironment();
});
needEnvironment(root);

for (const input of root.querySelectorAll<HTMLInputElement>('input[name="clocks-asked"]')) {
    input.addEventListener("change", () => {
        asked[input.value as Asked] = input.checked;
        requestRender();
    });
}
for (const input of root.querySelectorAll<HTMLInputElement>('input[name="clocks-sky"]')) {
    input.addEventListener("change", () => {
        asked.live = input.value === "live";
        requestRender();
    });
}
new ResizeObserver(() => requestRender()).observe(svgEl);
