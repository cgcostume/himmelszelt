/**
 * The photographs the comparison figure holds nachtgestirn's Moon against, each from Wikimedia Commons, read from there
 * at view time, with the moment and the place it was taken and where its disc lies, fitted to nachtgestirn's Moon by
 * `scripts/photo-fit.mjs`.
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
     *  some 700 craters and ridges found in nachtgestirn's Moon for the same moment and place. */
    center: readonly [number, number];
    radius: number;
    /** How far the photograph is turned counterclockwise, in degrees, from the sky's north up, or with `air` from the
     *  zenith up: the photographer's choice, fitted with the center and the radius. */
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
// Rolf Hempel's observatory, which the file pages do not give: the place his MoonPanoramaMaker's example configuration
// holds, east of Bonn. A place 100 km off would move the diurnal libration by some 0.015°.
const HEMPEL = { latitude: 50.6919, longitude: 7.3972, heightM: 250 };

export const PHOTOS: readonly Photo[] = [
    {
        label: "crescent, 2020",
        page: "https://commons.wikimedia.org/wiki/File:2020-04-26_21-21MESZ_Mondsichel.jpg",
        src: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c8/2020-04-26_21-21MESZ_Mondsichel.jpg/3840px-2020-04-26_21-21MESZ_Mondsichel.jpg",
        thumb: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c8/2020-04-26_21-21MESZ_Mondsichel.jpg/330px-2020-04-26_21-21MESZ_Mondsichel.jpg",
        width: 3840,
        height: 2716,
        center: [0.4334, 0.2939],
        radius: 0.4423,
        turn: -54.95,
        // The 3840 pixel wide rendition of a mosaic of 21 stacked tiles 6500 wide, turned as it stood in the sky; the moment
        // as its name gives it, 21:21 Central European Summer Time.
        date: "2020-04-26T19:21:00Z",
        place: HEMPEL,
        when: "April 26, 2020, 21:21 local time",
        where: "near Bonn, Germany",
        author: "Rolf Hempel",
        license: "CC BY 3.0",
        licenseUrl: BY_3,
    },
    {
        label: "first quarter, 2020",
        page: "https://commons.wikimedia.org/wiki/File:2020-03-31_21-45MESZ_Mond_LRGB.jpg",
        src: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/2020-03-31_21-45MESZ_Mond_LRGB.jpg/3840px-2020-03-31_21-45MESZ_Mond_LRGB.jpg",
        thumb: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/2020-03-31_21-45MESZ_Mond_LRGB.jpg/330px-2020-03-31_21-45MESZ_Mond_LRGB.jpg",
        width: 3840,
        height: 6383,
        center: [0.1351, 0.4989],
        radius: 0.7739,
        turn: -5.12,
        // The 3840 pixel wide rendition of a mosaic of 34 stacked tiles 4211 wide, colored from a refractor's frames; the
        // moment as its name gives it, 21:45 Central European Summer Time.
        date: "2020-03-31T19:45:00Z",
        place: HEMPEL,
        when: "March 31, 2020, 21:45 local time",
        where: "near Bonn, Germany",
        author: "Rolf Hempel",
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
        center: [0.4346, 0.4953],
        radius: 0.3436,
        turn: 2.44,
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
        label: "gibbous, at dusk, 2015",
        page: "https://commons.wikimedia.org/wiki/File:Ksi%C4%99%C5%BCyc_Leszno_25.07.2015.JPG",
        // The original, 2862 pixels wide, 1.2 MB.
        src: "https://upload.wikimedia.org/wikipedia/commons/6/62/Ksi%C4%99%C5%BCyc_Leszno_25.07.2015.JPG",
        thumb: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/62/Ksi%C4%99%C5%BCyc_Leszno_25.07.2015.JPG/330px-Ksi%C4%99%C5%BCyc_Leszno_25.07.2015.JPG",
        width: 2862,
        height: 1908,
        center: [0.4625, 0.4932],
        radius: 0.279,
        turn: 2.06,
        // The camera's clock, 20:57:34 on July 25, 2015, read as Central European Summer Time, some seven minutes after
        // sunset; the place from its GPS. A superzoom camera at its longest, 1/25 s.
        date: "2015-07-25T18:57:34Z",
        place: { latitude: 51.83063, longitude: 16.601106, heightM: 95 },
        air: true,
        when: "July 25, 2015, 20:57 local time",
        where: "Leszno, Poland",
        author: "Namysław Tatarynowicz",
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
        center: [0.425, 0.5005],
        radius: 0.4974,
        turn: 16.31,
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
        center: [0.5019, 0.5099],
        radius: 0.4152,
        turn: 6.01,
        // The camera's clock, 23:21:13 on October 22, 2010, read as Central Daylight Time.
        date: "2010-10-23T04:21:13Z",
        place: { latitude: 34.699, longitude: -86.748, heightM: 200 },
        when: "October 22, 2010, 23:21 local time",
        where: "Madison, Alabama",
        author: "Gregory H. Revera",
        license: "CC BY-SA 3.0",
        licenseUrl: BY_SA_3,
    },
    {
        label: "last quarter, 2020",
        page: "https://commons.wikimedia.org/wiki/File:2020-09-11_04-51MESZ_Mond_LRGB.jpg",
        src: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d5/2020-09-11_04-51MESZ_Mond_LRGB.jpg/3840px-2020-09-11_04-51MESZ_Mond_LRGB.jpg",
        thumb: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d5/2020-09-11_04-51MESZ_Mond_LRGB.jpg/330px-2020-09-11_04-51MESZ_Mond_LRGB.jpg",
        width: 3840,
        height: 5428,
        center: [0.8166, 0.4982],
        radius: 0.6588,
        turn: 4.59,
        // The 3840 pixel wide rendition of a mosaic of 31 stacked tiles 4245 wide, colored from a refractor's frames; the
        // moment as its name gives it, 04:51 Central European Summer Time.
        date: "2020-09-11T02:51:00Z",
        place: HEMPEL,
        when: "September 11, 2020, 04:51 local time",
        where: "near Bonn, Germany",
        author: "Rolf Hempel",
        license: "CC BY 3.0",
        licenseUrl: BY_3,
    },
];
