/** `value` to `digits` decimals for the page's text: a true minus sign, and no sign on a value that rounds to zero. */
export function fixed(value: number, digits: number): string {
    const text = value.toFixed(digits);
    return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text.replace("-", "−");
}

/** The element `selector` finds in `root`, which the page's markup guarantees; a missing one is a bug, so it throws. */
export function find<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`No element for ${selector}`);
    return element;
}
