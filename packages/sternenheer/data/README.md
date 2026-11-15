# The stars and the Milky Way

`brightstars.csv` (9,093 stars: `vmag,ra,de,pmRa,pmDe,bv`) is the checked-in source of truth, the Yale Bright Star
Catalogue, fifth revised edition (Hoffleit & Warren 1991): the visual magnitude, right ascension in hours and
declination in degrees at J2000.0, the proper motions in arcseconds a year (the one in right ascension on the sky,
times cos δ), all by way of osgHimmel's `brightstars.cpp`, and the color index B-V from the catalog itself. The catalog
lists no B-V for 310 of the stars: theirs is the typical one of their spectral type, a giant's from G on where the
type says so.

`brightstars.bin` is made from it by `pnpm catalog`: a flat little-endian `Float32Array` of eight fields per star, the
first five as listed with the right ascension in degrees, then the star's linear sRGB color at unit luminance from its
B-V, as `colorFromColorIndex` computes it. Rerun it whenever the CSV changes.

`hipparcos.csv` (108,883 stars: `vmag,ra,de,bv`) holds the stars of the Hipparcos catalogue (ESA 1997, the main
catalogue as NASA's HEASARC serves it) that `brightstars.csv` does not: the Johnson V magnitude, the right ascension
and declination in degrees, ICRS, moved from the catalogue's epoch J1991.25 to J2000.0 by the proper motion, and B-V,
0.65 for the 1,139 stars without one. Brightest first. Left out are the 263 entries without a position or a magnitude
and the 9,072 within half an arcminute of a star of `brightstars.csv`, or within 1.5 arcminutes and 0.3 magnitudes of
one. `hipparcos.bin` is made from it by `pnpm hipparcos`: two little-endian Uint32 a star, the right ascension in 24
bits and the magnitude in 8, the declination in 24 bits and B-V in 8, as `packStars` lays them out.

`constellations.csv` (743 lines: `constellation,from,to`) holds the constellations' lines: the IAU abbreviation and the
two stars a line joins, as rows of `brightstars.csv` counted from 0. The figures are d3-celestial's
(https://github.com/ofrohn/d3-celestial, Olaf Frohn, BSD 3-Clause), each of its points matched to the catalog's star
there, all within half an arcminute. `constellations.bin` is made from it by `pnpm constellations`: little-endian
Uint16 triples, the constellation's index among the sorted abbreviations and the two stars.
d3-celestial's license is in `LICENSE-d3-celestial.txt`.

`milkyway-4k.webp` and `milkyway-2k.webp` are made by `pnpm milkyway` from NASA's Deep Star Maps 2020
(https://svs.gsfc.nasa.gov/4851), credit NASA's Scientific Visualization Studio: its Milky Way background layer, the
light of the stars of Gaia DR2 fainter than the Hipparcos and Tycho stars, in J2000 equatorial coordinates, plate
carrée with right ascension increasing to the left. Each channel holds its logarithm in 8 bits, 12 stops below 1, so
the dark sky between the clouds keeps as many steps as the clouds. The texels that stood out as stars, 2.5 times the
median of the 5 by 5 around them, are taken down to it and their light is spread over the sky around them.
`milkyway.json` holds the calibration the script prints: what a texel of value 1 stands for in cd/m², found by
matching the map, the catalog and the Hipparcos stars along the band of declination 35° to 45° to the integrated
starlight Masana et al. (2021) give for the zenith of 40° N over a year. The Hipparcos stars are a quarter of the
starlight there: a renderer that draws none shows a sky that much short.
