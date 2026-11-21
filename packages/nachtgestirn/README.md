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
  default, the Moon as a sky shows it, takes no shadows and needs no map. The shadows are soft by the Sun's half degree
  at no measurable cost, since the march takes the same steps; `softShadowsFrom`, 0 by default, casts with a point Sun
  below that many pixels.
  Where the view magnifies the relief, the map is up to four times finer than its texels, so no edge shows their stairs.
- **Displaced**: from a disc of `displacementFrom` pixels on, 1024 by default, the rays near the limb are marched
  through the heights and the terrain shaded where they meet it, so the limb shows its mountains and near rims hide
  what lies behind them, where a shaded smooth sphere would show slopes turned away as black dashes.
- **Shimmer**: `shimmer` moves the image about as the air's turbulence does in a short exposure and spreads its colors
  by the air's dispersion, from Fried's `r0`, the lens' `aperture` and the `wind`, through as much air as lies towards
  the Moon: the motion as a differential image motion monitor measures it, growing with the square root of the air,
  the cells shrinking with it, blue lifted over red by a hundredth of the refraction. `shimmerScales` gives the numbers.
- **Night vision**: `darkAdapted` on the pass turns the composed Moon and sky into what the eye sees, helldunkel's
  blue shift for the rods: the moonlit sky blue, the disc, far brighter, as it is.
- **The color**: the map scaled to normal albedo and tinted to the Moon's own color, `MOON_COLOR`, a quarter of a
  magnitude redder in B-V than the sunlight it reflects, its variations kept; `mapColor` reads it as published or as
  gray instead. The Sun lights it in its own color, `sunColor`, `SUN_COLOR` by default, a little warmer than D65 as
  dunstkreis' sky has it, so above the air the Moon is a tan gray of about 4,750 K, and the air reddens it further.
- **The white**: a photograph and an eye in the dark show the Moon nearly white all the same, since they take their
  white from what they see. `whiteBalance` takes helldunkel's matrix for that, on the disc and the background together,
  before the exposure: `whiteBalance(MOON_WHITE)` shows the Moon neutral where it stands high and leaves the air's
  red where it rises, `whiteBalance(SUN_WHITE)` is a camera set to daylight, and none, the default, the light's colors
  against D65.
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

The maps come from NASA's [CGI Moon Kit](https://svs.gsfc.nasa.gov/4720): the color map of December 2025, from the LROC
wide angle camera's Hapke-normalized mosaic, as WebP, and a height map from the LOLA elevation map at 64 texels per
degree, LOLA's 16-bit half meters in a lossless WebP's red and green. An optional roughness map comes from Rosenburg et
al. 2011's LOLA slope and Hurst exponent maps. All equirectangular, centered on 0° longitude, east to the right, north
up; the pass reads them that way, the heights turned on the GPU into heights and slopes with mip levels. A disc shows a
map `mapWidthFor(pixels)`, π times its width, at one texel per pixel, so `"512"` does up to a disc of some 160 pixels,
`"1k"` to some 330, `"2k"` to some 650, `"4k"` beyond.

Each comes in two variants. The seen maps, the default, hold only what Earth ever sees: past the edge of what any
libration shows, the color fades into the mean of the part beyond and the heights and roughness to none, which makes their files a third smaller and changes nothing
on the GPU. Take them for views from Earth or a low orbit around it. The whole maps keep the far side: take them for a
globe, a camera that orbits the Moon, or anything else that shows the part Earth never sees. The suffix `seen` before the
size tells them apart, `moon-color-seen-1k.webp` against `moon-color-1k.webp`.

| | Seen (default) | Whole |
|---|---|---|
| Color and heights | `MOON_MAPS`: `"512"` 142 KiB, `"1k"` 537 KiB shipped; `"2k"` 2.0 MiB, `"4k"` 7.4 MiB made on request | `MOON_MAPS_WHOLE`: `"512"` 207 KiB, `"1k"` 799 KiB, `"2k"` 2.9 MiB, `"4k"` 11.0 MiB, made on request |
| Roughness | `MOON_ROUGHNESS`: `"512"` 128 KiB, `"1k"` 500 KiB shipped; `"2k"`, `"4k"` made on request | `MOON_ROUGHNESS_WHOLE`: `"512"` to `"4k"` (7.7 MiB), made on request |

The package ships the seen 512 and 1K in `maps/`, resolved by `new URL(..., import.meta.url)`, which bundlers copy along.
The others are made where the package is installed, next to its own files, and absent until then:

```sh
npx @himmelszelt/nachtgestirn data maps --size 2k,4k          # the seen color and heights
npx @himmelszelt/nachtgestirn data maps --size 4k --whole     # the whole ones
npx @himmelszelt/nachtgestirn data roughness --size 1k --whole
npx @himmelszelt/nachtgestirn data maps --size 8k --whole --out public/moon   # 8K, yours to host
```

`--seen` and `--whole` together make both; `--out` and `--cache` move the output and the downloads (590 MB from NASA, the
8K 240 MB more, the roughness 41 MB from the PDS), and the work is skipped while the output is newer than its inputs.
The maps not shipped, the seen ones from 2K and every 8K, come built from the asset mirror
(github.com/cgcostume/himmelszelt-assets), checked against their SHA-256; `--build` makes them here, which needs `sharp`
(`npm install sharp`), and its downloads come from the mirror first too. In the repository `pnpm data:maps` and `pnpm
data:roughness` build with the same options, and `pnpm assets` makes the whole maps the site draws, `--all` the shipped ones
too.

The color map is balanced to look right, not to measure, and nearly neutral: `createMoonMaps` takes the near side's mean
color the script prints, scales the map to normal albedo, so the drawn disc averages the geometric albedo, and tints it
to `MOON_COLOR`, red 1.21 and blue 0.79 of green, a warm gray. The mean is the near side's, the same for both variants, and every
set carries it along. `loadMoonMaps` loads `MOON_MAPS["1k"]` by default, or any set laid out the same way.

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
        libration: moon.topocentricLibrations(time, observer),
        positionAngleOfAxis: moon.topocentricPositionAngleOfAxis(time, observer),
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
