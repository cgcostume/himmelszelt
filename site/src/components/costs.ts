// What every chapter's "What it costs" figure shares besides its styles (costs.css): the axes, the numbers as the bars
// show them, and the line that says where and how the reference was measured.
import type { CostsResult } from "./bench";

/** An axis for values up to `max`: its end, a little past the longest bar, so the bar's value fits in its panel, and
 *  the step of its grid, some `steps` of them. */
export function axisFor(max: number, room = 1.3, steps = 4): { end: number; step: number } {
    const rough = (Math.max(max, 1e-9) * room) / steps;
    const power = 10 ** Math.floor(Math.log10(rough));
    const step = ([1, 2, 2.5, 5, 10].find((nice) => nice * power >= rough) ?? 10) * power;
    return { end: Math.ceil((max * room) / step - 1e-9) * step, step };
}

/** The numbers along an axis. */
export const ticksOf = ({ end, step }: { end: number; step: number }) =>
    Array.from({ length: Math.round(end / step) + 1 }, (_, i) => Math.round(i * step * 1e4) / 1e4);

/** Two significant digits, three under a tenth, and none past ten: a bar's value. */
export const formatValue = (v: number) =>
    v >= 10
        ? v.toFixed(0)
        : v >= 1
          ? v.toFixed(1)
          : v >= 0.1
            ? v.toFixed(2)
            : v >= 0.01
              ? v.toFixed(3)
              : v.toPrecision(1);

export const MiB = 2 ** 20;

const GPUS: Record<string, string> = { "amd rdna-3": "an AMD Radeon RX 7900 XT" };

/** Where and how a reference was measured, as the adapter names the GPU unless it is the one the site was measured on. */
export const creditOf = (measure: Pick<CostsResult, "gpu" | "browser" | "rounds" | "frames">) =>
    `${GPUS[measure.gpu] ?? measure.gpu} in ${measure.browser ?? "Chromium"}, medians of ${measure.rounds} rounds of ${measure.frames.toLocaleString("en-US")} frames`;
