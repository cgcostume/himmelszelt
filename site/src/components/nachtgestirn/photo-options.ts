/**
 * The photographs the comparison figure holds nachtgestirn's Moon against, each from Wikimedia Commons, read from there
 * at view time, with the moment and the place it was taken and where its disc lies, fitted to its limb.
 */
export interface Photo {
    /** A short name for the picker. */
    label: string;
    page: string;
    src: string;
    /** A small rendition for the gallery, 330 pixels wide. */
    thumb: string;
    width: number;
    height: number;
    /** The disc's center as fractions of the width and the height, and its radius as a fraction of the width, fitted to
     *  the lit limb. */
    center: readonly [number, number];
    radius: number;
    /** How far the photograph is turned counterclockwise, in degrees, from the sky's north up, or with `air` from the
     *  zenith up: the photographer's choice, fitted by correlating nachtgestirn's disc with it. */
    turn: number;
    /** The moment, UTC, from the camera's clock in the time zone given in `when`. */
    date: string;
    place: { latitude: number; longitude: number; heightM: number };
    /** Through the air and over the sky, for a photograph taken by day or low over the horizon; else the Moon alone. */
    air?: boolean;
    /** What the caption says of it: the moment and the place in words, the author and the license. */
    when: string;
    where: string;
    author: string;
    license: string;
    licenseUrl: string;
}

const BY_SA_3 = "https://creativecommons.org/licenses/by-sa/3.0/";
const BY_3 = "https://creativecommons.org/licenses/by/3.0/";
const BY_4 = "https://creativecommons.org/licenses/by/4.0/";

export const PHOTOS: readonly Photo[] = [
    {
        label: "crescent, 2012",
        page: "https://commons.wikimedia.org/wiki/File:2012-10-21_20-27-24-waxing-crescent-moon.jpg",
        // The 3840 pixel wide rendition of a mosaic 4937 wide.
        src: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/2012-10-21_20-27-24-waxing-crescent-moon.jpg/3840px-2012-10-21_20-27-24-waxing-crescent-moon.jpg",
        thumb: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/2012-10-21_20-27-24-waxing-crescent-moon.jpg/330px-2012-10-21_20-27-24-waxing-crescent-moon.jpg",
        width: 3840,
        height: 4706,
        center: [0.3407, 0.4725],
        radius: 0.5946,
        turn: -15.8,
        // The camera's clock, 20:27:24 on October 21, 2012, read as Central European Summer Time; the place from its GPS.
        date: "2012-10-21T18:27:24Z",
        place: { latitude: 47.64079, longitude: 6.86525, heightM: 365 },
        when: "October 21, 2012, 20:27 local time",
        where: "near Belfort, France",
        author: "Thomas Bresson",
        license: "CC BY 3.0",
        licenseUrl: BY_3,
    },
    {
        label: "half, by day, 2024",
        page: "https://commons.wikimedia.org/wiki/File:The_Moon_2024-05-15_01-17_UTC.jpg",
        src: "https://upload.wikimedia.org/wikipedia/commons/5/58/The_Moon_2024-05-15_01-17_UTC.jpg",
        thumb: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/58/The_Moon_2024-05-15_01-17_UTC.jpg/330px-The_Moon_2024-05-15_01-17_UTC.jpg",
        width: 4032,
        height: 3024,
        center: [0.4186, 0.4934],
        radius: 0.3635,
        turn: 2.5,
        // The moment as the file's name gives it in UTC, the camera's clock in Central Daylight Time agreeing; the place
        // from its GPS. Through an 80 mm refractor and a wide eyepiece, nine minutes before sunset.
        date: "2024-05-15T01:17:13Z",
        place: { latitude: 32.8453, longitude: -97.377, heightM: 224 },
        air: true,
        when: "May 14, 2024, 20:17 local time",
        where: "Fort Worth, Texas",
        author: "S. R. Yates",
        license: "CC BY 4.0",
        licenseUrl: BY_4,
    },
    {
        label: "gibbous, 2012",
        page: "https://commons.wikimedia.org/wiki/File:2012-10-25_20-41-01-waxing-gibbous-moon.jpg",
        // The 3840 pixel wide rendition of a mosaic 5456 wide, 1.5 MB.
        src: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/08/2012-10-25_20-41-01-waxing-gibbous-moon.jpg/3840px-2012-10-25_20-41-01-waxing-gibbous-moon.jpg",
        thumb: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/08/2012-10-25_20-41-01-waxing-gibbous-moon.jpg/330px-2012-10-25_20-41-01-waxing-gibbous-moon.jpg",
        width: 3840,
        height: 4393,
        center: [0.4253, 0.4999],
        radius: 0.5003,
        turn: 20,
        // The camera's clock, 20:41:01 on October 25, 2012, read as Central European Summer Time; the place from its GPS.
        date: "2012-10-25T18:41:01Z",
        place: { latitude: 47.64087, longitude: 6.86515, heightM: 365 },
        when: "October 25, 2012, 20:41 local time",
        where: "near Belfort, France",
        author: "Thomas Bresson",
        license: "CC BY 3.0",
        licenseUrl: BY_3,
    },
    {
        label: "full, 2010",
        page: "https://commons.wikimedia.org/wiki/File:FullMoon2010.jpg",
        // The original, 2.1 MB, so the photograph holds up in full screen too.
        src: "https://upload.wikimedia.org/wikipedia/commons/e/e1/FullMoon2010.jpg",
        thumb: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/FullMoon2010.jpg/330px-FullMoon2010.jpg",
        width: 2580,
        height: 2452,
        center: [0.5008, 0.5098],
        radius: 0.415,
        turn: 6,
        // The camera's clock, 23:21:13 on October 22, 2010, read as Central Daylight Time.
        date: "2010-10-23T04:21:13Z",
        place: { latitude: 34.699, longitude: -86.748, heightM: 200 },
        when: "October 22, 2010, 23:21 local time",
        where: "Madison, Alabama",
        author: "Gregory H. Revera",
        license: "CC BY-SA 3.0",
        licenseUrl: BY_SA_3,
    },
];
