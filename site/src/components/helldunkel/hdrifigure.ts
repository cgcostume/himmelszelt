import { find } from "../dom";
import { bindHdr, gpu } from "../dunstkreis/atmosphere";
import { context, draw, hdri, onHdri } from "../environment/hdri";
import { onDemand } from "../frame";

const root = find("#hdri");
const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
const canvas = field<HTMLCanvasElement>("canvas");

if (gpu.error) {
    field("info").textContent = gpu.error;
} else {
    bindHdr(find('[data-hdr="note"]', root), find('[data-hdr="choice"]', root));
    const target = context(canvas);
    const request = onDemand(() => {
        if (target) draw(canvas, target);
        field("info").textContent = hdri.name
            ? `${hdri.width} × ${hdri.height}; the meter reads EV ${hdri.metered.toFixed(1)}, in the file's own relative units`
            : "Loading…";
    }, canvas);
    onHdri(request);
    new ResizeObserver(request).observe(canvas);
}
