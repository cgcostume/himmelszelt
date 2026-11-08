// Every icon on the site, drawn once on a 16 unit grid, for every chapter. Strokes come from icons.css; the classes
// inside name the parts that move there: on hover, while switched on, or once done.

const BRACKETS = '<path class="close-in" d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3"/>';
const CHECK = '<path class="check" d="M3 8.5l3 3 7-7"/>';

// The resolutions' K, beside a digit of each.
const K = '<path d="M9.5 3.5v9M14 3.5 9.5 8.5l4.5 4"/>';

export const ICONS = {
    /** An environment map's resolution, by its width in texels. */
    res1k: `<path d="M3.5 5.5l2-2v9"/>${K}`,
    res2k: `<path d="M2 5.5a2 2 0 0 1 4 0c0 1.8-4 3.8-4 7h4.2"/>${K}`,
    res4k: `<path d="M5.5 12.5v-9L2 9.5h5.2"/>${K}`,
    res8k: `<circle cx="4.5" cy="5.4" r="1.9"/><circle cx="4.5" cy="10.2" r="2.4"/>${K}`,
    /** An environment map as stored: a sheet, its horizon across and meridians down. */
    envMap: '<rect x="1.5" y="3.5" width="13" height="9" rx="1"/><path d="M1.5 8h13M6 3.5v9M10 3.5v9"/>',
    /** The view from inside: a globe with its equator and a meridian, the eye in its middle. */
    envView:
        '<circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="6" ry="2.2"/><path d="M8 2a2.4 6 0 0 0 0 12"/><circle class="fill-on" cx="8" cy="8" r="1.1"/>',
    /** What clips past white: a frame with a highlight's warning stripes across it. */
    clipped: '<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M2 8.5 8.5 2M2 13.5 13.5 2M7 14l7-7"/>',
    /** Bloom: a small bright place and the glow bleeding out of it. */
    bloom: '<circle class="solid" cx="8" cy="8" r="1.8"/><circle cx="8" cy="8" r="4" stroke-dasharray="1.4 1.5"/><circle cx="8" cy="8" r="6.3" stroke-dasharray="0.8 2.2"/>',
    /** Something on its way: three quarters of a circle, turned by whoever shows it. */
    loading: '<path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5"/>',
    /** The view kept on the Sun: brackets that close in round a Sun, filled while on. */
    sunLock: `${BRACKETS}<circle class="fill-on" cx="8" cy="8" r="2.4"/><path class="spin" d="M8 2.9v1.2M8 11.9v1.2M2.9 8h1.2M11.9 8h1.2M4.4 4.4l.85.85M10.75 10.75l.85.85M4.4 11.6l.85-.85M10.75 5.25l.85-.85"/>`,
    /** The Moon textured: its disc with two of its maria, filled while on. */
    moonMap:
        '<circle cx="8" cy="8" r="6"/><ellipse class="fill-on" cx="6.2" cy="6.3" rx="2.2" ry="1.6"/><ellipse class="fill-on" cx="10" cy="9.8" rx="1.7" ry="1.3"/>',
    /** The view kept on the Moon: the same brackets round the theme toggle's crescent (see Base.astro). */
    moonLock: `${BRACKETS}<path class="solid" d="M7.115 3.943A4 4 0 1 0 11.485 10.257 4 4 0 0 1 7.115 3.943z"/>`,
    /** Back and on in time, each stepping its way on hover. */
    earlier: '<path class="step-back" d="M10 3.5 5.5 8l4.5 4.5"/>',
    later: '<path class="step-on" d="M6 3.5 10.5 8 6 12.5"/>',
    /** Refraction: the Sun where it truly is, dashed, and a little above it, a little squeezed, where the air shows it. */
    refraction:
        '<circle cx="8" cy="9.4" r="5.2" stroke-dasharray="1.3 1.4"/><ellipse class="fill-on lift" cx="8" cy="7" rx="5.2" ry="4.1"/>',
    /** Labels on a figure: a tag, its eyelet filled while on. */
    labels: '<path d="M2.5 2.5h5.2l5.8 5.8-5.2 5.2-5.8-5.8z"/><circle class="fill-on" cx="5.6" cy="5.6" r="1"/>',
    /** The Moon's libration: a disc rocking between two arcs, its center filled while on. */
    libration:
        '<circle cx="8" cy="8" r="3.8"/><path d="M2.3 5a7 7 0 0 0 0 6M13.7 5a7 7 0 0 1 0 6"/><circle class="fill-on" cx="8" cy="8" r="1"/>',
    /** A compass with a small north arrow; with the grid on, a dotted circle of altitude joins it (see .sky-marks). */
    marks: '<circle cx="8" cy="8" r="6"/><path d="M8 2v1.8M8 12.2V14M2 8h1.8M12.2 8H14"/><circle class="grid-part spin22" cx="8" cy="8" r="4.2" stroke-dasharray="0.1 1.75"/><path class="solid swing" d="M8 5.3 9.15 8.6H6.85z"/>',
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
    /** A bulb, still: at the size of a caption's text any motion is too small to read. */
    bulb: '<path d="M8 1.75a4.25 4.25 0 0 0-2.5 7.7c.45.33.75.8.75 1.35v.7h3.5v-.7c0-.55.3-1.02.75-1.35A4.25 4.25 0 0 0 8 1.75ZM6.5 13.75h3"/>',
    /** Two lines that fold into a cross while open. */
    menu: '<path class="fold-a" d="M2.5 6h11"/><path class="fold-b" d="M5 10h6"/>',
} as const;

export type IconName = keyof typeof ICONS;

/** The icon as an SVG element's markup, sized and stroked by icons.css. */
export const icon = (name: IconName, extra = "") =>
    `<svg class="icon${extra ? ` ${extra}` : ""}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
