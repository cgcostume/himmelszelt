import { find } from "../dom";
import { gpu } from "../dunstkreis/atmosphere";
import { axisFor, BUDGET_ROWS, type BudgetMeasure, formatMs, ticksOf, timeParts } from "./budget-rows";

// How long the reader's measure may take, in milliseconds, and its rounds and frames where the GPU is fast enough.
const WITHIN = 12_000;
const ROUNDS = 9;
const FRAMES = 96;
const WARMUP = 4;
// The passes' colors, as Budget.astro has them; the compose pass in the ink.
const COLORS: Record<string, string> = {
    lines: "budget-part-3",
    bin: "budget-part-0",
    deep: "budget-part-0",
    halo: "budget-part-2",
};

/**
 * The budget figure on `root`, a `figure[data-stars-budget]`: its button measures the figure's rows on this GPU, draws
 * them hatched under the reference's bars, and stretches the time's axis where they are longer. Nothing runs until the
 * button is pressed, and nothing after the measure is done.
 */
export function budgetFigure(root: HTMLElement) {
    const button = find<HTMLButtonElement>("[data-field=measure]", root);
    const status = find("[data-field=status]", root);
    const grid = find(".budget-grid", root);
    const cells = [...root.querySelectorAll<HTMLElement>(".budget-cell[data-row]")];
    const { device, adapterName } = gpu;
    if (!device) {
        button.disabled = true;
        button.title = "Measuring needs WebGPU, which this browser does not offer";
        return;
    }

    function show(mine: BudgetMeasure) {
        let longest = 0;
        const ratios: number[] = [];
        for (const cell of cells) {
            const measured = mine.rows[cell.dataset.row ?? ""];
            const reference = Number(cell.dataset.ms);
            longest = Math.max(longest, reference || 0, measured?.frame ?? 0);
            if (!measured) continue;
            if (reference > 0) ratios.push(measured.frame / reference);
            const parts = timeParts(measured);
            const line = find("[data-field=mine]", cell);
            line.title = `this GPU: ${parts.map(([name, ms]) => `${name} ${ms.toFixed(3)}`).join(", ")} ms; ${measured.spread.p10.toFixed(3)} to ${measured.spread.p90.toFixed(3)} over the rounds`;
            line.hidden = false;
            line.innerHTML = `${parts
                .map(
                    ([name, ms]) =>
                        `<i class="budget-bar budget-defaults ${COLORS[name] ?? ""}" style="--v: ${ms}"></i>`,
                )
                .join("")}<span class="budget-value">${formatMs(measured.frame)}</span>`;
        }
        const axis = axisFor(longest);
        grid.style.setProperty("--axis-ms", String(axis.end));
        grid.style.setProperty("--step-ms", String(axis.step));
        find("[data-axis=ms]", root).innerHTML = ticksOf(axis)
            .map((t) => `<span style="--v: ${t}">${t}</span>`)
            .join("");
        // Over all rows, the geometric mean of this GPU's time over the reference's.
        const ratio = Math.exp(ratios.reduce((sum, r) => sum + Math.log(r), 0) / Math.max(1, ratios.length));
        const clock = !mine.timestamps
            ? "no GPU clock here, so from submitting a frame to done"
            : mine.quantized
              ? `by the GPU's clock, which this browser rounds to ${(mine.quantum ?? 0.1).toFixed(2)} ms`
              : "by the GPU's clock";
        const missing = BUDGET_ROWS.some((row) => !mine.rows[row.id])
            ? " Rows without their stars are left out: pnpm assets makes ESA's catalogues, which the package does not ship."
            : "";
        status.textContent = `${adapterName}: a frame takes ${ratio < 10 ? ratio.toFixed(1) : ratio.toFixed(0)} times the reference's time, ${clock}; ${mine.rounds} rounds of ${mine.frames} frames a row.${missing}`;
    }

    let running: AbortController | null = null;
    button.addEventListener("click", async () => {
        if (running) {
            running.abort();
            return;
        }
        const run = new AbortController();
        running = run;
        button.setAttribute("aria-pressed", "true");
        button.toggleAttribute("data-measuring", true);
        button.style.setProperty("--progress", "0");
        status.textContent = "Loading the catalogs and the maps, and making the passes.";
        try {
            const { measureBudget } = await import("./budget-bench");
            const mine = await measureBudget(device, BUDGET_ROWS, adapterName ?? "this GPU", {
                rounds: ROUNDS,
                frames: FRAMES,
                warmup: WARMUP,
                within: WITHIN,
                signal: run.signal,
                progress: (done) => {
                    button.style.setProperty("--progress", done.toFixed(3));
                    status.textContent = "Measuring.";
                },
            });
            if (mine) show(mine);
            else status.textContent = "";
        } catch (error) {
            status.textContent = `The measure failed: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            running = null;
            button.setAttribute("aria-pressed", "false");
            button.removeAttribute("data-measuring");
        }
    });
}
