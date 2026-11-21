// The benchmark behind the chapter's "What it costs", for `scripts/bench.mjs sternenheer`: six of the budget's rows
// through its own benchmark, budget-bench.ts, which takes them in turn round after round, with the GPU memory each
// pass holds and the files each downloads.
import { type BenchOptions, type CostRow, type CostsResult, codeBytes, round4 } from "../bench";
import { gpu, gpuDevice } from "../dunstkreis/atmosphere";
import { measureBudget } from "./budget-bench";
import { BUDGET_ROWS, filesOf } from "./budget-rows";
import { COST_ROWS } from "./cost-rows";

const CODE = import.meta.glob("../../../../packages/sternenheer/dist/*.js", { query: "?raw", import: "default" });

export async function bench(options: BenchOptions): Promise<CostsResult & { code: number }> {
    const keys = (options.cases as string[] | undefined) ?? [...COST_ROWS];
    const rows = BUDGET_ROWS.filter((row) => keys.includes(row.id));
    // A query set holds 4096 timestamps, sixteen a frame.
    const measure = await measureBudget(gpuDevice(), rows, gpu.adapterName ?? "unknown", {
        rounds: options.rounds,
        frames: Math.min(options.frames, 256),
        warmup: Math.min(options.warmup, 64),
        account: true,
        progress: (done) => options.progress?.(`${Math.round(100 * done)}%`),
    });
    if (!measure) throw new Error("bench: stopped");
    const result: Record<string, CostRow> = {};
    for (const row of rows) {
        const m = measure.rows[row.id];
        if (!m) continue;
        result[row.id] = {
            ms: {
                median: round4(m.frame),
                p10: round4(m.spread.p10),
                p90: round4(m.spread.p90),
                rounds: measure.rounds,
            },
            memory: Object.values(m.memory ?? {}).reduce((sum, b) => sum + b, 0),
            download: filesOf(row).reduce((sum, name) => sum + (measure.files?.[name] ?? 0), 0),
        };
    }
    return {
        gpu: measure.gpu,
        rounds: measure.rounds,
        frames: measure.frames,
        warmup: Math.min(options.warmup, 64),
        rows: result,
        code: await codeBytes(CODE),
    };
}
