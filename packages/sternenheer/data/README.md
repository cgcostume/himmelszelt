# The stars and the Milky Way

`brightstars.csv` (9,093 stars: `vmag,ra,de,pmRa,pmDe,bv`) is the checked-in source of truth, the Yale Bright Star
Catalogue, fifth revised edition (Hoffleit & Warren 1991): the visual magnitude, right ascension in hours and
declination in degrees at J2000.0, the proper motions in arcseconds a year (the one in right ascension on the sky,
times cos δ), all by way of osgHimmel's `brightstars.cpp`, and the color index B-V from the catalog itself. The catalog
lists no B-V for 310 of the stars: theirs is the typical one of their spectral type, a giant's from G on where the
type says so.

`brightstars.bin.gz` is made from it by `pnpm catalog`: a flat little-endian `Float32Array` of eight fields per star,
the first five as listed with the right ascension in degrees, then the star's linear sRGB color at unit luminance from
its B-V, as `colorFromColorIndex` computes it. Rerun it whenever the CSV changes. Beside it the script writes
`brightstars-compact.bin.gz`, the layout `loadCatalog` fetches by default: three little-endian Uint32 a star, 12 bytes,
the right ascension in 22 bits (0.31″ a step) and the magnitude in 10, hundredths from -2; the declination in 23 bits
(0.077″) and B-V in 9, hundredths from -0.5; the proper motions in right ascension and declination as Int16 in
milliarcseconds a year. The CSV's magnitudes, colors and motions to the last digit, its positions within 0.16″, under
its own rounding to a tenth of a second of time and a second of arc; 89 KB against 208 KB.

Every `.bin.gz` is the same container: gzip around an 8-byte header, the tag "SHBP" and the size of a record in bytes
as little-endian Uint32, then the records as byte planes, the first byte of every record, then the second of every
record, and so on. The loaders undo it with `DecompressionStream`; a server should send the files as they are.

`hipparcos.csv` (108,883 stars: `vmag,ra,de,bv`) holds the stars of the Hipparcos catalogue (ESA 1997, the main
catalogue as NASA's HEASARC serves it) that `brightstars.csv` does not: the Johnson V magnitude, the right ascension
and declination in degrees, ICRS, moved from the catalogue's epoch J1991.25 to J2000.0 by the proper motion, and B-V,
0.65 for the 1,139 stars without one. Brightest first. Left out are the 263 entries without a position or a magnitude
and the 9,072 within half an arcminute of a star of `brightstars.csv`, or within 1.5 arcminutes and 0.3 magnitudes of
one. `hipparcos.bin.gz` is made from it by `pnpm hipparcos`: two little-endian Uint32 a star, the right ascension in
24 bits and the magnitude in 8, the declination in 24 bits and B-V in 8, as `packStars` lays them out, records of 8
bytes. `hipparcos-compact.bin.gz`, the layout `loadFaintStars` fetches by default, sorts the same stars into cells as
`tycho-compact.bin.gz` below, 6 bytes a star, 579 KB. Neither is checked in nor in the npm package, for ESA's terms, CC BY-NC 3.0 IGO (`LICENSE.md`); the CSV is
kept here as the record, and outside the repository the script makes the same stars from HEASARC's table
(heasarc_hipparcos.tdat.gz, 15 MB, cached), byte for byte the CSV with `--download --csv`.

`tycho.bin.gz` and `tycho-compact.bin.gz` are not checked in, for their size, 14.1 and 12.0 MB, and not in the npm
package, for ESA's terms: `pnpm tycho` makes
it from the Tycho-2 catalogue (Høg et al. 2000, as NASA's HEASARC serves it, 200 MB cached in
`node_modules/.cache/sternenheer/tycho2`), and `.gitignore` here leaves it out. It holds the 2,420,098 stars of Tycho-2
that are neither Hipparcos stars nor within 5 arcseconds of a star of the two files above: Johnson's V and B-V from
Tycho's two bands, V = VT - 0.090 (BT - VT) and B-V = 0.850 (BT - VT), the mean position at J2000.0, or the one observed
around 1991.5 for the 4% without. Packed as `hipparcos.bin.gz`, the magnitude 13.875 at most, and sorted for the pass:
by 384 cells of the sky, the six faces of a cube cut 8 by 8, and brightest first within a cell, in blocks of 64 stars, a
cell's last block filled up with empty stars, both words all ones. A header of eight Uint32 (the tag "SHDS", the
version, stars, the block's size, blocks, cells, two zeros) and six words per cell (its stars, its blocks, the unit
vector to its middle and its stars' largest angle from it in radians, as floats) come first, all in records of 8 bytes.
The compact file holds the same stars in the same order, version 2 in the header, its seventh word the byte at which
the stars start, the header and cells filled up to whole records of 6 bytes: a star's place in its cell, 16 bits
across and 16 up from the cell's corner on the cube's face (a cell spans a quarter of the face's -1 to 1, so a step is
0.79″ at most, at the middle of a face), then the magnitude in sixteenths from -2 and B-V in hundredths from -0.5 in a
byte each, all ones for an empty star; within 0.6″ of the full file's places. The loader lays it out for the GPU in
blocks of 97 words, the cell, the 64 places, then two stars' codes a word. Without `hipparcos.csv` the script leaves
out the stars of `hipparcos.bin.gz` instead, to the same result. `--limit 11.5` keeps
the stars NASA's Milky Way map leaves out, 1.37 million in 11.0 MB: the map holds Gaia's stars from magnitude 11.5 on.

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

`milkyway-8k.webp` (8192 by 4096, 18.5 MB) is made on request by `pnpm milkyway --size 8k` from NASA's own 8K file of
the same layer, 137 MB, and is neither checked in nor in the npm package; `.gitignore` here leaves it out. NASA's
texels hold the light that falls into them, so the mean of a map halves twice from one size to the next: the script
scales each texel by its area against the 4K map's, and a texel of value 1 stands for the same luminance in both maps,
1.1554e-3 and 1.1556e-3 cd/m² as the script calibrates the 4K and the 8K map. Its stars are found on the map averaged
down to 4096 by 2048, by the same rule as the 4K map's, each texel within a star's texel brought down to its median,
and the light spread on that grid. NASA renders its stars a few texels wide at every size, sharper in angle the larger
the map, so more of them stand out on the grid: 487,205 texels of the 4K map, 3.2% of its light, and 685,760 of the 8K,
4.6%. NASA offers the layer at 16K, 32K and 64K too, 434 MB, 1.4 and 3.7 GB, for anyone who needs them; the script
builds none of them.
