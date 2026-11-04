# @himmelszelt/sternenheer

The stars for a WebGPU sky, as they look tonight: the 9,093 stars of the Yale Bright Star Catalogue, every star the
naked eye can see, and the Milky Way behind them, drawn by two compute passes over your sky into a texture you own.
Each star's light is its illuminance at the eye in lux, from its magnitude, spread over its image on the screen, so the
stars expose like the sky around them and the Moon over them; the Milky Way is NASA's map of Gaia's faint stars,
calibrated to the integrated starlight. The air lifts the stars near the horizon, dims and reddens them, hides what
lies below the horizon it shows, and makes them twinkle. It creates no device, canvas or context, and depends on no
other package at runtime: the moment and the place come in as one rotation, from
[`@himmelszelt/sternzeit`](../sternzeit) on the himmelszelt site, the sky in cd/m² from
[`@himmelszelt/dunstkreis`](../dunstkreis), the air as two functions of the altitude.

*Sternenheer* is the old poetic German word for the host of stars.

## What it draws

- **The stars**, each at its illuminance in lux, `illuminanceFromMagnitude`: a magnitude 0 star gives some 2.6
  millionths of a lux, five magnitudes are a factor of a hundred, the Sun at -26.74 the 128,000 lux dunstkreis
  starts from. The light is spread over the star's image, a Gaussian of a width in pixels you name, `psfPixels`, the
  viewer's own blur on the screen, never narrower than a pixel, so a pixel holds the luminance that makes the exposure
  right: a bright star saturates its center, a faint one is a dim point, a star brightens as the view zooms in, as it
  does in a telescope, and what the exposure cannot show is gone, as it is for the eye. No magnitude limit decides
  what shows, the light does; `magnitudeLimit` is there to leave stars out on purpose.
- **Their colors**, from the color index B-V in the catalog by way of a temperature and the Planckian locus,
  `colorFromColorIndex`, Ballesteros' temperature or Jensen et al.'s, which the shipped catalog holds.
- **The viewer's veil**, CIE's glare equation of a point source by the angle on the viewer's own field of view,
  `glare` and `viewerFov`: Sirius throws a halo a degree wide.
- **The Milky Way**: the Milky Way layer of NASA's Deep Star Maps 2020, the light of the stars of Gaia DR2 too faint
  for the catalog, in J2000 equatorial coordinates, 2048 or 4096 texels around, calibrated so that map and catalog
  together give the integrated starlight Masana et al. (2021) measured: a texel of value 1 is 1.76 thousandths of a
  cd/m², the galactic center some 23 magnitudes per square arcsecond.
- **The sky turning**: one rotation from the catalog's J2000 frame into your ENU frame, `skyRotation`, precession and
  sidereal time in one, as sternzeit's `stars.horizontalMatrix` gives it; the stars' own proper motion is applied per
  star from `years` since J2000.0.
- **The air**, `airTable`, from two functions of the apparent altitude such as dunstkreis' `refractionAngle` and
  `airTransmittance`: the refraction lifts every star and the Milky Way, some 34 arcminutes on the horizon, the
  extinction dims and reddens them, and below the lowest ray that reaches space nothing is drawn. The table crowds
  its entries towards the horizon, where the air changes fastest.
- **The twinkling**, `scintillation`: each star's light flickers by the air's turbulence, by Young's scaling with the
  airmass to the power 1.75 as Dravins et al. give it, for the pupil and the eye's integration time, saturating towards
  the horizon, where the colors come apart into the flashes a low Sirius throws.
- **Night vision**: `nightVision` on the pass turns the composed light into what the eye sees, helldunkel's blue
  shift for the rods.
- **Tiles**: the first pass bins every star's image into the tiles of the target it reaches, the second sums the
  stars of each pixel's tile and the Milky Way behind, so a pixel costs the stars near it rather than the catalog.

## Quick start

```ts
import { airTable, createStarsPass, loadCatalog, loadMilkyWay } from "@himmelszelt/sternenheer";

const catalog = await loadCatalog();
const milkyWay = await loadMilkyWay(device);
const pass = await createStarsPass(device, { format: "rgba8unorm", catalog, milkyWay });
// Per frame: the moment and the place as one rotation, the camera, the exposure, the air.
pass.update({ skyRotation, years, inverseViewProjection, ev100: -9, air: airTable(bend, transmittance) });
pass.encode(encoder, target, { background: skyInCandelaPerSquareMeter });
```

The pass writes into a target with `STORAGE_BINDING` usage, tone mapped for a display by default, or linear with
`toneMap: false` for a renderer that composes more over it, such as nachtgestirn's Moon. The raw WGSL is exported as
`wgsl` for inlining into pipelines of your own.

## The data

`data/` holds the catalog as CSV and binary and the Milky Way's maps, with a README on where they come from; `pnpm
catalog` and `pnpm milkyway` remake them.

## License

MIT. The catalog is the Yale Bright Star Catalogue's, the Milky Way NASA's.
