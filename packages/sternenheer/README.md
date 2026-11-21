# @himmelszelt/sternenheer

The stars for a WebGPU sky, as they look tonight: the 9,093 stars of the Yale Bright Star Catalogue, every star the
naked eye can see, and the Milky Way behind them, drawn by compute passes over your sky into a texture you own.
Each star's light is its illuminance at the eye in lux, from its magnitude, spread over its image on the screen, so the
stars expose like the sky around them and the Moon over them; the Milky Way is NASA's map of Gaia's faint stars,
calibrated to the integrated starlight. The air lifts the stars near the horizon, dims and reddens them, hides what
lies below the horizon it shows, and makes them twinkle. It creates no device, canvas or context, and depends on no
other package at runtime: the moment and the place come in as one rotation, from
[`@himmelszelt/sternzeit`](../sternzeit) on the himmelszelt site, the sky in cd/m² from
[`@himmelszelt/dunstkreis`](../dunstkreis), and the air as dunstkreis' air table and seeing, whose WGSL lookups the
package bundles at build time.

*Sternenheer* is the old poetic German word for the host of stars.

## What it draws

- **The stars**, each at its illuminance in lux, `illuminanceFromMagnitude`: a magnitude 0 star gives some 2.6
  millionths of a lux, five magnitudes are a factor of a hundred, the Sun at -26.74 the 128,000 lux dunstkreis
  starts from. The light is spread over the star's image, a Gaussian of a width in pixels you name, `psfPixels`, the
  viewer's own blur on the screen, never narrower than a pixel, so a pixel holds the luminance that makes the exposure
  right: a faint star is a dim point, a star brightens as the view zooms in, as it
  does in a telescope, and what the exposure cannot show is gone, as it is for the eye. No magnitude limit decides
  what shows, the light does; `magnitudeLimit` is there to leave stars out on purpose.
- **Their colors**, from the color index B-V in the catalog by way of a temperature and the Planckian locus,
  `colorFromColorIndex`, Ballesteros' temperature, which the shipped catalog holds, or Jensen et al.'s.
- **Points, not discs**: a star's core stops at a knee, display white by default (`knee`, against `displayEV100`
  when a later pass exposes), and the light beyond goes into a halo, so a brighter star, or one zoomed in on, grows a
  wider halo, never a fatter core. The halo shows `halo` of that light, 1 by default, all of it and no more: it moves
  light and adds none. Its profile is the eye's glare, a Moffat profile of β 3/2 that falls with the cube of the
  distance as CIE's glare equation does, 0.1 arcminutes of the viewer's field wide (against `viewerFov`), fitted to
  photographs and fixed, so narrow that it is the finest level the grid draws, so a halo is as wide on the screen at any resolution. It is drawn as Gaussians on a grid at half the
  target's size, halved level by level and added back up, each level its share of the profile: one cost whatever the
  number of stars. Only its display is shaped, rising with the logarithm of its light. `halo: 0` skips its passes and
  frees their memory.
- **Artistic offsets**, `starCompensation` and `milkyWayCompensation`, in stops: 0, the default, is physical, and
  anything else a deliberate departure, the layer's light times 2^stops before the exposure, so they compose with
  EV100 and with nachtgestirn's `exposureCompensation`. The stars' offset acts before the knee, the faint and deep
  stars' too, so bright stars grow their halos and faint ones come up, as in a longer exposure.
- **The viewer's veil**, CIE's glare equation of a point source by the angle on the viewer's own field of view,
  `glare` and `viewerFov`, off by default: at the angle of a pixel it counts the viewer's own scatter twice.
- **The Milky Way**: the Milky Way layer of NASA's Deep Star Maps 2020, the light of the stars of Gaia DR2 too faint
  for the catalog, in J2000 equatorial coordinates, 2048 or 4096 texels around, calibrated so that map and catalog
  together give the integrated starlight Masana et al. (2021) measured: a texel of value 1 is 1.16 thousandths of a
  cd/m², the brightest 2° of the band 20.3 magnitudes per square arcsecond.
- **The sky turning**: one rotation from the catalog's J2000 frame into your ENU frame, `skyRotation`, precession and
  sidereal time in one, as sternzeit's `stars.horizontalMatrix` gives it; the stars' own proper motion is applied per
  star from `years` since J2000.0.
- **The air**, `air`: dunstkreis' air table for the observer's height, `{ texture: createAirTexture(device, table),
  horizon: table.horizon }` from `airTable(model, heightM)`. The refraction lifts every star, some 34 arcminutes on
  the horizon, and the Milky Way is looked up along the unbent ray; the extinction dims and reddens both, and below
  the lowest ray that reaches space nothing is drawn. Where the bend squeezes the sky a star's light is spread
  thinner, by a fifth on the horizon and ten times on the limb's edge from orbit; a surface, the Milky Way, keeps its
  brightness. The color spread is dunstkreis' too, one dispersion for every package.
- **The twinkling**, `seeing`: dunstkreis' `seeingUniformData(seeing)`, its physical defaults a fair night and the
  eye, with `speed` the observer's own across the line of sight above the atmosphere, 7.7 km/s in the space station's
  orbit. Each star's light flickers lognormally by the turbulence along its ray, 8% at the zenith, 17% at 30° up,
  39% at 10°, its colors coming apart low down into the flashes a low Sirius throws; `scintillation` scales the
  flicker's variance by its square, 1 as the seeing gives it. Through the air only: without `air`, no twinkling.
- **Fainter stars**, optional: `loadFaintStars` gives the 108,883 stars of the Hipparcos catalogue the shipped catalog
  does not hold, to magnitude 12 or so, 579 KB, six bytes a star: `faintStars` on the pass draws them through the
  same passes, and the parameter of that name how many, the brightest first. `packStars` packs any others the full
  way. Not shipped: see [the data](#the-data).
- **Compact and full**: every catalog comes in two layouts, and `loadCatalog`, `loadFaintStars` and `loadDeepStars`
  fetch the compact one unless given `"full"` (or a file's URL, whose layout they tell themselves). Compact, the Yale
  catalog keeps its magnitudes, colors and proper motions as listed and its positions within 0.16 arcseconds, in 12
  bytes a star; the Hipparcos and Tycho-2 stars are sorted into 384 cells of the sky and stand within 0.6 arcseconds
  of their full place, 6 bytes a star. The files shrink to 89 KB, 579 KB and 12.0 MB from 208 KB, 701 KB and 14.1 MB;
  on the GPU the deep stars hold 4.5 MiB less, the Hipparcos stars 0.4 MiB more. The pass takes either for each
  catalog and builds its shaders for the layouts it gets; `setCatalog` takes the one the pass was made with.
- **The constellations**, optional: `loadConstellations` gives the 743 lines of the 88 constellations between stars of
  the shipped catalog, and `constellations` on the pass and in the parameters draws them, all, a set such as `ZODIAC`,
  or a few by their abbreviations. A muted hint on the display, the same at any exposure, each line stopping short of
  its two stars; `constellationOpacity`, `constellationColor`, `constellationWidth` and `constellationGap` set its look.
- **Night vision**: `darkAdapted` on the pass turns the composed light into what the eye sees, helldunkel's blue
  shift for the rods.
- **Tiles**: the first pass bins every star's image into the tiles of the target it reaches, the last sums the
  stars of each pixel's tile and the Milky Way behind, so a pixel costs the stars near it rather than the catalog. A
  tile holds `capacity` stars; a full one keeps its brightest, the same ones every frame.
- **For figures and debuggers**: `readStars(first, count)` reads how the last frame drew a star, its light at the eye
  and the shares its core and its halo show; `setCatalog` replaces the catalog of a pass already made. With `debug`
  on the pass, `inspect()` hands out what a frame left between its passes: each tile's count of stars and of line
  pieces, the halos' levels, how many stars were drawn and passed the knee, and each pass' milliseconds on the GPU's
  clock where the device has "timestamp-query". Off, nothing of it is kept or timed.

## Quick start

```ts
import { airTable, createAirTexture, DEFAULT_ATMOSPHERE_MODEL, seeingUniformData } from "@himmelszelt/dunstkreis";
import { createStarsPass, loadCatalog, loadMilkyWay } from "@himmelszelt/sternenheer";

const catalog = await loadCatalog();
const milkyWay = await loadMilkyWay(device);
const pass = await createStarsPass(device, { format: "rgba8unorm", catalog, milkyWay });
// Once per observer height: the air, and how it makes the stars twinkle.
const table = airTable(DEFAULT_ATMOSPHERE_MODEL, heightM);
const air = { texture: createAirTexture(device, table), horizon: table.horizon };
const seeing = seeingUniformData();
// Per frame: the moment and the place as one rotation, the camera, the exposure, the time.
pass.update({ skyRotation, years, inverseViewProjection, ev100: -9, air, seeing, time });
pass.encode(encoder, target, { background: skyInCandelaPerSquareMeter });
```

The pass writes into a target with `STORAGE_BINDING` usage, tone mapped for a display by default, or linear with
`toneMap: false` for a renderer that composes more over it, such as nachtgestirn's Moon. The raw WGSL is exported as
`wgsl` for inlining into pipelines of your own.

## The data

`data/` holds what the package draws, with a README on where each file comes from and `data/LICENSE.md` on its terms:
the Yale catalog (`brightstars-compact.bin.gz`, 89 KB, `brightstars.bin.gz`, 208 KB, and its CSV), the
constellations' lines and the Milky Way's maps, shipped; and, not shipped, the Hipparcos stars
(`hipparcos-compact.bin.gz`, 579 KB, `hipparcos.bin.gz`, 701 KB) and the Tycho-2 stars (`tycho-compact.bin.gz`, 12.0 MB,
`tycho.bin.gz`, 14.1 MB). Each script writes both layouts; the constants `BRIGHT_STARS`, `HIPPARCOS` and `TYCHO` hold
the URLs of both, `{ compact, full }`. ESA's two catalogues come under CC BY-NC 3.0 IGO, credit "ESA", for non-commercial use only, which is not
this package's MIT license, so you make them yourself, accepting ESA's terms:

```sh
npx @himmelszelt/sternenheer data hipparcos tycho   # 15 MB and 200 MB downloaded once
```

That writes them into the installed package's `data/`, where `loadFaintStars` and `loadDeepStars` find them; `--out
<dir>` writes them elsewhere for a server to host, `--cache <dir>` keeps the downloads, by default in
`node_modules/.cache/sternenheer`, and each run prints the terms and the credit. The catalogs are byte planes, gzip
compressed, which the loaders unpack with `DecompressionStream`; serve the `.gz` files as they are. In the repository
`pnpm assets` makes the files not checked in, `pnpm assets --all` every one, `pnpm data` remakes the shipped ones, and
`pnpm data:catalog`, `data:hipparcos`, `data:tycho`, `data:constellations` and `data:milkyway` each its own; a script does
nothing while its output is newer than its inputs.

The Milky Way ships at 2048 and 4096 texels around. NASA's own 8K map makes a larger one, not shipped, fetched from the
asset mirror (github.com/cgcostume/himmelszelt-assets), or with `--build` built with `sharp` (`npm install sharp`):

```sh
npx @himmelszelt/sternenheer data milkyway --size 8k    # 19 MB fetched; built: 137 MB downloaded, 1.3 GB of memory
```

`loadMilkyWay(device, MILKY_WAY_MAPS["8k"])` then uploads it, 171 MiB on the GPU with its mipmaps, a texel 2.6
arcminutes, worth it where a pixel spans less than the 4K map's 5.3: a view narrower than 79° across 1080 pixels. A map
not built throws, naming the command. A texel of value 1 stands for `MILKY_WAY_LUMINANCE` in every map, and every
map's stars are found on the same grid of 4096 texels around.

## License

MIT for the code. The data keeps its own terms, `data/LICENSE.md`: the Yale catalog as NASA's HEASARC distributes it,
the Hipparcos and Tycho-2 catalogues ESA's CC BY-NC 3.0 IGO, the constellations' lines d3-celestial's BSD 3-Clause,
the Milky Way NASA's.
