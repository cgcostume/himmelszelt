# The stars and the Milky Way

`brightstars.csv` (9,093 stars: `vmag,ra,de,pmRa,pmDe,sRgbR,sRgbG,sRgbB`) is the checked-in source of truth, the Yale
Bright Star Catalogue, fifth revised edition (Hoffleit & Warren 1991), by way of osgHimmel's `brightstars.cpp`: the
visual magnitude, right ascension in hours and declination in degrees at J2000.0, the proper motions in arcseconds a
year (the one in right ascension on the sky, times cos δ), and a linear sRGB color at unit luminance osgHimmel
computed from each star's B-V by Jensen et al.'s temperature and the Planckian locus, `colorFromColorIndexApprox`.

`brightstars.bin` is made from it by `pnpm catalog`: a flat little-endian `Float32Array` of eight fields per star in
the same order, with the right ascension in degrees, as the pass reads it. Rerun it whenever the CSV changes.

`milkyway-4k.webp` and `milkyway-2k.webp` are made by `pnpm milkyway` from NASA's Deep Star Maps 2020
(https://svs.gsfc.nasa.gov/4851), credit NASA's Scientific Visualization Studio: its Milky Way background layer, the
light of the stars of Gaia DR2 fainter than the Hipparcos and Tycho stars, in J2000 equatorial coordinates, plate
carrée with right ascension increasing to the left, sRGB-encoded 8-bit. `milkyway.json` holds the calibration the
script prints: what a texel of value 1 stands for in cd/m², found by matching the map plus the catalog along the band
of declination 35° to 45° to the integrated starlight Masana et al. (2021) give for the zenith of 40° N over a year.
