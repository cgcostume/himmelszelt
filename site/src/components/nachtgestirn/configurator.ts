import { moonEV100 } from "@himmelszelt/nachtgestirn";
import { showCode } from "../code";
import { find } from "../dom";
import { display, onDisplay, onTables, gpu as shared, tables } from "../dunstkreis/atmosphere";
import { figureInfo } from "../figure-info";
import { onDemand } from "../frame";
import { ownMoment } from "../sternzeit/lunation";
import { onChange, state } from "../sternzeit/state";
import reference from "./bench.json";
import { type BenchResult, BUDGET_ROWS, frameKey, type Maps } from "./budget-rows";
import { noGpu, orbited } from "./laws";
import { type MoonAt, moonAt, type ToneCurveName } from "./renderer";
import { saveFigure } from "./snapshot";
import { createTiles, type TileFrame } from "./tiles";

const DEG = Math.PI / 180;
// The moment the figure opens at, a waxing crescent six days old, a third lit.
const START = 2461353.79 + 6;

type Technique = "shadows" | "soft" | "displace" | "rays" | "roughness" | "compress";
interface Config {
    maps: Maps;
    /** The whole maps, the far side too, in place of the seen ones. */
    whole: boolean;
    on: Record<Technique, boolean>;
}

// Mebibytes, as Figure 17 counts them.
const MiB = 2 ** 20;
const WIDTHS: Record<Maps, number> = { "512": 512, "1k": 1024, "2k": 2048, "4k": 4096, "8k": 8192 };
const measure = reference as BenchResult;
// The files' sizes in bytes, the seen maps and the whole ones, as Figure 17 measured them, and the roughness map each
// set of maps takes.
const filesOf = (set: "seen" | "whole", maps: Maps) => {
    const files = measure.loads[set][maps];
    return files ? files.color + files.heights : 0;
};
const ROUGHNESS: Record<Maps, "1k" | "2k" | "4k"> = { "512": "1k", "1k": "1k", "2k": "2k", "4k": "4k", "8k": "4k" };
const ROUGHNESS_FILES = {
    seen: { "1k": 513_340, "2k": 1_850_778, "4k": 5_544_714 },
    whole: { "1k": 736_380, "2k": 2_659_164, "4k": 8_026_860 },
};
// The sets the package ships, seen; every other one it makes on request.
const SHIPPED = ["512", "1k"];
const ROUGHNESS_WIDTHS = { "1k": 1024, "2k": 2048, "4k": 4096 };
// The shadow map's memory in MiB as Figure 17 measured it, by the disc's size, and its cap, 4,194,304 texels of 4 bytes.
const SHADOW_MAP: [number, number][] = [
    [162, 0.124],
    [325, 0.496],
    [651, 1.5],
    [1303, 6],
    [2607, 9],
];
const SHADOW_CAP = 16;
// Figure 17's times on an AMD Radeon RX 7900 XT, ms a frame: the defaults and everything on, by the disc's size.
const msOf = (key: string) => measure.frameTimes[key]?.ms.median ?? 0;
const REFERENCE: [disc: number, defaults: number, everything: number][] = BUDGET_ROWS.map(({ disc }) => [
    disc,
    msOf(frameKey(disc, "defaults")),
    msOf(frameKey(disc, "everything")),
]);
// The view the benchmark draws into, a full HD screen.
const BENCH = [1920, 1080] as const;
// Frames to warm the GPU's clocks up, then frames timed: the mean of the middle 80 percent of 1,000 settles to a few
// hundredths of a millisecond, even under timestamps rounded to 0.1 ms.
const WARMUP = 200;
const MEASURED = 1000;

const discOf = (slider: number) => Math.round(8 * 2 ** (slider / 100));

/** What the package's own defaults and thresholds draw a disc `disc` pixels across with, the finest maps `finest`. */
function recommend(disc: number, finest: Maps, whole = false): Config {
    const sizes = (Object.keys(WIDTHS) as Maps[]).filter((m) => WIDTHS[m] <= WIDTHS[finest]);
    const maps = sizes.find((m) => WIDTHS[m] >= Math.PI * disc) ?? finest;
    return {
        maps,
        whole,
        on: {
            shadows: disc >= 128,
            soft: disc >= 128,
            displace: disc >= 1024,
            rays: false,
            roughness: WIDTHS[maps] < Math.PI * disc,
            compress: true,
        },
    };
}

/** The shadow map's memory in MiB for a disc, from Figure 17's measures, by the square of the size below them. */
function shadowMapMB(disc: number) {
    const [first] = SHADOW_MAP;
    if (!first) return 0;
    if (disc <= first[0]) return first[1] * (disc / first[0]) ** 2;
    for (let i = 1; i < SHADOW_MAP.length; i++) {
        const [d0, m0] = SHADOW_MAP[i - 1] ?? first;
        const [d1, m1] = SHADOW_MAP[i] ?? first;
        if (disc <= d1) return m0 * (m1 / m0) ** (Math.log(disc / d0) / Math.log(d1 / d0));
    }
    const [dl, ml] = SHADOW_MAP[SHADOW_MAP.length - 1] ?? first;
    return Math.min(SHADOW_CAP, ml * (disc / dl));
}

/** What a configuration costs: the download, and the GPU memory of each part, in MiB. */
function costs(disc: number, config: Config) {
    const w = WIDTHS[config.maps];
    const texels = (w * w) / 2;
    const rough = ROUGHNESS[config.maps];
    const set = config.whole ? "whole" : "seen";
    const color = (texels * 4 * 4) / 3 / MiB;
    return {
        download: (filesOf(set, config.maps) + (config.on.roughness ? ROUGHNESS_FILES[set][rough] : 0)) / MiB,
        memory: {
            color: config.on.compress ? color / 8 : color,
            relief: (texels * 8 * 4) / 3 / MiB,
            shadowMap: config.on.shadows ? shadowMapMB(disc) : 0,
            roughness: config.on.roughness ? ((ROUGHNESS_WIDTHS[rough] ** 2 / 2) * 4) / MiB : 0,
        },
    };
}

/** The code that makes the pass as configured, against the package's own defaults for a disc that size. */
function snippet(disc: number, config: Config) {
    const options: string[] = ["maps"];
    if (config.on.rays) options.push("samples: 4");
    if (config.on.shadows !== disc >= 128) options.push(`shadowsFrom: ${config.on.shadows ? 0 : "Infinity"}`);
    if (!config.on.soft) options.push("softShadowsFrom: Infinity");
    if (config.on.displace !== disc >= 1024) options.push(`displacementFrom: ${config.on.displace ? 0 : "Infinity"}`);
    const names = ["createMoonPass", "loadMoonMaps", ...(config.on.roughness ? ["loadMoonRoughness"] : [])];
    const suffix = config.whole ? "_WHOLE" : "";
    names.push(
        ...(config.maps === "8k" ? [] : [`MOON_MAPS${suffix}`]),
        ...(config.on.roughness ? [`MOON_ROUGHNESS${suffix}`] : []),
    );
    const seen = config.whole ? "" : "seen-";
    const files =
        config.maps === "8k"
            ? `{ color: "moon-color-${seen}8k.webp", heights: "moon-height-${seen}8k.webp", width: 8192 }`
            : `MOON_MAPS${suffix}["${config.maps}"]`;
    const rough = ROUGHNESS[config.maps];
    const sizes = [...new Set([config.maps, ...(config.on.roughness ? [rough] : [])])];
    const made = config.whole ? sizes : sizes.filter((size) => !SHIPPED.includes(size));
    const build = `npx @himmelszelt/nachtgestirn data maps${config.on.roughness ? " roughness" : ""}${config.whole ? " --whole" : ""} --size ${made.join(",")}`;
    const set = config.whole ? "The whole maps" : "The seen maps";
    const lines = [
        `import { ${names.join(", ")} } from "@himmelszelt/nachtgestirn";`,
        "",
        `// A disc ${disc} px across. ${config.maps === "8k" ? "The 8K maps, yours to host." : made.length ? `${set}: ${build}.` : `${set}, shipped.`}`,
        `const maps = await loadMoonMaps(device, ${files}${config.on.compress ? ", { compress: true }" : ""});`,
        `const pass = await createMoonPass(device, { ${options.join(", ")} });`,
    ];
    if (config.on.roughness) {
        lines.push(
            `const roughness = await loadMoonRoughness(device, MOON_ROUGHNESS${suffix}["${rough}"]);`,
            "pass.setRoughness(roughness);",
            "pass.update({ roughness: true });",
        );
    }
    return lines.join("\n");
}

const fmt = (v: number) => (v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : v.toFixed(0));

/** The configurator on `root`: a disc's size, the switches recommended for it, a preview at one pixel to a pixel, and
 *  what it costs, measured on this GPU on request. */
export function configuratorFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    // How far zoomed, 0 to 900, the disc 8 px to 4,096 px across, a hundred a doubling.
    let level = 635;
    const discValue = find("[data-field=discValue]", root);
    const mapButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-maps]")];
    const setButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-set]")];
    const techButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-tech]")];
    const code = find("[data-field=code]", root);
    let shownCode = "";
    const costsEl = find("[data-field=costs]", root);
    const measureButton = find<HTMLButtonElement>("[data-field=measure]", root);
    const requestRender = onDemand(render, root);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);
    const finest: Maps = (shared.device?.limits.maxTextureDimension2D ?? 0) >= 8192 ? "8k" : "4k";
    if (finest !== "8k") root.querySelector<HTMLButtonElement>('[data-maps="8k"]')?.setAttribute("disabled", "");

    let disc = discOf(level);
    let config = recommend(disc, finest);
    let measured: { ms: number; spread: [number, number]; gpu: boolean } | null = null;

    function show() {
        discValue.textContent = `${disc.toLocaleString("en-US")} px across`;
        const recommended = recommend(disc, finest);
        for (const b of mapButtons) {
            b.setAttribute("aria-pressed", String(b.dataset.maps === config.maps));
            b.toggleAttribute("data-recommended", b.dataset.maps === recommended.maps);
        }
        for (const b of setButtons)
            b.setAttribute("aria-pressed", String((b.dataset.set === "whole") === config.whole));
        for (const b of techButtons) {
            const t = b.dataset.tech as Technique;
            b.setAttribute("aria-pressed", String(config.on[t]));
            b.toggleAttribute("data-differs", config.on[t] !== recommended.on[t]);
        }
        shownCode = snippet(disc, config);
        showCode(code, shownCode);
        drawCosts();
        requestRender();
    }

    function drawCosts() {
        const { download, memory } = costs(disc, config);
        const total = memory.color + memory.relief + memory.shadowMap + memory.roughness;
        const near = REFERENCE.reduce((a, b) =>
            Math.abs(Math.log(b[0] / disc)) < Math.abs(Math.log(a[0] / disc)) ? b : a,
        );
        const msAxis = 1.6 * Math.max(0.6, near[2], near[1], measured?.ms ?? 0);
        const bar = (value: number, axis: number, cls: string, title: string) =>
            `<i class="budget-bar ${cls}" style="width: ${((100 * value) / axis).toFixed(3)}%" title="${title}"></i>`;
        const line = (bars: string, value: string, label = "") =>
            `<span class="budget-line">${bars}<span class="budget-value">${value}${label ? ` <span class="config-label">${label}</span>` : ""}</span></span>`;
        const parts = (
            [
                ["color", memory.color, 0],
                ["relief", memory.relief, 1],
                ["shadow map", memory.shadowMap, 2],
                ["roughness", memory.roughness, 3],
            ] as const
        )
            .filter(([, v]) => v > 0)
            .map(([name, v, i]) => bar(v, 600, `budget-part-${i}`, `${name}: ${fmt(v)} MiB`))
            .join("");
        costsEl.innerHTML = [
            `<span class="config-cost-name note">download, MiB</span>`,
            `<span class="budget-cell" style="--grid: ${100 / 6}%">${line(bar(download, 60, "budget-part-0", `${fmt(download)} MiB`), fmt(download))}</span>`,
            `<span class="config-cost-name note">GPU memory, MiB</span>`,
            `<span class="budget-cell" style="--grid: ${100 / 6}%">${line(parts, fmt(total))}</span>`,
            `<span class="config-cost-name note">time a frame, ms</span>`,
            `<span class="budget-cell" style="--grid: ${(25 / msAxis).toFixed(3)}%">${[
                line(
                    bar(near[1], msAxis, "budget-defaults", "the defaults"),
                    fmt(near[1]),
                    `${near[0].toLocaleString("en-US")} px`,
                ),
                line(bar(near[2], msAxis, "", "everything on"), fmt(near[2]), `${near[0].toLocaleString("en-US")} px`),
                // This GPU's line held empty until measured, so the measure changes no layout.
                line(bar(measured?.ms ?? 0, msAxis, "budget-part-0", "this GPU"), measured ? fmt(measured.ms) : "–"),
            ].join("")}</span>`,
        ].join("");
    }

    // The preview: the disc at its size, one pixel to a pixel, the view drifting to the terminator's middle as it grows.
    let seen: Record<string, unknown> = {};
    function frameOf(m: MoonAt): TileFrame {
        return {
            moon: m,
            luts: tables()?.luts as NonNullable<ReturnType<typeof tables>>["luts"],
            toneMap: display.toneCurve as ToneCurveName,
            maps: config.maps,
            seen: !config.whole,
            ev100: moonEV100(m.phaseAngle, m.lit),
            albedo: true,
            relief: true,
            shadows: config.on.shadows,
            roughness: config.on.roughness,
            earthshine: true,
            eclipse: false,
            law: "hapke2012",
            darkAdapted: false,
            samples: config.on.rays ? 4 : 1,
            terminatorSamples: 4,
            shadowsFrom: config.on.shadows ? 0 : Number.POSITIVE_INFINITY,
            softShadowsFrom: config.on.soft ? 0 : Number.POSITIVE_INFINITY,
            displacementFrom: config.on.displace ? 0 : Number.POSITIVE_INFINITY,
        };
    }
    // The view as Figure 1 has it: dragging turns the Moon, with shift held it moves the view, the wheel zooms, which
    // is the disc's size, the point under the cursor staying under it; a double click goes back. x and y in disc radii.
    const view = { yaw: 0, pitch: 0, x: 0, y: 0 };
    const moment = ownMoment(root, START, requestRender);
    function moonOf(model: Parameters<typeof moonAt>[2]): MoonAt {
        const real = moonAt(moment.jd(), { ...state, geocentric: true }, model);
        return view.yaw === 0 && view.pitch === 0 ? real : orbited(real, view.yaw, view.pitch);
    }
    const offsetOf = (m: MoonAt) => [(view.x * m.geocentricDiameter) / 2, (view.y * m.geocentricDiameter) / 2] as const;
    // The preview's width and height in disc radii.
    const across = () => {
        const box = canvas.parentElement ?? canvas;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        return [
            (2 * box.clientWidth * ratio) / disc,
            (2 * (box.clientHeight || box.clientWidth) * ratio) / disc,
        ] as const;
    };
    const keepInView = () => {
        const [w, h] = across();
        view.x = Math.max(-(w * 0.35 + 1), Math.min(w * 0.35 + 1, view.x));
        view.y = Math.max(-(h * 0.35 + 1), Math.min(h * 0.35 + 1, view.y));
    };
    // The lock, pressed while the Moon shows the face Earth sees, as in Figure 1: a press turns it back, turning lets go.
    const lock = find("[data-field=lock]", root);
    lock.addEventListener("click", () => {
        Object.assign(view, { yaw: 0, pitch: 0 });
        lock.setAttribute("aria-pressed", "true");
        requestRender();
    });
    let dragging: { x: number; y: number } | null = null;
    canvas.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragging = { x: event.clientX, y: event.clientY };
        canvas.setPointerCapture(event.pointerId);
        canvas.classList.add("dragging");
    });
    canvas.addEventListener("pointermove", (event) => {
        if (!dragging) return;
        // A radian per disc radius on screen: the ground under the cursor follows it, whatever the zoom.
        const perPx = across()[0] / (canvas.clientWidth || 1);
        if (event.shiftKey) {
            view.x -= (event.clientX - dragging.x) * perPx;
            view.y += (event.clientY - dragging.y) * perPx;
            keepInView();
        } else {
            // Turned as if the disc filled the view at least, so a small one turns no faster than a large one.
            const turnPx = Math.min(
                perPx,
                2 / Math.min(canvas.clientWidth || 1, canvas.clientHeight || canvas.clientWidth || 1),
            );
            if (event.clientX !== dragging.x || event.clientY !== dragging.y)
                lock.setAttribute("aria-pressed", "false");
            view.yaw += (event.clientX - dragging.x) * turnPx;
            view.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, view.pitch + (event.clientY - dragging.y) * turnPx));
        }
        dragging = { x: event.clientX, y: event.clientY };
        requestRender();
    });
    const release = () => {
        dragging = null;
        canvas.classList.remove("dragging");
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener(
        "wheel",
        (event) => {
            event.preventDefault();
            const box = canvas.getBoundingClientRect();
            const cx = (event.clientX - box.left) / box.width - 0.5;
            const cy = 0.5 - (event.clientY - box.top) / box.height;
            const before = across();
            level = Math.min(900, Math.max(0, level - event.deltaY * 0.2));
            sized();
            const after = across();
            view.x += cx * (before[0] - after[0]);
            view.y += cy * (before[1] - after[1]);
            keepInView();
            requestRender();
        },
        { passive: false },
    );
    canvas.addEventListener("dblclick", () => {
        Object.assign(view, { yaw: 0, pitch: 0, x: 0, y: 0 });
        lock.setAttribute("aria-pressed", "true");
        requestRender();
    });
    function render() {
        const table = tables();
        if (!table || !tiles) return;
        const m = moonOf(table.luts.model);
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.round((canvas.parentElement?.clientWidth || 600) * ratio);
        const height = Math.round((canvas.parentElement?.clientHeight || 360) * ratio);
        const degreesAcross = (m.geocentricDiameter * width) / disc;
        const offset = offsetOf(m);
        tiles.draw({ count: 1, width, height, degreesAcross }, () => ({ ...frameOf(m), offset }));
        seen = { view: { ...view }, phaseAngle: m.phaseAngle, lit: m.lit, previewPx: [width, height], degreesAcross };
    }

    async function measure() {
        const table = tables();
        if (!table || !tiles) return;
        measureButton.disabled = true;
        measureButton.style.setProperty("--progress", "0");
        measureButton.toggleAttribute("data-measuring", true);
        const m = moonOf(table.luts.model);
        // The progress bar: a tenth to warm up, eight tenths measured, a tenth to sum up.
        const result = await tiles.measure(
            BENCH[0],
            BENCH[1],
            (m.geocentricDiameter * BENCH[0]) / disc,
            { ...frameOf(m), offset: offsetOf(m) },
            (phase, done) => {
                const [from, span] = phase === "warmup" ? [0, 0.1] : phase === "measure" ? [0.1, 0.8] : [0.9, 0.1];
                measureButton.style.setProperty("--progress", (from + span * done).toFixed(3));
            },
            WARMUP,
            MEASURED,
        );
        measureButton.disabled = false;
        measureButton.removeAttribute("data-measuring");

        if (result) measured = result;
        drawCosts();
        requestRender();
    }

    function sized() {
        disc = discOf(level);
        config = recommend(disc, finest, config.whole);
        show();
    }
    for (const b of mapButtons)
        b.addEventListener("click", () => {
            config = { ...config, maps: b.dataset.maps as Maps };
            show();
        });
    for (const b of setButtons)
        b.addEventListener("click", () => {
            config = { ...config, whole: b.dataset.set === "whole" };
            show();
        });
    for (const b of techButtons)
        b.addEventListener("click", () => {
            const t = b.dataset.tech as Technique;
            config = { ...config, on: { ...config.on, [t]: !config.on[t] } };
            show();
        });
    find("[data-field=recommended]", root).addEventListener("click", () => {
        config = recommend(disc, finest, config.whole);
        show();
    });
    find("[data-field=copyCode]", root).addEventListener("click", async (event) => {
        const button = event.currentTarget as HTMLElement;
        try {
            await navigator.clipboard.writeText(`${shownCode}\n`);
            button.toggleAttribute("data-copied", true);
            setTimeout(() => button.removeAttribute("data-copied"), 1500);
        } catch {
            button.title = "Copying failed, this browser did not allow it";
        }
    });
    measureButton.addEventListener("click", measure);
    if (!tiles) measureButton.disabled = true;

    find("[data-field=download]", root).addEventListener("click", () => saveFigure(root, canvas, render));
    figureInfo(root, () => ({
        discPixels: disc,
        config,
        recommended: recommend(disc, finest),
        costs: costs(disc, config),
        measured: measured && {
            ms: measured.ms,
            p10p90: measured.spread,
            timestamps: measured.gpu,
            view: BENCH,
            warmup: WARMUP,
            frames: MEASURED,
        },
        preview: seen,
        code: snippet(disc, config),
    }));
    onChange(requestRender);
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(canvas.parentElement ?? root);
    show();
}
