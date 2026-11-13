/**
 * Theodore Yapo's and Barbara Cutler's photographs of the total lunar eclipse of February 21, 2008, from their paper on
 * rendering lunar eclipses (Graphics Interface 2009): raw frames from a 127 mm Maksutov-Cassegrain of 1540 mm focal
 * length, f/12.1, on a Canon DSLR at ISO 800, decoded to sRGB with a D65 white point and no white balance of the
 * camera's, so their colors can be compared. Served from the site, `public/eclipse-2008/`.
 */
export interface EclipsePhoto {
    /** The file under the site's base, 1024 pixels square. */
    file: string;
    /** The moment from the camera's clock, UTC, and the exposure in seconds. */
    date: string;
    seconds: number;
    /** The disc's center and radius in pixels of the square, and how far the frame is turned clockwise onto the Moon's
     *  north up, in degrees, fitted by `scripts/photo-fit.mjs --figure photo-eclipse` to several hundred craters found
     *  in both, the partial frames' fewer, in their part neither burnt out nor too dark; those turn 4° less, the camera
     *  turned between. */
    center: readonly [number, number];
    radius: number;
    turn: number;
    /** What the figure names it by. */
    label: string;
}

/** Clifton Park, New York, where the photographs were taken. */
export const CLIFTON_PARK = { latitude: 42.8656, longitude: -73.7709, heightM: 100 };
/** The telescope's focal ratio and the camera's sensitivity. */
const F_NUMBER = 1540 / 127;
const ISO = 800;
/** EV100 of an exposure of `seconds` through the telescope at ISO 800. */
export const ev100Of = (seconds: number) => Math.log2((F_NUMBER * F_NUMBER) / seconds) - Math.log2(ISO / 100);

export const ECLIPSE_PHOTOS: readonly EclipsePhoto[] = [
    {
        file: "0308-4s.jpg",
        date: "2008-02-21T03:08:26Z",
        seconds: 4,
        center: [514.81, 518.55],
        radius: 464.59,
        turn: 68.9,
        label: "early totality",
    },
    {
        file: "0350-3s.jpg",
        date: "2008-02-21T03:50:42Z",
        seconds: 3,
        center: [500.35, 508.09],
        radius: 465.08,
        turn: 67.93,
        label: "totality ending",
    },
    {
        file: "0412-0.166s.jpg",
        date: "2008-02-21T04:12:44Z",
        seconds: 0.166,
        center: [526.64, 518.37],
        radius: 465.97,
        turn: 64.29,
        label: "partial",
    },
    {
        file: "0412-1.5s.jpg",
        date: "2008-02-21T04:12:44Z",
        seconds: 1.509,
        center: [526.93, 518.19],
        radius: 465.67,
        turn: 64.32,
        label: "partial, longer",
    },
];
