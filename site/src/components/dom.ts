/** The element `selector` finds in `root`, which the page's markup guarantees; a missing one is a bug, so it throws. */
export function find<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`No element for ${selector}`);
    return element;
}
