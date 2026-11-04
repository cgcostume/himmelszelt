# @himmelszelt/nachtgestirn

The Moon for a WebGPU sky, as it looks tonight: one compute pass draws its disc along every pixel's ray, over your sky,
into a texture you own. Its phase comes from the Sun's direction, its face is turned by the libration and the position
angle of its axis, its night side glows in earthshine, and in Earth's shadow it darkens and reddens as it does in a
lunar eclipse. The surface is shaded by Hapke's lunar reflectance law, the one Jensen et al. used in their night sky
model, over NASA's maps of the Moon's color and relief. It creates no device, canvas or context, and depends on no
other package at runtime: the astronomy comes in as directions and angles, from
[`@himmelszelt/sternzeit`](../sternzeit) on the himmelszelt site, the sky in cd/m² from
[`@himmelszelt/dunstkreis`](../dunstkreis).

*Nachtgestirn* is the German word for a luminary of the night, above all the Moon.

## What it draws

- **The disc**, antialiased at its limb, as a sphere at the Moon's apparent angular diameter, so its size follows the
  month and the hour, and hidden below the horizon you name.
- **The light**: the Sun's illuminance at the Moon in lux times the surface's reflectance. Hapke's law (Lommel-Seeliger
  with an opposition surge and a little forward scattering, after Jensen et al. 2001) keeps the full Moon as bright at
  its edge as in its middle, where Lambert's law, offered to compare, would darken the limb like a billiard ball. A
  point seen straight on at opposition reflects its normal albedo like a Lambert surface, so a full Moon of geometric
  albedo 0.12 in 128,000 lux is some 4,900 cd/m² before the air, as measured.
- **Earthshine**, Earth's illuminance at the Moon in lux: `earthshineIlluminance` gives it from Earth's phase as the
  Moon sees it, some 13 lux for a full Earth, a ten thousandth of the Sun.
- **Earth's shadow**: per point of the surface, the share of the Sun's disc Earth leaves uncovered, which is the
  penumbra, plus the sunlight Earth's atmosphere bends into the umbra, copper in the middle and turquoise at the rim
  where ozone takes the orange out. The radii come from `eclipse.lunar` of sternzeit, the geometry is yours to hand
  over.
- **The air**: a transmittance per channel along the line of sight dims and reddens the disc, and the sky you compose
  it over adds its light in front.

## The maps

`pnpm maps <outDir>` makes them from NASA's [CGI Moon Kit](https://svs.gsfc.nasa.gov/4720): the color map of
December 2025, from the LROC wide angle camera's Hapke-normalized mosaic, as a 4096 x 2048 WebP, and a 2048 x 1024
normal map from the LOLA elevation map. Both equirectangular, centered on 0° longitude, east to the right, north up;
the pass reads them that way. The color map is balanced to look right, not to measure: `createMoonMaps` takes the
near side's mean reflectance the script prints and scales the map to normal albedo, so the drawn disc averages the
geometric albedo. The package ships no maps; load them with `loadMoonMaps` from wherever you host them, or hand
`createMoonMaps` any images laid out the same way.

## Use

```ts
import { createMoonPass, earthshineIlluminance, loadMoonMaps, moonOrientation } from "@himmelszelt/nachtgestirn";

const maps = await loadMoonMaps(device, { color: "moon-color-4k.webp", normals: "moon-normals-2k.webp" }, {
    meanReflectance: 0.396,
});
const pass = await createMoonPass(device, { format: "rgba8unorm", maps });

// Per frame, from your astronomy (here sternzeit's, time and observer as its functions take them):
pass.update({
    direction: moon.direction(time, observer),
    angularDiameter: moon.topocentricAngularDiameter(time, observer),
    sunDirection: moon.sunDirection(time, observer),
    orientation: moonOrientation({
        direction: moon.direction(time, observer),
        libration: moon.librations(jde),
        positionAngleOfAxis: moon.positionAngleOfAxis(jde),
        parallacticAngle: moon.parallacticAngle(time, observer),
    }),
    earthshine: earthshineIlluminance(180 - moon.phaseAngle(jde), moon.distance(jde)),
    inverseViewProjection, // as dunstkreis' sky pass takes it
    ev100: 15, // the Moon is a sunlit rock
});
pass.encode(encoder, target, { background: skyInCdPerM2 });
```

Directions are ENU, x east, y north, z up, as in every himmelszelt package; a y-up engine converts with `(x, z, -y)`.
With `background: false` the pass writes the Moon alone, premultiplied, its coverage of each pixel in alpha, for a
renderer that composites itself; with `toneMap: false` it writes the exposed luminance, linear.

## Tests

`pnpm test` runs the pure math; `pnpm test:gpu` also compiles the shaders under Dawn and renders a full and a new Moon
into a small target, checking the full Moon's brightness and flatness and the earthshine's level.
