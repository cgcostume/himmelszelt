// Every icon on the site, drawn once on a 16 unit grid, for every chapter. Strokes come from icons.css; the classes
// inside name the parts that move there: on hover, while switched on, or once done.

const BRACKETS = '<path class="close-in" d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3"/>';
const CHECK = '<path class="check" d="M3 8.5l3 3 7-7"/>';

export const ICONS = {
    /** The view kept on the Sun: brackets that close in round a Sun, filled while on. */
    sunLock: `${BRACKETS}<circle class="fill-on" cx="8" cy="8" r="1.9"/><path class="spin" d="M8 3.6v1M8 11.4v1M3.6 8h1M11.4 8h1M4.9 4.9l.7.7M10.4 10.4l.7.7M4.9 11.1l.7-.7M10.4 5.6l.7-.7"/>`,
    /** The view kept on the Moon: the same brackets round a crescent. */
    moonLock: `${BRACKETS}<path class="fill-on" d="M9.3 5.5A2.7 2.7 0 1 0 9.3 10.5 2.2 2.2 0 0 1 9.3 5.5z"/>`,
    /** The sky's grid: the horizon, a dotted circle of altitude and the four compass points. */
    grid: '<circle cx="8" cy="8" r="6"/><circle class="spin22" cx="8" cy="8" r="3.2" stroke-dasharray="0.1 1.9"/><path d="M8 2v2.2M8 11.8V14M2 8h2.2M11.8 8H14"/>',
    /** A figure's options: two knobs, each between two rails that grow and shrink as it slides, so it stays hollow. */
    options:
        '<path class="grow-a" d="M2.5 5.5h11"/><path class="shrink-a" d="M13.5 5.5H2.5"/><path class="shrink-b" d="M2.5 10.5h11"/><path class="grow-b" d="M13.5 10.5H2.5"/><circle class="r" cx="5.5" cy="5.5" r="1.7"/><circle class="l" cx="10.5" cy="10.5" r="1.7"/>',
    /** Settings, should a figure ever need them apart from its options. */
    gear: '<circle cx="8" cy="8" r="2"/><path class="spin" d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/><circle cx="8" cy="8" r="4.4"/>',
    /** A tray with an arrow dropping into it. */
    download: '<path class="drop" d="M8 2.5v7.5M4.75 6.75 8 10l3.25-3.25"/><path d="M2.5 10v3.5h11V10"/>',
    /** Four corners that reach out on hover and turn inward while full screen. */
    fullscreen:
        '<path class="tl" d="M2.5 6V2.5H6"/><path class="tr" d="M10 2.5h3.5V6"/><path class="br" d="M13.5 10v3.5H10"/><path class="bl" d="M6 13.5H2.5V10"/>',
    /** Play's triangle in two halves, the first overlapping the second so no seam shows, folded into pause by skyframe.ts. */
    play: '<path class="morph" d="M4 2.5L9 5.556L9 10.444L4 13.5Z"/><path class="morph" d="M8.5 5.25L13 8L13 8L8.5 10.75Z"/>',
    /** Two sheets, the front one nudged on hover; a check once copied. */
    copy: `<g class="body"><rect class="nudge" x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1"/></g>${CHECK}`,
    /** The browser's location: a fix in cross hairs, which pulses on hover. */
    locate: '<circle cx="8" cy="8" r="4.5"/><circle class="solid" cx="8" cy="8" r="1.6"/><circle class="pulse" cx="8" cy="8" r="4.5"/><path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15"/>',
    /** A padlock, its shackle swung open while off. */
    padlock:
        '<rect x="3.5" y="7.5" width="9" height="6.5" rx="1.2"/><path class="shackle" d="M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2"/>',
    /** A bulb whose rays flash on hover. */
    bulb: '<path d="M8 3.5a3.5 3.5 0 0 0-2 6.4c.35.25.5.6.5 1v.6h3v-.6c0-.4.15-.75.5-1A3.5 3.5 0 0 0 8 3.5ZM6.75 13.75h2.5"/><path class="flash" d="M8 .5v1.2M2.5 6h1.2M12.3 6h1.2M3.9 2l.8.8M12.1 2l-.8.8"/>',
    /** Two lines that fold into a cross while open. */
    menu: '<path class="fold-a" d="M2.5 6h11"/><path class="fold-b" d="M5 10h6"/>',
} as const;

export type IconName = keyof typeof ICONS;

/** The icon as an SVG element's markup, sized and stroked by icons.css. */
export const icon = (name: IconName, extra = "") =>
    `<svg class="icon${extra ? ` ${extra}` : ""}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
