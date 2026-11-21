# Licenses of the data

The package's code is MIT (`../LICENSE`). The data in this folder comes from others and keeps their terms, which the
MIT license does not cover. The scripts that make each file print its terms and the credit they ask for.

| Files | Source | Terms | Credit |
|---|---|---|---|
| `brightstars.csv`, `brightstars.bin.gz`, `brightstars-compact.bin.gz` | The Yale Bright Star Catalogue, 5th revised edition (Hoffleit & Warren 1991), by way of osgHimmel and the catalog's `catalog.dat`; [NASA HEASARC](https://heasarc.gsfc.nasa.gov/W3Browse/star-catalog/bsc5p.html), [CDS V/50](https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50) | NASA's data catalog lists HEASARC's copy as a [U.S. Government work](https://www.usa.gov/government-works) for public use; the catalog's own distribution names Hoffleit and Warren as its copyright holders and, as Debian quotes the Astronomical Data Center's conditions, asks that the files not be redistributed altered | "Hoffleit & Warren (1991), The Bright Star Catalogue, 5th revised ed., Yale University Observatory" |
| `hipparcos.csv`, `hipparcos.bin.gz`, `hipparcos-compact.bin.gz` (made, not shipped) | The Hipparcos Catalogue, ESA SP-1200 (1997), by way of NASA's HEASARC | [CC BY-NC 3.0 IGO](https://creativecommons.org/licenses/by-nc/3.0/igo/), [ESA](https://www.cosmos.esa.int/web/hipparcos/catalogues) | "ESA" |
| `tycho.bin.gz`, `tycho-compact.bin.gz` (made, not shipped) | The Tycho-2 Catalogue (Høg et al. 2000), by way of NASA's HEASARC | [CC BY-NC 3.0 IGO](https://creativecommons.org/licenses/by-nc/3.0/igo/), [ESA](https://www.cosmos.esa.int/web/hipparcos/catalogues) | "ESA" |
| `constellations.csv`, `constellations.bin` | The constellations' figures of [d3-celestial](https://github.com/ofrohn/d3-celestial), Olaf Frohn, matched to the catalog's stars | BSD 3-Clause, `LICENSE-d3-celestial.txt` | "d3-celestial, © 2015 Olaf Frohn" |
| `milkyway-2k.webp`, `milkyway-4k.webp`, `milkyway.json` | NASA's Deep Star Maps 2020, [SVS 4851](https://svs.gsfc.nasa.gov/4851), its Milky Way background layer, with its stars taken out and recalibrated | public domain, as NASA's Scientific Visualization Studio releases its media, credit requested | "NASA's Scientific Visualization Studio" |

ESA's catalogues allow sharing and adapting for non-commercial use only, with credit, which is not what an MIT package
promises. So the package ships neither the Hipparcos nor the Tycho-2 stars: you make them yourself, accepting ESA's
terms, with `npx @himmelszelt/sternenheer data hipparcos tycho`, which writes them here, where `loadFaintStars` and
`loadDeepStars` find them. In the repository, `pnpm assets` does the same.
