/**
 * Rendering on demand, for every figure on the site: the returned function schedules `draw` for the next animation
 * frame, at most once however often it is called, and nothing runs while nothing changes. Given the figure's `element`,
 * it draws only while the figure is on screen or about to be; a request while it is away is kept for when it comes back.
 */
export function onDemand(draw: () => void, element?: Element) {
    let pending: number | null = null;
    let visible = !element;
    let stale = false;
    const request = () => {
        if (!visible) {
            stale = true;
            return;
        }
        if (pending !== null) return;
        pending = requestAnimationFrame(() => {
            pending = null;
            draw();
        });
    };
    if (element) {
        // A screen ahead, so a figure scrolled to is drawn by the time it shows.
        new IntersectionObserver(
            ([entry]) => {
                visible = entry?.isIntersecting ?? true;
                if (visible && stale) {
                    stale = false;
                    request();
                }
            },
            { rootMargin: "100% 0px" },
        ).observe(element);
    }
    return request;
}
