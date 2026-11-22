# Licenses of the site

The site in this folder, sternwarte, mixes code, writing and material by others. Each part has its own license.

## Code: MIT

All code is under the MIT License, the same as the libraries in `packages/`; see [`../LICENSE`](../LICENSE). This
covers the site's components, figures, scripts and styles, and every code example in the chapters, so you can copy
those freely.

## Text and figures: CC BY 4.0

The writing and the figures are © Daniel Limberger, licensed under
[Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/) (CC BY 4.0). This
covers:

- the chapters' prose in `src/content/`, except their code examples;
- the prose of the figures, wherever it lives in `src/`: captions, labels, notes and experiments;
- the glossary's entries in `src/data/glossary.json`;
- the figures as the site renders them, as images.

To reuse any of it, credit "Daniel Limberger, himmelszelt" with a link to the chapter and to the license.

## Material by others

Photographs, maps and data by others keep their own terms and are not covered by either license above. Each is
credited where the site shows it.

| Files | Source | Terms |
|---|---|---|
| `public/eclipse-2008/` | Theodore Yapo and Barbara Cutler, from their paper on rendering lunar eclipses (2009) | © the authors |
| `public/images/corona-2023-04-20-exmouth.webp` | Phil Hart | © the photographer |
| `src/components/hero/plane.webp` | schauhi, a photograph of an aircraft and its contrail, Pixabay 7206856; the aircraft cut out of the sky and scaled down | Pixabay Content License |
| `public/images/sunrise-2015-07-30-iss.webp` | NASA, ISS044-E-025484, Scott Kelly | public domain |
| `public/images/glossary-astrolabe.webp` | The Metropolitan Museum of Art, Open Access | CC0 |
| `public/stars/milky-way-2017-08-18-inferno-cone.webp` and its `-thumb` | NPS / Jacob W. Frank, [Milky Way From Inferno Cone](https://commons.wikimedia.org/wiki/File:Milky_Way_From_Inferno_Cone_(4fc3421b-c931-4347-a4f6-7b5806c41456).jpg), Wikimedia Commons from NPGallery; resampled to a lens without distortion and scaled down | public domain |
| `public/stars/orion-2022-01-02-arcavell.webp` and its `-thumb` | Xaviaranda, [La constel·lació de Orió i l'estrella Betelgeuse](https://commons.wikimedia.org/wiki/File:La_constel%C2%B7laci%C3%B3_de_Ori%C3%B3_i_l%27estrella_Betelgeuse.jpg), Wikimedia Commons; resampled to a lens without distortion and scaled down | CC BY-SA 4.0, as are these adaptations |
| `public/stars/moonlit-2020-01-20-taranaki.webp` and its `-thumb` | Dave Young, [Moonlit night sky looking south](https://commons.wikimedia.org/wiki/File:Moonlit_night_sky_looking_south_(49458657118).jpg), Wikimedia Commons from Flickr; resampled to a lens without distortion, cut to the frame around its lens' axis and scaled down | CC BY 2.0 |
| `public/stars/watzmann-2024-08-16-bischofswiesen.webp` and its `-thumb` | Anil Öztas, [Bischofswiesen (DE), Watzmann -- 2024 -- 0048](https://commons.wikimedia.org/wiki/File:Bischofswiesen_(DE),_Watzmann_--_2024_--_0048.jpg), Wikimedia Commons; resampled to a lens without distortion, centered on its lens' axis and scaled down | CC BY 4.0 |
| `public/stars/twilight-2020-04-17-bela-krajina.webp` and its `-thumb` | Uroš Novina, [Sirius, Orion and Venus](https://commons.wikimedia.org/wiki/File:Sirius,_Orion_and_Venus_(49788085662).jpg), Wikimedia Commons from Flickr; resampled to a lens without distortion and scaled down | CC BY 2.0 |
| `public/stars/pleiades-2020-03-23-westhavelland.webp` and its `-thumb` | Bautsch, [Plejaden.Sternenpark.Westhavelland.P1022928](https://commons.wikimedia.org/wiki/File:Plejaden.Sternenpark.Westhavelland.P1022928.jpg), Wikimedia Commons; resampled to a lens without distortion and scaled down | CC0 |
| `public/moon/`, nachtgestirn's `moon-color-*.webp` and `moon-height-*.webp`, seen and whole | NASA's Scientific Visualization Studio, CGI Moon Kit | public domain |
| nachtgestirn's `moon-roughness-*.webp`, seen and whole | Rosenburg et al. (2011), LRO LOLA slope and Hurst exponent maps, NASA PDS Geosciences Node | public domain |
| sternenheer's `constellations.csv` and `.bin` | the constellations' figures of d3-celestial, Olaf Frohn, matched to the catalog's stars | BSD 3-Clause, `packages/sternenheer/data/LICENSE-d3-celestial.txt` |
| sternenheer's `brightstars.csv`, `.bin.gz` and `-compact.bin.gz`, and `public/stars/colors-yale.json`, its stars binned by B−V | The Yale Bright Star Catalogue, 5th revised edition, Hoffleit & Warren (1991), by way of osgHimmel and NASA's HEASARC | a U.S. Government work in NASA's data catalog; the catalog's own files name its authors as copyright holders, see `packages/sternenheer/data/LICENSE.md` |
| sternenheer's `hipparcos.csv`, `.bin.gz` and `-compact.bin.gz` | The Hipparcos Catalogue, ESA SP-1200 (1997), by way of NASA's HEASARC | [CC BY-NC 3.0 IGO](https://creativecommons.org/licenses/by-nc/3.0/igo/), credit "ESA"; not in the npm package |
| sternenheer's `tycho.bin.gz` and `tycho-compact.bin.gz` | The Tycho-2 Catalogue, Høg et al. (2000), by way of NASA's HEASARC | [CC BY-NC 3.0 IGO](https://creativecommons.org/licenses/by-nc/3.0/igo/), credit "ESA"; not in the npm package |
| `public/stars/colors-hipparcos.json` and `colors-tycho.json` | The Hipparcos Catalogue, ESA SP-1200 (1997), and the Tycho-2 Catalogue, Høg et al. (2000), by way of NASA's HEASARC: the stars binned by B−V and magnitude, Tycho-2's B−V converted from its BT and VT, and the brightest five of each bin | [CC BY-NC 3.0 IGO](https://creativecommons.org/licenses/by-nc/3.0/igo/), credit "ESA" |
| sternenheer's `milkyway-2k.webp`, `-4k` | NASA's Scientific Visualization Studio, Deep Star Maps 2020 (SVS 4851), its Milky Way layer, stars taken out and recalibrated | public domain |
| `public/stars/starmap-cygnus.webp` | NASA's Scientific Visualization Studio, Deep Star Maps 2020 (SVS 4851), its starred layer around Deneb, made from its other two layers and encoded as sternenheer's maps | public domain |
| `public/stars/starless-cygnus.webp` | NASA's Scientific Visualization Studio, Deep Star Maps 2020 (SVS 4851), its Milky Way background layer around Deneb as published, encoded as sternenheer's maps | public domain |
| `public/milkyway/` | NASA's Scientific Visualization Studio, Deep Star Maps 2020 (SVS 4851), its Milky Way layer: two patches of 384 texels, stars taken out as in sternenheer's maps, as half floats and in two 8-bit encodings | public domain |
| `src/data/cie1931-locus.json` | International Commission on Illumination (CIE), [CIE 1931 chromaticity coordinates of spectrum loci, 2 degree observer](https://doi.org/10.25039/CIE.DS.mifmy4x4), from CIE 018:2019, Table 6; every 5 nm from 360 to 700 nm and 780 nm | CC BY-SA 4.0, as is this excerpt |

The photographs the figures load from Wikimedia Commons are licensed as credited under each.
