/**
 * Rendering on demand, for every figure on the site: the returned function schedules `draw` for the next animation
 * frame, at most once however often it is called, and nothing runs while nothing changes.
 */
export function onDemand(draw: () => void) {
    let pending: number | null = null;
    return () => {
        if (pending !== null) return;
        pending = requestAnimationFrame(() => {
            pending = null;
            draw();
        });
    };
}
