import { MiB } from "../costs";
import { find } from "../dom";
import { paintRange, snapMark } from "../range";
import { type Cost, costOf, type Format, type Scenario, STORAGES, type Storage, upperHalf } from "./storage-math";

const root = find("#storage");
const grid = find("[data-field=grid]", root);
const width = find<HTMLInputElement>("[data-field=width]", root);
const count = find<HTMLInputElement>("[data-field=count]", root);

/** The families, a row per variant under the name of a family of several. */
const FAMILIES: [string, Storage[]][] = [
    ["equirectangular", ["equirectangular", "upperEquirectangular"]],
    ["cube map", ["cube", "hemicube", "cubified", "cubifiedHemicube"]],
    ["octahedral", ["octahedral"]],
    ["fisheye", ["fisheye"]],
    ["sphere map", ["sphere"]],
];
const VARIANT_NAMES: Partial<Record<Storage, string>> = {
    equirectangular: "whole",
    upperEquirectangular: "upper half",
    cube: "cube",
    hemicube: "hemicube",
    cubified: "cubified",
    cubifiedHemicube: "cubified hemicube",
};
const SPREAD_TITLE = "The solid angle of the largest texel over the smallest one's: how unevenly the texels are spread";
// The probes as sharp as an octahedral map of 32², 0.7256 of the equirectangular's width.
const SCENARIOS: Record<string, Scenario> = {
    background: { width: 4096, format: "rgba16float", count: 1 },
    lighting: { width: 256 * Math.PI, format: "rgba16float", count: 1 },
    probes: { width: (32 * Math.PI) / Math.sqrt(3 * Math.sqrt(3)), format: "rg11b10ufloat", count: 1024 },
};
/** The powers of two the sharpness snaps to, as log2 of the width, and how near. */
const POWERS = Array.from({ length: 10 }, (_, i) => i + 5);
const SNAP = 0.08;

const radios = (name: string) => [...root.querySelectorAll<HTMLInputElement>(`input[name=storage-${name}]`)];

/** The width the slider stands for: exact while a scenario sets it, the slider's own rounded otherwise. */
let exactWidth: number | null = null;
const scenario = (): Scenario => ({
    width: exactWidth ?? Math.round(2 ** Number(width.value)),
    format: (radios("format").find((input) => input.checked)?.value ?? "rgba16float") as Format,
    count: 2 ** Number(count.value),
});

const bytes = (b: number) =>
    b >= 1024 * MiB
        ? `${(b / 1024 / MiB).toPrecision(3)} GiB`
        : b >= MiB
          ? `${(b / MiB).toPrecision(3)} MiB`
          : `${(b / 1024).toPrecision(3)} KiB`;
const percent = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(Math.round(x * 100))}%`;
const spread = (x: number) => `×${x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(x >= 10 ? 0 : 1)}`;

function span(className: string, text = "", title?: string) {
    const element = Object.assign(document.createElement("span"), { className, textContent: text });
    if (title) element.title = title;
    return element;
}

/** First level and with mips, the unit said once where both share it. */
function pair(a: number, b: number) {
    const [x, y] = [bytes(a), bytes(b)];
    const unit = (text: string) => text.slice(text.lastIndexOf(" "));
    return unit(x) === unit(y) ? `${x.slice(0, x.lastIndexOf(" "))} / ${y}` : `${x} / ${y}`;
}

function render() {
    const s = scenario();
    const costs = new Map(STORAGES.map((storage) => [storage, costOf(storage, s)]));
    const reference = costs.get("equirectangular")?.total ?? 1;
    const largest = Math.max(...[...costs.values()].map((c) => c.total));
    const heads = ["GPU memory, first level / with mips", "spread", "not needed"];
    const cells: HTMLElement[] = [
        span(""),
        ...heads.map((head, i) =>
            span(`budget-head note${i === 2 ? " costs-head-last" : ""}`, head, i === 1 ? SPREAD_TITLE : undefined),
        ),
    ];
    const maps = s.count > 1 ? `${s.count.toLocaleString("en-US")} × ` : "";
    for (const [family, variants] of FAMILIES) {
        // A family of several: its name a heading over a row per variant.
        if (variants.length > 1) cells.push(span("storage-family note", family));
        for (const [v, storage] of variants.entries()) {
            const c = costs.get(storage) as Cost;
            const name = variants.length > 1 ? (VARIANT_NAMES[storage] ?? family) : family;
            const half = upperHalf(storage) && variants.length === 1 ? ", upper half" : "";
            const sizes = `${maps}${c.label}${half}, ${c.levels} levels`;
            const first = variants.length > 1 && v === 0 ? " storage-first" : "";
            const label = span(`budget-size${first}${variants.length > 1 ? " storage-variant" : ""}`);
            label.append(span("", name), span("budget-defaults-note note", sizes));
            const columns = heads.map((head) => {
                const cell = span(`budget-cell${first}`);
                cell.dataset.label = head;
                return cell;
            });
            const line = span("budget-line", "", `${name}: ${bytes(c.base)} and ${bytes(c.total)} with mips`);
            const hatched = storage === "equirectangular" ? " budget-reference" : "";
            for (const [i, b] of [c.base, c.total - c.base].entries()) {
                const bar = span(`budget-bar budget-part-${i}${hatched}`);
                bar.style.width = `${(50 * b) / largest}%`;
                line.append(bar);
            }
            const relative = storage === "equirectangular" ? "" : `, ${percent(c.total / reference - 1)}`;
            line.append(span("budget-value", `${pair(c.base, c.total)}${relative}`));
            columns[0]?.append(line);
            for (const [i, text] of [spread(c.spread), `${Math.round(c.wasted * 100)}%`].entries()) {
                const inner = span("budget-line", "", `${name}: ${text} (${heads[i + 1]})`);
                inner.append(span("budget-value costs-none", text));
                columns[i + 1]?.append(inner);
            }
            cells.push(label, ...columns);
        }
    }
    grid.replaceChildren(...cells);
    const reading = find("[data-field=widthValue]", root);
    reading.textContent = String(Math.round(s.width));
    reading.title = `${(360 / s.width).toFixed(3)}° a texel at the equirectangular's horizon`;
    find("[data-field=countValue]", root).textContent = s.count.toLocaleString("en-US");
}

/** A scenario sets the sliders and the format; touching any of them afterwards leaves it. */
function choose(name: string) {
    const chosen = SCENARIOS[name];
    if (!chosen) return;
    exactWidth = chosen.width;
    width.value = String(Math.log2(chosen.width));
    count.value = String(Math.log2(chosen.count));
    for (const input of radios("format")) input.checked = input.value === chosen.format;
    paintRange(width);
    paintRange(count);
}

root.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.name === "storage-scenario") choose(target.value);
    else {
        if (target === width) {
            exactWidth = null;
            const power = snapMark(width, POWERS, SNAP);
            if (power !== null) {
                width.value = String(power);
                paintRange(width);
            }
        }
        for (const input of radios("scenario")) input.checked = false;
    }
    render();
});
choose("background");
render();
