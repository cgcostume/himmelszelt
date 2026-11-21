/**
 * The photographs the comparison figure holds sternenheer's sky against, each resampled to an ideal lens and served
 * from the site, `public/stars/`, with the moment and the place it was taken, what its camera noted, and where the
 * camera pointed: fitted to the stars found in it by `scripts/stars-fit.mjs`, which also measured both pictures.
 */
export interface StarPhoto {
    /** A short name for the picker. */
    label: string;
    /** The photograph's page, and the original the fit and the asset are made from. */
    page: string;
    original: string;
    /** The file under `public/stars/`, and its size in pixels. */
    file: string;
    width: number;
    height: number;
    /** The moment, UTC, from the camera's clock in the time zone given in `when`. */
    date: string;
    place: { latitude: number; longitude: number; heightM: number };
    /** What the camera noted: the lens, the sensor's width in millimeters and in pixels, and the exposure. */
    camera: {
        name: string;
        focalLengthMm: number;
        sensorWidthMm: number;
        widthPx: number;
        /** Where the lens' axis meets the frame, as shares of it, for a frame cut from the sensor's; else the middle. */
        axis?: readonly [number, number];
        fNumber: number;
        seconds: number;
        iso: number;
    };
    /** Whether the frame is a part of the sensor's, so that the lens' axis is fitted too. */
    cropped?: boolean;
    /** False where the frame holds none of the Milky Way's bright band, so that none is measured. */
    band?: boolean;
    /** A point on the ground the photograph shows, as shares of the original's frame, with its true azimuth and altitude
     *  from the place: the stars put it there only if the clock is right, as the sky turns a degree in four minutes. */
    landmark?: { name: string; at: readonly [number, number]; azimuth: number; altitude: number };
    /** Where the camera looks, as a compass azimuth and an altitude, how far its up is turned clockwise from the
     *  zenith's, and the angle the asset's width spans, all in degrees: the fit. */
    azimuth: number;
    altitude: number;
    roll: number;
    fieldOfView: number;
    /** The fit's stars, what is left between them and the catalog's in arcminutes and in the asset's pixels, the lens'
     *  distortion in the corners in percent, taken out of the asset, and the focal length found. */
    fit: { stars: number; residual: number; residualPx: number; distortion: number; focalLengthMm: number };
    /** How many stops brighter than its exposure's EV100 the photograph shows its stars: its processing, measured on
     *  stars the sensor did not saturate. The figure draws at the EV100 less this. */
    stops: number;
    /** What was measured in the photograph and in the figure's picture of it, alike. */
    measured: { photo: Measured; drawn: Measured };
    /** What the caption says of it: the moment and the place in words, the author and the license. */
    when: string;
    where: string;
    author: string;
    license: string;
    licenseUrl: string;
    /** What matches and what does not, in a sentence or two each. */
    matches: string;
    differs: string;
}

/** A picture's numbers: the magnitude half of the catalog's stars are still found at; the sky's luminance between the
 *  stars in cd/m², as the stars' light in the same picture scales it, with its red and blue over its green in linear
 *  sRGB; what the Milky Way's brightest part adds to that sky, in cd/m²; the sky from 3° to 8° over the horizon, alike;
 *  how far a star's blue falls behind its red per magnitude of B-V; the width of a faint star's image in pixels; and
 *  the radius in arcminutes at which the brightest star's halo has fallen to a twentieth of display white over the
 *  sky. */
export interface Measured {
    limitingMagnitude: number;
    sky: number;
    skyColor: readonly [number, number];
    milkyWay: number;
    horizon: number;
    horizonColor: readonly [number, number];
    starColor: number;
    sharpness: number;
    halo: number;
}

/** EV100 of a camera's exposure: the aperture's square over the seconds, less the stops of the sensitivity over 100. */
export const ev100Of = ({ fNumber, seconds, iso }: StarPhoto["camera"]) =>
    Math.log2((fNumber * fNumber) / seconds) - Math.log2(iso / 100);

const BY_2 = "https://creativecommons.org/licenses/by/2.0/";
const BY_4 = "https://creativecommons.org/licenses/by/4.0/";
const CC0 = "https://creativecommons.org/publicdomain/zero/1.0/";
const BY_SA_4 = "https://creativecommons.org/licenses/by-sa/4.0/";
const PUBLIC_DOMAIN = "https://creativecommons.org/publicdomain/mark/1.0/";
export const PHOTOS: readonly StarPhoto[] = [
    {
        label: "the Milky Way, 24 mm",
        page: "https://commons.wikimedia.org/wiki/File:Milky_Way_From_Inferno_Cone_(4fc3421b-c931-4347-a4f6-7b5806c41456).jpg",
        original:
            "https://upload.wikimedia.org/wikipedia/commons/2/27/Milky_Way_From_Inferno_Cone_%284fc3421b-c931-4347-a4f6-7b5806c41456%29.jpg",
        file: "milky-way-2017-08-18-inferno-cone.webp",
        width: 1600,
        height: 1062,
        // The camera's clock, 22:49:14 on August 18, 2017, read as Mountain Standard Time, an hour behind the daylight
        // time in use: only then the stars put the town's glow between the hills on the far horizon, 0.6° below the
        // level, where the plain 600 m lower lies, and due south, towards Rupert and Burley; by the clock as it reads
        // the glow would shine from 1.7° below it. Right to some 20 minutes. The place is the cone's summit.
        date: "2017-08-19T05:49:14Z",
        place: { latitude: 43.4433, longitude: -113.5519, heightM: 1884 },
        camera: {
            name: "Canon EOS 5DS, EF 24 mm f/1.4L II",
            focalLengthMm: 24,
            sensorWidthMm: 36,
            widthPx: 8688,
            fNumber: 1.8,
            seconds: 13,
            iso: 4000,
        },
        // The lowest sky the frame shows, a town's glow between two hills, as far down as the plain's horizon lies.
        landmark: { name: "the town's glow between the hills", at: [0.267, 0.943], azimuth: 186, altitude: -0.7 },
        azimuth: 196.58,
        altitude: 23.226,
        roll: -0.71,
        fieldOfView: 73.132,
        fit: { stars: 796, residual: 2.82, residualPx: 0.88, distortion: -1.22, focalLengthMm: 24.55 },
        stops: 2.3,
        measured: {
            photo: {
                limitingMagnitude: 10,
                sky: 0.0000808,
                skyColor: [0.86, 1.24],
                milkyWay: 0.000454,
                horizon: 0.000165,
                horizonColor: [1.28, 0.74],
                starColor: 0.08,
                sharpness: 1.11,
                halo: 2.7,
            },
            drawn: {
                limitingMagnitude: 10.9,
                sky: 0.000012,
                skyColor: [1.13, 0.71],
                milkyWay: 0.000311,
                horizon: 0.0000444,
                horizonColor: [1.86, 0.36],
                starColor: 1.05,
                sharpness: 0.86,
                halo: 11,
            },
        },
        when: "August 18, 2017, 23:49 local time",
        where: "Inferno Cone, Craters of the Moon, Idaho",
        author: "NPS / Jacob W. Frank",
        license: "public domain",
        licenseUrl: PUBLIC_DOMAIN,
        matches:
            "Every star stands on its star: 796 of them fit to 2.8 arcminutes, a pixel of this picture, down to Antares 4° over the horizon, where the air lifts it by a seventh of a degree. The Milky Way's clouds and dark lanes lie where the photograph has them, and against the stars its brightest part adds 21.4 magnitudes per square arcsecond to the sky, the photograph's 21.0: three tenths less light.",
        differs:
            "The photograph's sky between the stars is nearly seven times as bright, 22.8 against 24.9, and nearly four times as bright low over the horizon: the air's own glow and a town's light, which neither sternenheer nor dunstkreis draws. In so dark a sky the stars show a magnitude fainter, to 10.9 against 10.0, and the Milky Way drawn stands out 27 to one where the photograph's does seven to one. The stars drawn keep the colors the photograph's have lost, the halo around Antares is four times as wide, and Saturn, the bright point right of the Milky Way, is missing: sternenheer has no planets yet. The photograph is processed, its stars 2.3 stops brighter than f/1.8, 13 s and ISO 4000 give, and balanced towards blue, where sternenheer shows starlight as warm as it is.",
    },
    {
        label: "Orion, 35 mm",
        page: "https://commons.wikimedia.org/wiki/File:La_constel%C2%B7laci%C3%B3_de_Ori%C3%B3_i_l%27estrella_Betelgeuse.jpg",
        original:
            "https://upload.wikimedia.org/wikipedia/commons/0/03/La_constel%C2%B7laci%C3%B3_de_Ori%C3%B3_i_l%27estrella_Betelgeuse.jpg",
        file: "orion-2022-01-02-arcavell.webp",
        width: 1600,
        height: 1056,
        // The camera's clock, 22:03:38 on January 2, 2022, in the time zone it notes, UTC+1; its GPS, last fixed 103 s
        // before, gives the place and the height. The camera's own JPEG, nothing done to it since.
        date: "2022-01-02T21:03:38Z",
        place: { latitude: 42.427468, longitude: 1.482148, heightM: 1211 },
        band: false,
        camera: {
            name: "Nikon D5600, AF-S DX 35 mm f/1.8G",
            focalLengthMm: 35,
            sensorWidthMm: 23.5,
            widthPx: 6000,
            fNumber: 1.8,
            seconds: 13,
            iso: 1250,
        },
        azimuth: 146.274,
        altitude: 41.741,
        roll: 1.88,
        fieldOfView: 36.964,
        fit: { stars: 706, residual: 0.36, residualPx: 0.25, distortion: -2.46, focalLengthMm: 35.79 },
        stops: 0.4,
        measured: {
            photo: {
                limitingMagnitude: 10.3,
                sky: 0.000606,
                skyColor: [2.23, 0.53],
                milkyWay: 0,
                horizon: 0,
                horizonColor: [1, 1],
                starColor: 0.3,
                sharpness: 0.94,
                halo: 19.4,
            },
            drawn: {
                limitingMagnitude: 11.5,
                sky: 0.00000939,
                skyColor: [1.12, 0.6],
                milkyWay: 0,
                horizon: 0,
                horizonColor: [1, 1],
                starColor: 1.16,
                sharpness: 0.76,
                halo: 6.9,
            },
        },
        when: "January 2, 2022, 22:03 local time",
        where: "Arcavell, Catalonia",
        author: "Xaviaranda",
        license: "CC BY-SA 4.0",
        licenseUrl: BY_SA_4,
        matches:
            "The camera's own JPEG, and one of the closest fits: 706 stars to a third of an arcminute, a quarter of a pixel. Its stars are 0.4 stops brighter than sternenheer draws them for f/1.8, 13 s and ISO 1250, no more than a camera's ISO rating and its tone curve leave open: light in lux lands on the pixels where a sensor puts it. A faint star's image is nearly as wide in both.",
        differs:
            "The sky is another one: 20.8 magnitudes per square arcsecond in the photograph and an orange brown, as lamps color a hazy night, against 25.2 and a pale yellow drawn, 65 times darker. In its bright sky the photograph loses the stars at magnitude 10.3, while sternenheer shows every star it has, to 11.5 with the Hipparcos stars, and with Tycho-2's far more than the photograph. The stars' colors are drawn almost four times as strong, 1.16 magnitudes per B-V against 0.30, and the photograph's blue stars owe a violet fringe to the lens. Rigel's halo is drawn a third as wide, 7 against 19 arcminutes: this lens spreads more light around a bright star than the other two photographs show, and no single halo width matches all three photographs. The Orion Nebula glows pink in the sword, where sternenheer has only its stars.",
    },
    {
        label: "by moonlight, 16 mm",
        page: "https://commons.wikimedia.org/wiki/File:Moonlit_night_sky_looking_south_(49458657118).jpg",
        original:
            "https://upload.wikimedia.org/wikipedia/commons/8/8f/Moonlit_night_sky_looking_south_%2849458657118%29.jpg",
        file: "moonlit-2020-01-20-taranaki.webp",
        width: 1600,
        height: 731,
        // The camera's clock, 04:48:43 on January 20, 2020, read as New Zealand Daylight Time; the place as tagged. The
        // frame is the sensor's with its lower seventh cut off, as the file's own crop record has it.
        date: "2020-01-19T15:48:43Z",
        place: { latitude: -39.191087, longitude: 173.880014, heightM: 96 },
        camera: {
            name: "Canon EOS 6D, EF 16-35 mm f/4L IS at 16 mm",
            focalLengthMm: 16,
            sensorWidthMm: 35.8,
            widthPx: 5472,
            fNumber: 4,
            seconds: 10,
            iso: 3200,
            axis: [0.5, 0.5865],
        },
        cropped: true,
        // Mount Taranaki's summit, 2,518 m, 19.8 km off: where it stands in the frame and where on the horizon, a check of the clock.
        landmark: { name: "Mount Taranaki's summit", at: [0.466, 0.8109], azimuth: 126.42, altitude: 6.85 },
        azimuth: 135.353,
        altitude: 21.753,
        roll: -1.34,
        fieldOfView: 96.235,
        fit: { stars: 588, residual: 1.22, residualPx: 0.25, distortion: -3.81, focalLengthMm: 16.51 },
        stops: 3.2,
        measured: {
            photo: {
                limitingMagnitude: 8.1,
                sky: 0.000151,
                skyColor: [0.74, 1.78],
                milkyWay: 0.000303,
                horizon: 0.000545,
                horizonColor: [0.91, 1.29],
                starColor: 0.05,
                sharpness: 0.99,
                halo: 7.2,
            },
            drawn: {
                limitingMagnitude: 9.3,
                sky: 0.000306,
                skyColor: [0.69, 2.13],
                milkyWay: 0.000376,
                horizon: 0.00244,
                horizonColor: [1.27, 0.91],
                starColor: 1.26,
                sharpness: 0.86,
                halo: 14.4,
            },
        },
        when: "January 20, 2020, 04:48 local time",
        where: "near Mount Taranaki, New Zealand",
        author: "Dave Young",
        license: "CC BY 2.0",
        licenseUrl: BY_2,
        matches:
            "A waning Moon, 27% lit and 28° up, lights the air, and both skies are blue: red 0.74 and blue 1.78 of green in the photograph, 0.69 and 2.13 drawn, the color dunstkreis gives moonlight, none set by hand. The Moon is drawn a third of a degree from the middle of the photograph's glare, the Milky Way adds 21.2 magnitudes per square arcsecond against the photograph's 21.4, and 588 stars fit to 1.2 arcminutes, a quarter of a pixel.",
        differs:
            "Low over the horizon, towards a Sun 15° under it, dunstkreis draws a warm band of twilight at least 4.5 times as bright as the pale blue the photograph shows there, and more than twice as bright against each picture's own sky above: a disagreement for dunstkreis, which the twilight photograph shows too. The sky between the stars is drawn twice as bright as the photograph's, which is processed hard, its stars 3.2 stops over what f/4, 10 s and ISO 3200 give, and smoke drifts through it. The Moon is drawn as the eye sees it, a crescent, where the camera burns it out, and Mars, the point lower left of Antares, is missing.",
    },
    {
        label: "the Watzmann, 20 mm",
        page: "https://commons.wikimedia.org/wiki/File:Bischofswiesen_(DE),_Watzmann_--_2024_--_0048.jpg",
        original:
            "https://upload.wikimedia.org/wikipedia/commons/3/39/Bischofswiesen_%28DE%29%2C_Watzmann_--_2024_--_0048.jpg",
        file: "watzmann-2024-08-16-bischofswiesen.webp",
        width: 1600,
        height: 1080,
        // The camera's clock, 01:45:11 on August 16, 2024, in Central European Summer Time, a second behind its GPS,
        // which gives the place; the height from the terrain there. The frame is cut from the sensor's, 5,566 pixels of
        // its 6,000 wide, so the lens' axis is fitted too.
        date: "2024-08-15T23:45:11Z",
        place: { latitude: 47.641649, longitude: 12.981668, heightM: 681 },
        camera: {
            name: "Sony A9 II, FE 20 mm f/1.8 G",
            focalLengthMm: 20,
            sensorWidthMm: 35.6,
            widthPx: 6000,
            fNumber: 1.8,
            seconds: 13,
            iso: 1250,
        },
        azimuth: 215.509,
        altitude: 27.728,
        roll: 1.9,
        fieldOfView: 77.932,
        fit: { stars: 220, residual: 3.44, residualPx: 0.99, distortion: 0.94, focalLengthMm: 19.79 },
        stops: 0.9,
        measured: {
            photo: {
                limitingMagnitude: 6.8,
                sky: 0.000109,
                skyColor: [0.36, 2.41],
                milkyWay: 0.0000824,
                horizon: 0.000167,
                horizonColor: [1.02, 1.62],
                starColor: 0,
                sharpness: 0.78,
                halo: 5.8,
            },
            drawn: {
                limitingMagnitude: 10.8,
                sky: 0.000025,
                skyColor: [1.02, 1.32],
                milkyWay: 0.0002,
                horizon: 0.000116,
                horizonColor: [1.34, 0.79],
                starColor: 1.17,
                sharpness: 0.78,
                halo: 11.7,
            },
        },
        when: "August 16, 2024, 01:45 local time",
        where: "Bischofswiesen, Bavaria",
        author: "Anil Öztas",
        license: "CC BY 4.0",
        licenseUrl: BY_4,
        matches:
            "Its place and moment come from GPS, to the second, and 220 stars fit to 3.4 arcminutes, a pixel of this picture. Its stars are 0.9 stops brighter than f/1.8, 13 s and ISO 1250 give, little more than the JPEG of Orion, though Capture One made this one, and a faint star's image is as wide in both, 2.3 arcminutes.",
        differs:
            "The Moon, 82% lit, had set 4° under the horizon behind the mountains, and the photograph's sky still glows blue with its light: 22.5 magnitudes per square arcsecond against 24.1 drawn, four times as bright, red 0.36 and blue 2.41 of green against a pale blue-gray. In that sky the photograph keeps half of its stars only to magnitude 6.8, where sternenheer draws them to 10.8, the mountains hiding some, and its Milky Way stands out two to one against the sky, where sternenheer's does nine to one. The stars' colors are gone from the photograph, 0.00 magnitudes per B-V against 1.17 drawn, and Altair's halo is drawn twice as wide, 12 against 6 arcminutes.",
    },
    {
        label: "twilight, 17 mm",
        page: "https://commons.wikimedia.org/wiki/File:Sirius,_Orion_and_Venus_(49788085662).jpg",
        original: "https://upload.wikimedia.org/wikipedia/commons/5/54/Sirius%2C_Orion_and_Venus_%2849788085662%29.jpg",
        file: "twilight-2020-04-17-bela-krajina.webp",
        width: 1600,
        height: 1074,
        // The camera's clock, 20:02:18 on April 17, 2020, an hour behind the daylight time in use, as the stars show: only
        // an hour later they put the ridge 8 km to the southwest where it stands on the sky, 2.4° up; by the clock as it
        // reads they would lift it to 9.6°. Right to some 5 minutes. The place as tagged.
        date: "2020-04-17T19:02:18Z",
        place: { latitude: 45.630455, longitude: 15.200035, heightM: 201 },
        camera: {
            name: "Nikon D500, AF-S DX 17-70 mm f/2.8-4 at 17 mm",
            focalLengthMm: 17,
            sensorWidthMm: 23.5,
            widthPx: 5568,
            fNumber: 2.8,
            seconds: 15,
            iso: 1000,
        },
        band: false,
        landmark: { name: "the ridge 8 km to the southwest", at: [0.143, 0.793], azimuth: 225.3, altitude: 2.44 },
        azimuth: 249.529,
        altitude: 18.187,
        roll: -1.19,
        fieldOfView: 66.111,
        fit: { stars: 600, residual: 0.62, residualPx: 0.22, distortion: 1.84, focalLengthMm: 17.61 },
        stops: 0.8,
        measured: {
            photo: {
                limitingMagnitude: 7.7,
                sky: 0.000539,
                skyColor: [0.1, 4.59],
                milkyWay: 0,
                horizon: 0.00173,
                horizonColor: [2.74, 1.35],
                starColor: 0.01,
                sharpness: 0.81,
                halo: 22.3,
            },
            drawn: {
                limitingMagnitude: 9.6,
                sky: 0.000561,
                skyColor: [0.67, 2.64],
                milkyWay: 0,
                horizon: 0.00896,
                horizonColor: [1.19, 1.02],
                starColor: 1.21,
                sharpness: 0.79,
                halo: 9.9,
            },
        },
        when: "April 17, 2020, 21:02 local time",
        where: "Bela krajina, Slovenia",
        author: "Uroš Novina",
        license: "CC BY 2.0",
        licenseUrl: BY_2,
        matches:
            "Twilight, the Sun 12.6° under the horizon, and the sky between the stars as bright in both, 20.8 and 20.7 magnitudes per square arcsecond, and blue in both: red 0.10 and blue 4.59 of green in the photograph, 0.67 and 2.64 drawn. The camera's clock ran on standard time: only an hour later the stars put the ridge 8 km to the southwest where the terrain has it, 2.4° up. 600 stars fit to 0.6 arcminutes, a fifth of a pixel, and the stars are 0.8 stops brighter than f/2.8, 15 s and ISO 1000 give.",
        differs:
            "Low over the horizon, towards the Sun, dunstkreis draws the twilight five times as bright as the photograph shows it, warm and burnt out at white, where the photograph's sky stays blue: as in the moonlit photograph, a disagreement for dunstkreis. The pink low in the southwest lies on thin clouds, which nothing draws. In the bright sky the photograph loses the stars at magnitude 7.7, sternenheer at 9.6. Sirius' halo is drawn less than half as wide, 10 against 22 arcminutes, and Venus, the brightest point, is missing: sternenheer has no planets yet.",
    },
    {
        label: "the Pleiades, 150 mm",
        page: "https://commons.wikimedia.org/wiki/File:Plejaden.Sternenpark.Westhavelland.P1022928.jpg",
        original: "https://upload.wikimedia.org/wikipedia/commons/2/21/Plejaden.Sternenpark.Westhavelland.P1022928.jpg",
        file: "pleiades-2020-03-23-westhavelland.webp",
        width: 1600,
        height: 1200,
        // The camera's clock, 21:57:29 on March 23, 2020, in Central European Time, the zone the file notes. The page
        // names only the dark sky reserve, taken here at Gülpe, its darkest corner: kilometers either way move no star.
        date: "2020-03-23T20:57:29Z",
        place: { latitude: 52.7368, longitude: 12.2305, heightM: 23 },
        camera: {
            name: "Panasonic Lumix DC-GH5S, M.Zuiko 40-150 mm f/2.8 at 150 mm",
            focalLengthMm: 150,
            sensorWidthMm: 17.3,
            widthPx: 3680,
            fNumber: 2.8,
            seconds: 2,
            iso: 12800,
        },
        band: false,
        azimuth: 285.79,
        altitude: 18.56,
        roll: -2.64,
        fieldOfView: 6.536,
        fit: { stars: 85, residual: 0.11, residualPx: 0.46, distortion: 0.04, focalLengthMm: 151.33 },
        stops: -0.4,
        measured: {
            photo: {
                limitingMagnitude: 10.5,
                sky: 0,
                skyColor: [1, 1],
                milkyWay: 0,
                horizon: 0,
                horizonColor: [1, 1],
                starColor: NaN,
                sharpness: 0.78,
                halo: 1.2,
            },
            drawn: {
                limitingMagnitude: 10.5,
                sky: 0,
                skyColor: [1, 0],
                milkyWay: 0,
                horizon: 0,
                horizonColor: [1, 1],
                starColor: NaN,
                sharpness: 0.77,
                halo: 1.2,
            },
        },
        when: "March 23, 2020, 21:57 local time",
        where: "Westhavelland Dark Sky Reserve, Germany",
        author: "Bautsch",
        license: "CC0",
        licenseUrl: CC0,
        matches:
            "The longest lens of the six, its frame 6.5° wide, as narrow as a 300 mm lens draws on 35 mm film: 85 stars fit to a tenth of an arcminute, half a pixel of this picture, and both pictures show every star of the catalog in the frame, down to magnitude 10.5, where the catalog thins out. Its stars are 0.4 stops fainter than f/2.8, 2 s and ISO 12800 give, and a faint star's image and Alcyone's halo are as wide in both, 0.2 and 1.2 arcminutes.",
        differs:
            "The photograph's processing has cut its sky to black, so neither the sky's brightness nor its color can be held against sternenheer's, and the cluster's stars are too bright for its pixels to show their colors. It shows many stars fainter than the catalog's, which Tycho-2 adds.",
    },
];
