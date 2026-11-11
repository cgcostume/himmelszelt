# @himmelszelt/nachtgestirn

The Moon for a WebGPU sky, as it looks tonight: one compute pass draws its disc along every pixel's ray, over your sky,
into a texture you own. Its phase comes from the Sun's direction, its face is turned by the libration and the position
angle of its axis, its night side glows in earthshine, and in Earth's shadow it darkens and reddens as it does in a
lunar eclipse. The surface is shaded by Hapke's model of a powdered surface in its 2012 form, with Sato et al.'s
2014 parameters for the Moon, over NASA's maps of the Moon's color and relief. It creates no device, canvas or context, and depends on no
other package at runtime: the astronomy comes in as directions and angles, from
[`@himmelszelt/sternzeit`](../sternzeit) on the himmelszelt site, the sky in cd/m² from
[`@himmelszelt/dunstkreis`](../dunstkreis).

*Nachtgestirn* is the German word for a luminary of the night, above all the Moon.

## What it draws

- **The disc**, antialiased at its limb, as a sphere at the Moon's apparent angular diameter, so its size follows the
  month and the hour, and hidden below the horizon you name.
- **The light**: the Sun's illuminance at the Moon in lux times the surface's reflectance. Hapke's 2012 model with Sato
  et al.'s 2014 parameters (a two-lobed phase function, a shadow hiding surge, multiple scattering and the shadows of a
  rough surface) follows the measured Moon (ROLO, Kieffer & Stone 2005) within a fifth of a stop from full to 97°, and
  keeps the full Moon as bright at its edge as in its middle. The law is a WGSL snippet of its own, one function,
  `ngReflectance`, and `reflectance` on the pass takes another in its place: `wgsl.hapke1963`, Hapke's law of 1963
  after Jensen et al. 2001, as osgHimmel had it, or one of your own. A point seen straight on at opposition reflects its normal albedo like a Lambert surface, so a full Moon of geometric
  albedo 0.12 in 128,000 lux is some 4,900 cd/m² before the air, as measured.
- **Earthshine**, Earth's illuminance at the Moon in lux: `earthshineIlluminance` gives it from Earth's phase as the
  Moon sees it, some 13 lux for a full Earth, a ten thousandth of the Sun.
- **Earth's shadow**: per point of the surface, the share of the Sun's disc Earth leaves uncovered, which is the
  penumbra, plus the sunlight Earth's atmosphere bends into the umbra, deep red in the middle and brighter towards
  the rim, from a table over the shadow's radius: `refractedSunlight` integrates it after Link's theory, ring of air
  by ring, from any two functions of a ray's grazing height, how far the air turns it and what it lets through, such
  as dunstkreis' `refractionAngle` and `airTransmittance`; without one, `typicalUmbra` is a hand-set copper with a
  turquoise rim. The radii come from `eclipse.lunar` of sternzeit, the geometry is yours to hand over.
- **The air**: a transmittance per channel along the line of sight dims and reddens the disc, and the sky you compose
  it over adds its light in front. The air's bending, a `refractionTable` from any refraction function such as
  dunstkreis' `refractionAngle`, turns every ray down before it meets the Moon, as dunstkreis does for the sun disc:
  the disc shows lifted and squeezed near the horizon, to some four fifths of its height from the ground and to a
  quarter from orbit, and sinks smoothly behind the horizon. `liftedDirection` says where its center shows. Given a
  transmittance function too, such as dunstkreis' `airTransmittance`, the table holds the air's transmittance over
  the disc, and each ray is dimmed by its own: at moonrise the lower limb is far darker and redder than the upper.
- **The relief**: the surface's slope from LOLA's heights for its shading, and its shadows, marched through the
  heights towards the Sun: the share of the Sun's half degree above the terrain's horizon, so the penumbra widens with
  the distance from what casts it, contact hardening by the Sun's own size. `shadows` turns them off. The march runs
  once into a shadow map of the band around the terminator, as fine as the disc on screen needs, the whole ring or
  the part the view shows, kept while the Sun and the view stay put; a disc under `shadowsFrom` pixels, 128 by
  default, the Moon as a sky shows it, takes no shadows and needs no map. Below `softShadowsFrom` pixels, 4096 by
  default, the Sun casts as a point: a penumbra is a hundredth of the shadow's length, under a pixel on a smaller disc.
  Where the view magnifies the relief, the map is up to four times finer than its texels, so no edge shows their stairs.
- **Displaced**: from a disc of `displacementFrom` pixels on, 1024 by default, the rays near the limb are marched
  through the heights and the terrain shaded where they meet it, so the limb shows its mountains and near rims hide
  what lies behind them, where a shaded smooth sphere would show slopes turned away as black dashes.
- **Shimmer**: `shimmer` moves the image about as the air's turbulence does in a short exposure and spreads its colors
  by the air's dispersion, from Fried's `r0`, the lens' `aperture` and the `wind`, through as much air as lies towards
  the Moon: the motion as a differential image motion monitor measures it, growing with the square root of the air,
  the cells shrinking with it, blue lifted over red by a hundredth of the refraction. `shimmerScales` gives the numbers.
- **Night vision**: `nightVision` on the pass turns the composed Moon and sky into what the eye sees, helldunkel's
  blue shift for the rods: the moonlit sky blue, the disc, far brighter, as it is.
- **The color**: the map scaled to normal albedo and tinted to the Moon's own color, B-V 0.92, its variations kept;
  `mapColor` reads it as published or as gray instead.
- **Cheap**: one ray per pixel by default (`samples`), four along the terminator and a displaced limb
  (`terminatorSamples`), where a crater rim turns from lit to dark within a pixel; the maps are filtered over the
  whole pixel's footprint whatever the count, so the rays sharpen the shading and never alias the maps, and read by a cubic
  B-spline when magnified, so the terminator and the relief along it stay smooth. Minified, they are filtered
  anisotropically, `textureSampleGrad` over each ray's footprint with up to 16 taps along its long axis: towards the
  poles an equirectangular map crowds its texels east to west, and at the limb the slant stretches the footprint, so
  one isotropic mip level would blur the poles, which always lie near the limb.
- **The exposure**: `moonEV100` meters the lit part a stop over mid gray, the photographer's "looney 11", EV100 13.6 at
  full Moon; `moonIlluminance` gives the Moon's light above the air, some 0.3 lux at full Moon, for lighting a sky by
  it, as dunstkreis' `moonlight` does.

## The maps

`pnpm maps <outDir>` makes them from NASA's [CGI Moon Kit](https://svs.gsfc.nasa.gov/4720): the color map of December
2025, from the LROC wide angle camera's Hapke-normalized mosaic, as WebP, and a height map from the LOLA elevation map
at 64 texels per degree, LOLA's 16-bit half meters in a lossless WebP's red and green, each 4096, 2048, 1024 and 512
texels around. The package ships them in `maps/`, as `MOON_MAPS["4k"]` (11.5 MB), `"2k"` (3.1 MB), `"1k"` (840 KB) and
`"512"` (230 KB), resolved by `new URL(..., import.meta.url)`, which bundlers copy along: a disc shows a map
`mapWidthFor(pixels)`, π times its width, at one texel per pixel, so `"512"` does up to a disc of some 160 pixels,
`"1k"` to some 330, `"2k"` to some 650. All equirectangular, centered on 0° longitude, east to the right, north up; the
pass reads them that way, the heights turned on the GPU into heights and slopes with mip levels. The color map is
balanced to look right, not to measure, and nearly neutral: `createMoonMaps` takes the near side's mean color the script
prints, scales the map to normal albedo, so the drawn disc averages the geometric albedo, and tints it to `MOON_COLOR`,
the Moon's B-V of 0.92, a warm gray; `MOON_MAPS` carries the mean along. `loadMoonMaps` loads `MOON_MAPS["4k"]` by
default, or any set laid out the same way.

## Use

```ts
import {
    createMoonPass,
    earthshineIlluminance,
    loadMoonMaps,
    MOON_MAPS,
    moonEV100,
    moonOrientation,
} from "@himmelszelt/nachtgestirn";

const maps = await loadMoonMaps(device, MOON_MAPS["1k"]);
// The Moon alone, linear and premultiplied, into an rgba16float target, for your compositor.
const pass = await createMoonPass(device, { maps });

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
    ev100: moonEV100(moon.phaseAngle(jde), moon.illuminatedFraction(jde)), // a sunlit rock, some 14 at full Moon
});
pass.encode(encoder, target);
```

Directions are ENU, x east, y north, z up, as in every himmelszelt package; a y-up engine converts with `(x, z, -y)`.
By default the pass writes the Moon alone, its exposed light linear and premultiplied, its coverage of each pixel in
alpha. Add the Moon to the sky, don't lay it over: the sky's light is the air's, in front of the Moon, so it stays.
Only what lies behind the Moon, the stars, is covered, times one minus alpha. With `background: true` the pass does it
itself, over a sky in cd/m² (`pass.encode(encoder, target, { background })`), and with `toneMap: "neutral"` and an
rgba8unorm target it shows on a canvas by itself. What a frame leaves out, the pass leaves out of its shader: a
pipeline is made for each set of features a frame draws, in the background, the one for every frame drawing until it
is ready.

## Tests

`pnpm test` runs the pure math; `pnpm test:gpu` also compiles the shaders under Dawn and renders a full and a new Moon
into a small target, checking the full Moon's brightness and flatness and the earthshine's level.
