// Every icon on the site, drawn once on a 16 unit grid, for every chapter. Strokes come from icons.css; the classes
// inside name the parts that move there: on hover, while switched on, or once done. Frames and rails sit on half units,
// where a hairline covers one row of pixels. A figure's bar shows a switch as its icon, a panel of options as its word.

// Rounded, to tell them from full screen's corners.
const BRACKETS =
    '<path class="close-in" d="M2.5 5.5V4A1.5 1.5 0 0 1 4 2.5h1.5M10.5 2.5H12A1.5 1.5 0 0 1 13.5 4v1.5M13.5 10.5V12a1.5 1.5 0 0 1-1.5 1.5h-1.5M5.5 13.5H4A1.5 1.5 0 0 1 2.5 12v-1.5"/>';
const CHECK = '<path class="check" d="M3 8.5l3 3 7-7"/>';

// The resolutions' K, beside a digit of each.
const K = '<path d="M9.5 3.5v9M14 3.5 9.5 8.5l4.5 4"/>';

// The stops a layer is brightened by, +2 or +4, drawn small in the top right corner, and the layer's icon made
// smaller to leave them room.
const PLUS = '<path d="M8.3 3.5h2.6M9.6 2.2v2.6"/>';
const STOPS = {
    2: `${PLUS}<path d="M12 2.7a1.4 1.4 0 0 1 2.8 0c0 1.1-2.8 1.8-2.8 3h2.9"/>`,
    4: `${PLUS}<path d="M14.2 5.7V1.3L11.9 4.3H15"/>`,
};
const SMALL_WAY =
    '<ellipse cx="6.5" cy="9.5" rx="5.2" ry="1.8" transform="rotate(-30)"/><circle class="solid" cx="6.5" cy="9.5" r="0.8"/>';
const SMALL_SPARKLE = '<path d="M6 5.6 6.78 8.72 9.9 9.5 6.78 10.28 6 13.4 5.22 10.28 2.1 9.5 5.22 8.72z"/>';

// A slash across a layer's icon: the layer off. The icon is cut where the slash crosses it, or the two read as one.
const OFF = '<path d="M2.5 2.5l11 11"/>';

// The star catalogs as the sky, a disc, filling up, each holding the ones before it: Yale's few bright stars,
// Hipparcos' fainter ones between them, and Tycho-2's many faintest.
const dots = (r: number, at: string) =>
    at.replace(/([\d.]+) ([\d.]+)(, )?/g, `<circle class="solid" cx="$1" cy="$2" r="${r}"/>`);
const YALE = `<circle cx="8" cy="8" r="6.5"/>${dots(1.1, "6 6, 10.5 7, 7.5 10.5")}`;
const HIPPARCOS = YALE + dots(0.6, "8 4, 4.2 9, 11 10.8, 10 4.5, 5.5 12");

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
    clipped:
        '<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 8 8 2.5M2.8 13.2 13.2 2.8M8 13.5 13.5 8"/>',
    /** Metered: a viewfinder's exposure scale, minus to plus, and its pointer. */
    meter: '<path d="M2.5 9.5h11M2.5 7.5v2M8 6.5v3M13.5 7.5v2"/><path class="solid" d="M8 11.2 6.4 13.6h3.2z"/><path d="M2.5 3.5h2.5M11 3.5h2.5M12.25 2.25v2.5"/>',
    /** By day: the Sun, its rays turning on hover. */
    day: '<circle cx="8" cy="8" r="2.6"/><path class="spin" d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>',
    /** Something on its way: three quarters of a circle, turned by whoever shows it. */
    loading: '<path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5"/>',
    /** The view kept on the Sun: brackets that close in round a Sun, filled while on. */
    sunLock: `${BRACKETS}<circle class="fill-on" cx="8" cy="8" r="2.4"/><path class="spin" d="M8 2.9v1.2M8 11.9v1.2M2.9 8h1.2M11.9 8h1.2M4.4 4.4l.85.85M10.75 10.75l.85.85M4.4 11.6l.85-.85M10.75 5.25l.85-.85"/>`,
    /** The Moon textured: its disc with its craters, one cut by the limb, and hollow also while on: filled, they would
     *  be the catalogs' stars. */
    moonMap:
        '<circle cx="8" cy="8" r="6"/><circle cx="6.2" cy="6.4" r="1.7"/><circle cx="9.8" cy="10" r="1.1"/><circle cx="6" cy="10.9" r="0.7"/><path d="M11.5 3.12A1.5 1.5 0 0 0 13.41 5.4"/>',
    /** The view kept on the Moon: the same brackets round the theme toggle's crescent (see Base.astro). */
    moonLock: `${BRACKETS}<path class="solid" d="M7.115 3.943A4 4 0 1 0 11.485 10.257 4 4 0 0 1 7.115 3.943z"/>`,
    /** The Milky Way: a band of light at a slant, its bulge in the middle; with +2 or +4 in its corner, brighter by two
     *  or four stops. The band turns about its own middle, which icons.css makes every part's origin. */
    milkyWay:
        '<ellipse cx="8" cy="8" rx="6.5" ry="2.2" transform="rotate(-30)"/><circle class="solid" cx="8" cy="8" r="1"/>',
    milkyWay2: SMALL_WAY + STOPS[2],
    milkyWay4: SMALL_WAY + STOPS[4],
    /** A star: a four-pointed sparkle; with +2 or +4 in its corner, brighter by two or four stops. */
    sparkle: '<path d="M8 1.5 9.3 6.7 14.5 8 9.3 9.3 8 14.5 6.7 9.3 1.5 8 6.7 6.7z"/>',
    sparkle2: SMALL_SPARKLE + STOPS[2],
    sparkle4: SMALL_SPARKLE + STOPS[4],
    /** The Milky Way and the stars off: their icons slashed, the band without its bulge. */
    milkyWayOff: `<path d="M8.03 10.48A6.5 2.2 -30 0 1 4.94 7.4M7.97 5.52A6.5 2.2 -30 0 1 11.06 8.6"/>${OFF}`,
    sparkleOff: `<path d="M7.06 5.24 8 1.5 9.3 6.7 14.5 8l-3.74.94M8.94 10.76 8 14.5 6.7 9.3 1.5 8l3.74-.94"/>${OFF}`,
    /** The star catalogs: Yale's bright stars, Hipparcos' added, Tycho-2's added. */
    catalogYale: YALE,
    catalogHipparcos: HIPPARCOS,
    catalogTycho: `${HIPPARCOS}${dots(0.35, "3.5 6.5, 6.5 3, 12 5.5, 12.8 8.5, 9 8.2, 6 8.5, 9 12.5, 3.8 11, 8 13.5, 12 12, 4.5 4.5, 11 3.4")}`,
    /** The far side, which Earth never sees: moonLock's frame round the Moon's outline, dashed. */
    farSide: `${BRACKETS}<circle cx="8" cy="8" r="4" stroke-dasharray="1.1 1.25"/>`,
    /** Back and on in time, each stepping its way on hover. */
    earlier: '<path class="step-back" d="M10 3.5 5.5 8l4.5 4.5"/>',
    later: '<path class="step-on" d="M6 3.5 10.5 8 6 12.5"/>',
    /** Refraction: a ray bent where it enters the air, the air's edge dashed. */
    refraction: '<path d="M1.5 8h13" stroke-dasharray="1.2 1.3"/><path d="M3 2.5 8 8l1.8 5.5"/>',
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
    /** A tray with an arrow dropping into it. */
    download: '<path class="drop" d="M8 2.5v7.5M4.75 6.75 8 10l3.25-3.25"/><path d="M2.5 10v3.5h11V10"/>',
    /** Four corners that reach out on hover and turn inward while full screen. */
    fullscreen:
        '<path class="tl" d="M2.5 6V2.5H6"/><path class="tr" d="M10 2.5h3.5V6"/><path class="br" d="M13.5 10v3.5H10"/><path class="bl" d="M6 13.5H2.5V10"/>',
    /** Play, and pause, which fades in over it while its button is pressed. */
    play: '<path class="play" d="M5 3.2v9.6L12.8 8z"/><path class="pause" d="M5.5 3.5v9M10.5 3.5v9"/>',
    /** How fast a figure's clock runs: at a clock's pace, a minute a second, an hour a second. One chevron more each. */
    speedClock: '<path d="M6 3.5 10.5 8 6 12.5"/>',
    speedMinute: '<path d="M3.5 3.5 8 8l-4.5 4.5M8.5 3.5 13 8l-4.5 4.5"/>',
    speedHour: '<path d="M1.5 3.5 6 8l-4.5 4.5M6 3.5 10.5 8 6 12.5M10.5 3.5 15 8l-4.5 4.5"/>',
    /** A padlock: the time of day held while the clouds go on. */
    timeLock: '<rect x="3.5" y="7.5" width="9" height="6" rx="1.5"/><path d="M5.5 7.5v-2a2.5 2.5 0 0 1 5 0v2"/>',
    /** Two sheets, the front one nudged on hover; a check once copied. */
    copy: `<g class="body"><rect class="nudge" x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1"/></g>${CHECK}`,
    /** The browser's location: a fix in cross hairs, which pulses on hover. */
    locate: '<circle cx="8" cy="8" r="4.5"/><circle class="solid" cx="8" cy="8" r="1.6"/><circle class="pulse" cx="8" cy="8" r="4.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2"/>',
    /** A paper plane, for flying through a view (see flight.ts). */
    fly: '<path d="M14 2 1.75 6.75l4.5 2.25L8.5 13.75z"/><path d="M14 2 6.25 9"/>',
    /** A padlock, its shackle swung open while off. */
    padlock:
        '<rect x="3.5" y="7.5" width="9" height="6" rx="1.2"/><path class="shackle" d="M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2"/>',
    /** A bulb, still: at the size of a caption's text any motion is too small to read. */
    bulb: '<path d="M8 1.75a4.25 4.25 0 0 0-2.5 7.7c.45.33.75.8.75 1.35v.7h3.5v-.7c0-.55.3-1.02.75-1.35A4.25 4.25 0 0 0 8 1.75ZM6.5 13.75h3"/>',
    /** Two lines that fold into a cross while open. */
    menu: '<path class="fold-a" d="M2.5 5.5h11"/><path class="fold-b" d="M5 10.5h6"/>',
} as const;

export type IconName = keyof typeof ICONS;

/** The icon as an SVG element's markup, sized and stroked by icons.css. */
export const icon = (name: IconName, extra = "") =>
    `<svg class="icon${extra ? ` ${extra}` : ""}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
