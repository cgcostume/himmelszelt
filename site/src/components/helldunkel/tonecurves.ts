import type { ToneCurve } from "@himmelszelt/helldunkel";
import { find } from "../dom";
import { gpu } from "../dunstkreis/atmosphere";
import { context, draw, onHdri } from "../environment/hdri";
import { onDemand } from "../frame";

const root = find("#tones");

if (!gpu.error) {
    const tiles = [...root.querySelectorAll<HTMLCanvasElement>("canvas[data-curve]")].map((canvas) => ({
        canvas,
        target: context(canvas),
        curve: canvas.dataset.curve as ToneCurve,
    }));
    const request = onDemand(() => {
        for (const { canvas, target, curve } of tiles) if (target) draw(canvas, target, { curve });
    }, root);
    onHdri(request);
    new ResizeObserver(request).observe(root);
}
