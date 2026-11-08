/**
 * Whether `element` is in view, or within `margin` of it ("100% 0px" a screen above and below), as it changes: the one
 * way every figure on the site tells, for drawing, building what it shows, measuring or animating only while it is.
 * `onChange` hears the first state too.
 */
export function watchView(element: Element, margin: string, onChange: (inView: boolean) => void) {
    new IntersectionObserver(([entry]) => onChange(entry?.isIntersecting ?? true), { rootMargin: margin }).observe(
        element,
    );
}

/**
 * Rendering on demand, for every figure on the site: the returned function schedules `draw` for the next animation
 * frame, at most once however often it is called, and nothing runs while nothing changes. Given the figure's `element`,
 * it draws the first time once the figure is within a screen of the view, so it is there when scrolled to, and after
 * that only while the figure is on screen: a change while it is away is kept for when it comes back.
 */
export function onDemand(draw: () => void, element?: Element) {
    let pending: number | null = null;
    let near = !element;
    let visible = !element;
    let drawn = false;
    let stale = false;
    const request = () => {
        // Once drawn, a figure off screen waits; the first draw comes as soon as it is near.
        if (!(visible || (near && !drawn))) {
            stale = true;
            return;
        }
        if (pending !== null) return;
        pending = requestAnimationFrame(() => {
            pending = null;
            drawn = true;
            draw();
        });
    };
    if (element) {
        const resume = () => {
            if (stale && (visible || (near && !drawn))) {
                stale = false;
                request();
            }
        };
        watchView(element, "100% 0px", (on) => {
            near = on;
            resume();
        });
        watchView(element, "0px", (on) => {
            visible = on;
            resume();
        });
    }
    return request;
}
