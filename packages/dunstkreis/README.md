# @himmelszelt/dunstkreis

WebGPU atmospheric scattering for sky rendering, a TypeScript port of the
atmosphere rendering of [osgHimmel](https://github.com/cgcostume/osghimmel),
reimplemented as WebGPU compute shaders writing to storage textures rather
than the original's OpenGL FBO-ping-pong-through-fragment-shaders approach.

Not a renderer: it is a render component. It never creates a device, a canvas or a context. You hand it a
`GPUDevice`, and it records compute passes into your command encoder, the sky written straight into your target as the
background, no rasterization involved. Or take the WGSL and inline it yourself.

Takes a sun/moon direction vector and time as plain inputs, no hard
dependency on [`@himmelszelt/sternzeit`](https://github.com/cgcostume/himmelszelt/tree/main/packages/sternzeit)
or any other `@himmelszelt/*` package, so it drops into any existing WebGPU
renderer. The tone curves and EV100 math of `@himmelszelt/helldunkel` and the cube map layout of
`@himmelszelt/rundbild` are bundled into `dist` at build time and exported from here as well: one source, nothing else
to install.

New to terms like inscatter, optical depth, or scale height? The [himmelszelt site](https://github.com/cgcostume/himmelszelt) explains every one of them, right where it is used.

## Hillaire at the core

The sky follows Hillaire 2020 on the model osgHimmel took from Bruneton & Neyret 2008:

| table | size | computed |
|---|---|---|
| transmittance | 256x64 | once per model, `precomputeAtmosphere()` |
| multiple scattering | 128x64 | once per model, `precomputeAtmosphere()` |
| sky view | 128x256 | whenever the Sun or the observer moves, by the pass from `createSkyPass()` |

Hillaire's multiple-scattering term is infinite-order under an isotropic assumption, where Bruneton's is a fixed number
of orders; for Earth's air the two look nearly alike. Bruneton's four-dimensional inscatter table (32x128x32x8,
osgHimmel's) holds every sun position at once and gives aerial perspective between any two points. It may come later,
as another way to fill the sky-view table, rather than as a second renderer.

## Observer altitude and refraction

The observer can be anywhere from 1 m above the ground, eye level give or take, up to the International Space Station's
408 km (`clampObserverHeight`). Inside the atmosphere the sky pass looks the sky up in the sky-view table; above it,
where that table does not reach, it raymarches every pixel from where its ray enters the atmosphere, and the planet
shows, lit by the Sun.

Atmospheric refraction is part of the model: the air's refractive index follows its density, `refractivity` times
the Rayleigh layer's, and every ray bends towards the denser air below it, the view rays as well as the sunlight
reaching each point. No fit is involved, so one model covers the observer on the ground, high up looking down and in
space looking through the limb. Bouguer's invariant (n r sin z stays constant along a ray) decides where the ground
starts, which also lifts the visible horizon by terrestrial refraction; the bending itself is traced, in the same steps
that integrate the scattering. The sky-view table is indexed by the apparent direction and stores how far each ray
bent, the transmittance table by the true direction light arrives from, so the sky pass looks both up and bends
nothing. Bodies stay visible while geometrically below the horizon, and the Sun flattens there, without either being
special-cased. Near the ground the result lands within a few percent of Bennett's fit (Meeus 16.3), some 10% above it
at the horizon, where the model's single scale height makes the lowest air denser than the real one.

Set `refractivity: 0` to turn it off, which means recomputing the tables and making the passes anew; they then compile
the straight march (`DK_REFRACTION` off), which skips the bending's two exponentials per step and aims each step once. `airRefractivity(temperatureC, pressureHPa)`
gives the value for other air, and `apparentDirection` traces where a body shows on the CPU, `refractionAngle` how far
a ray seen at an apparent altitude bends, and `airTransmittance` what the air lets through along it, per channel, the
CPU twin of the transmittance table, for the Moon's disc or a planet; with `passes` 2, sunlight grazing the ground in and
out again, as into Earth's shadow, its spectrum dimmed twice before it becomes a color. Feed the true sun direction: an already
refracted one would be lifted twice.

## Units, exposure and tone mapping

The sky comes out in cd/m². `solarSpectrum` is the Sun's spectrum, `solarIlluminance` its illuminance above the
atmosphere, 128 000 lx by default: the solar constant of 1361 W/m² (Kopp & Lean 2011) times sunlight's luminous
efficacy of about 94 lm/W. `atmosphereUniformData` packs the spectrum scaled to it (`luminanceScale(model)`), so the
sky-view table holds cd/m² too: half floats keep full precision from 6·10⁻⁵ cd/m², deep into twilight, up to 65 504,
above the brightest sky around the Sun.

Exposure is in EV100, the convention of cameras, Frostbite and Unreal (Lagarde & de Rousiers 2014):
`exposureFromEV100(ev100)` is 1 / (1.2 · 2^EV100). About 15 for a sunny day, 0 in twilight. A scene in cd/m² exposed at
the same EV100 looks the same in any renderer that follows it.

`whiteBalance` in the sky's parameters is a 3x3 matrix over linear sRGB, helldunkel's `whiteBalance(white)`, re-exported
here: it shows that reference white as D65 at its own luminance, and is applied before the exposure wherever the pass
exposes, to the sky, the sun disc and the air the aerial perspective pass adds, not to a cube map in cd/m².
`NO_WHITE_BALANCE`, the identity, is the default and changes no bit of the frame.

`autoExposure: true` on `createSkyPass` exposes by a light meter instead, for a renderer without an exposure of its own or to follow day
into night. Whenever the sky-view table is rebuilt, a compute pass reads it in 4096 directions spread evenly over the sky
above the horizon and as many, apart, below it, and a second sums them and writes the brighter of the two geometric mean
luminances to a buffer the sky pass reads, so there is no round trip to the CPU. On the ground that is mostly the sky; the ground below is darker,
except, as for a camera, over snow. High up it is the lit air below, while the sky above turns black. Above the
atmosphere, beyond the table, the meter raymarches its directions instead and so reads the lit planet. The reading is
EV100 = log2(L · 100 / 12.5) (`ev100FromLuminance`), held within `autoExposureRange`, [4, 20] by default, less
`exposureCompensation`. The lower bound keeps night dark: exposed like day, a night sky looks like one. At 4 it is reached
with the Sun 6° down, at the end of civil twilight, so the earth's shadow and the belt of Venus are still exposed as
metered. Metering the
table rather than the frame keeps the reading still as the camera turns and leaves the Sun's disc out of it. It follows at
once, with no eye adaptation over time. `meteredEV100()` reads it back, e.g. for a UI. The rebuild and the meter are submitted by `update()` itself, or recorded
into a command encoder passed to it, to go with the frame's own submission.

`autoExposureKeys` shapes the ramp over the day: compensations at sun altitudes above the observer's horizon, which
sinks with height (some 10° at 100 km, so a sun 5° below the horizontal still shines on the observer and is keyed so),
joined by a monotone cubic (Fritsch & Carlson) that is smooth and never overshoots a key. A key's compensation is one
value, or a pair `{ rising, setting }` for mornings and evenings apart, told by whether the Sun is east or west of the
meridian and blended across it so noon does not jump. The model's air is the same morning and evening, so the pair is a
matter of taste, e.g. for hazier evenings. The metering stays the base, so the ramp still follows a changed atmosphere.
`DEFAULT_AUTO_EXPOSURE_KEYS`:

| Sun altitude | Morning | Evening | |
|---|---|---|---|
| −18° | −2 | −2 | night, darker |
| −8° | −1.5 | −1.5 | end of the blue hour |
| −5° | −0.8 | −0.8 | blue hour, lifted so its blue shows |
| −2° | −0.9 | −0.9 | before sunrise, after sunset |
| −1° | −0.7 | −0.7 | just before sunrise, just after sunset |
| 0° | 0 | +0.2 | sunrise, sunset |
| 6° | +0.2 | +0.3 | golden hour |
| 60° | 0 | 0 | noon, as metered |

Night is yet to come. A camera exposes a landscape by full moon at about EV100 −3 and the Milky Way at about −6 to
−7, some 7 to 11 stops below the floor of 4. The floor stays until the night sky has light of its own: the Moon's
scattered light, airglow, zodiacal light and the stars. Exposed that far now, the sky would show only the Sun's last
twilight, amplified to where the f16 table runs out of precision. Then the floor drops and the night key follows.

No direction counts more than 10 stops below the brightest of its half, a camera's dynamic range: from space, the black
sky and the planet's night side would otherwise pull the geometric mean towards night while the day side shines.

With `toneMap`, the pass writes display colors for an 8-bit target: exposed, mapped by Khronos PBR Neutral (`"neutral"`, the
default), which keeps colors as they are up to 0.76 and compresses only above, or AgX (`"agx"`), whose bright colors
fade towards white as film does, flatter and grayer by day, or Narkowicz's ACES fit (`"aces"`), the earlier default, sRGB encoded and, with `dither`, dithered by helldunkel's 64x64 blue noise (Ulichney 1993), remapped to a
triangular distribution, from one texture per device or the one `blueNoise` passes in. Off, it writes the exposed luminance, linear and unclamped, for a float target and
a renderer that tone maps the frame itself, with `wgsl.tonemap` if it likes.

## The Sun in the picture

The Sun is drawn per pixel over the sky, never stored in a table, and in parts a renderer can take or leave:

- The disc, `sunDisc`, dimmed and reddened by the air in front of it, supersampled where its rim or the horizon crosses
  a pixel. `sunDiscCeiling` stops its luminance at a value in cd/m², for a linear output a later pass tone maps:
  without it every pixel of the rim lies far above white there and the rim comes out hard. Off by default.
  `moonAngularDiameter` hides it behind the Moon's disc at `moonDirection`, a solar eclipse; 0 by default, no Moon.
  `limbDarkening`, on by default, darkens and reddens it towards its limb by Hestroffer and Magnan's power law (1998),
  mu^alpha with alpha = -0.023 + 0.292 / wavelength in micrometers, at 610, 550 and 465 nm, over its mean across the
  disc: the limb shows a third of the center's light, and the disc's light stays what it was. It shows once the exposure
  is short enough for the disc not to burn out, some EV100 32.
- The corona and the chromosphere, `solarCorona`, the Sun's own light beyond its limb, on by default with the disc:
  Baumbach's fit to the corona (1937), 0.0532 / r^2.5 + 1.425 / r^7 + 2.565 / r^17 millionths of the disc's center, r
  in solar radii, out to 40 of them, and under it the chromosphere, a pink shell of 2,500 km. Five millionths of the
  disc at the limb, some 9,000 cd/m²: lost in the sky by day and, above the air, in a lens's veil, some forty times
  brighter there, as in any camera. It shows from above the air with `veil: 0`, close in or at a long exposure. Behind
  the air, the ground and the Moon as the disc is, but a total eclipse does not show it yet: the sky, the aureole and
  the veil do not dim with the covered Sun. In the image only, not in a cube map.
- The aureole, `aureole`, the air's glow of about a degree around it: aerosols scatter sunlight far more sharply forward
  than the tables' one Cornette-Shanks lobe says, so a share of their scattering, `DEFAULT_AUREOLE`'s 5 % at g 0.98,
  goes into a narrow Henyey-Greenstein lobe the tables leave out and the sky pass adds per pixel where the lobe is above
  a five-thousandth of its peak, within 20° of the Sun at g 0.98, less for a sharper lobe, never more:
  the aerosols' sunlit scattering marched along the same bent path as the sky, dimmed by the air in front, times the
  lobe, centered on where the Sun shows. The cube map gets it too. `false` for Bruneton's one lobe alone.
- The veil, `veil`, the glow an eye or a lens lays around the Sun: CIE's equation (CIE 146:2002) from the Sun's
  illuminance at the observer, which the light meter writes. Its strength is `LENS_VEIL` by default, a two-hundredth,
  for a camera's lens: it burns out about a degree around the disc at a day's exposure, a good quarter more with every
  stop the exposure opens, and keeps the disc from standing as a bare white circle on black above the haze. 1 is the
  eye's own, which washes out some 10° around the Sun by day, 0 none. A lens or an eye veils only of what it looks at:
  the veil fades as the Sun leaves the frame and is gone 40 % of the image's half extent beyond its edge. With
  `moonlight` around the Moon as well, from its illuminance at the observer: a faint glow around a full Moon high at
  night, next to none around a crescent or a low Moon, lost in the sky by day. From `@himmelszelt/helldunkel`'s
  `glare.wgsl`, bundled.
- The starburst, `starburst`, a camera's: the spikes the blades of its aperture diffract the Sun into, fixed to the
  camera, `true` for six blades or `{ blades }` from 3 to 16, an even count drawing as many spikes and an odd one twice
  as many. Off by default. It leaves the frame with the Sun as the veil does. From helldunkel's `lens.wgsl`, bundled.

Bloom is the lens's and needs the image, helldunkel's `createBloomPass` over the exposed frame; god rays need something
that casts a shadow, which the sky alone has not. They add up without counting each other twice: the aureole is
light in the air, the corona the Sun's own, the veil, the starburst and bloom what the eye or the lens spreads of all
that reaches it. The veil and the starburst know of nothing in front of the Sun but the planet: a renderer with clouds
or terrain turns them off and adds `hdVeil` and `hdStarburst` with the light that gets through. `wgsl.sun` holds
the disc, `dkSunLimbDarkening`, `dkSunCorona` and `dkSunChromosphere` binding-free, `wgsl.raymarch` the aureole's
march, `dkRaymarchAerosol`, and `wgsl.common` its lobe, for a renderer's own sky.

## Moonlight

`createSkyPass(device, { ..., moonlight: true })` lights the sky by the Moon too: `update({ moonDirection,
moonIlluminance })` takes the Moon's true direction and its illuminance above the air in lux, some 0.3 at full Moon, as
`@himmelszelt/nachtgestirn`'s `moonIlluminance` gives it. A second sky-view table, the same march from the Moon's
direction at its share of the Sun's light, is rebuilt when the Moon moves and read beside the Sun's, and the aureole
glows around the Moon as well, centered on where it shows, and so does the eye's `veil`. The sky by full moon comes
out blue at around EV100 −3, as a camera sees it. The disc itself is not drawn: that is nachtgestirn's. The light
meter writes the Moon's light at the observer, `moonIlluminance()`, for lighting a scene by it; the meter's reading
and the ground's light from the sky stay the Sun's, and the aerial perspective volume takes the Moon's light too. A
camera sees the moonlit sky as the day's, only dimmer; the eye does not, its rods take over and see it blue.
`darkAdapted: true` draws it so, by helldunkel's `hdDarkAdaptedEye`, bundled.

## The ground

Below the horizon the sky-view table shows the ground, in its albedo `groundAlbedo` (linear RGB, 0.3 by default, the
Earth's average, where Bruneton and Hillaire used 0.1), lit by the Sun and by the sky: after the table's upper half is
built, the sky's irradiance on the ground is integrated over it texel by texel, each texel's luminance times the
cosine-weighted solid angle it covers, and the lower half is built with it. `groundLight: false` on `createSkyPass`
leaves the Sun alone, a dispatch cheaper per rebuild. The sky is read from the observer's altitude, which is close
enough near the ground and too dark high up.

## Lighting a scene

The Sun and the sky light a scene apart, the usual split for image-based lighting:

- The Sun as a directional light, from its apparent direction (`apparentDirection`), with `sunIlluminance()`: the
  sunlight that reaches the observer through the air, per channel in lux, measured by the light meter on the GPU.
  `lightThroughAir(model, sunDirection, observerHeightM)` gives the same on the CPU, for the same frame without a
  round trip, and `lightBuffer` the meter's buffer for a pass of your own that reads it on the GPU.
- The sky's irradiance on the ground with `skyIrradiance()`, without the Sun, from the table with `groundLight`.
- The Moon the same way with `moonlight`, from its apparent direction, with `moonIlluminance()`: its light through
  the air, in sunlight's color, some 0.3 lux at full Moon high up. The cube map holds the moonlit sky too.
- The sky as a cube map, from a cube pass made once, `await sky.createCubePass({ format: "rgba16float" })`, then
  `encode(encoder, cube)` per update: the six faces of a square texture with six layers, in cd/m², linear, indexed by
  ENU directions, so a y-up engine samples it with (x, -z, y). Without the Sun's disc by default: some 10^9 cd/m² in a
  few texels would outshine the whole sky in every filtered lookup. With `sunDisc: true`, for a background, it needs
  rgba32float, being far beyond what rgba16float holds. `samples` per texel, spread by the R2 sequence, smooth the
  edges a texel straddles, the horizon's and the Sun's disc's. Mip levels need `TEXTURE_BINDING` usage too. In deep
  twilight cd/m² fall below what rgba16float holds finely; with `scaled: true` the cube map holds them times
  `sky.skyViewScale`, a power of two that follows the Sun, as the sky-view table does: divide by it, as read when
  encoding, for cd/m², and the irradiance from it too.

What to do with that cube map is [`@himmelszelt/rundbild`](https://github.com/cgcostume/himmelszelt/tree/main/packages/rundbild)'s:
it takes any cube map as a plain texture, for the sky's diffuse light as nine spherical harmonics coefficients and an
irradiance cube map (`createIrradiancePass`), and to lay it out as a panorama (`createPanoramaPass`). The two packages
do not depend on each other at runtime.

## Aerial perspective

Distant mountains fade into the sky and take its color: the air between the camera and a point adds its own light and
lets only part of the point's through. `createSkyPass(device, { ..., aerialPerspective: true })` builds Hillaire's
aerial perspective volume for that, whenever `update()` sees the camera, the Sun, the Moon or the observer move:
froxels over the camera's frustum, 32x32 across the screen in 32 slices out to 32 km, or
`{ width, height, depth, maxDistanceKm }`. Slice k lies `maxDistanceKm * ((k + 0.5) / depth)²` away, thin near the
camera. One invocation per column of froxels marches its ray once through all slices, some 130 steps, rather than each
froxel its own, in about a tenth of a millisecond on a desktop GPU.

The volume is made for a shader that knows nothing else of dunstkreis. `sky.aerialPerspective` holds two 3D
rgba16float textures in linear sRGB, and they describe themselves: `luminance` is the light the air adds, rgb times
2^alpha in cd/m², a shared exponent that follows the Sun and the Moon, so half floats hold noon and a moonlit night
alike; `transmittance` is what the air lets through per channel, with the reach in km in alpha. A renderer binds the
two with a linear, clamping sampler (`luts.sampler` is one) and pastes `wgsl.aerial` in front of its shader, which
needs no other snippet, no uniform and no scale handed along. In a fragment shader as in a compute shader:

```wgsl
// uv on the screen from the top left, the point's distance from the camera in km, its lit color in cd/m².
let air = dkAerialPerspective(airLuminance, airTransmittance, airSampler, uv, distanceKm);
let seen = color * air.transmittance + air.luminance;
```

A renderer that would rather not touch its shaders lays the air over its finished frame, by the depth buffer:

```ts
const air = await sky.createAerialPerspectivePass({ format: "rgba16float" });
// Each frame, after the scene is drawn over the sky: color and depth in, the frame seen through the air out.
air.encode(encoder, target, { color, depth });
```

It finds each pixel's distance by the `inverseViewProjection` the sky pass has, any perspective, and exposes the air's
light as the sky pass exposes the sky. `clearDepth` is the depth where nothing was drawn, 1 by default and 0 for a
reversed depth buffer: those pixels keep the sky as it is. `metersPerUnit` is 1 by default, a scene in meters. Color
and depth are not multisampled. Some 0.04 ms for a full HD frame.

What to know when shading by it:

- The camera. The froxels follow the `inverseViewProjection` given to `update()`, the matrix alone, not the fisheye of
  `projectionDistance`, and `uv` is that view's. The lookup takes no direction, so a y-up scene in meters is as good
  as any: only that matrix has to end in ENU. A second view, a reflection or a shadow map, needs a sky pass of its
  own, or `dkRaymarchAerialPerspective` from `wgsl.raymarch`, which marches one segment from any altitude and takes
  the tables and the `DkAtmosphere` uniform.
- Units. Distances are km. The light is cd/m²: a renderer that shades in other units multiplies `air.luminance` by its
  exposure, as the pass does with the sky pass' own.
- The reach. Beyond `maxDistanceKm` a point takes the last slice's air, too little: make the volume reach as far as
  the geometry does, the far plane or the horizon, √(2 · 6360 km · height) from the camera plus the same for the
  highest thing in sight. It costs no more: the steps per slice stay, and since the slices spread by the square of
  their number, the first is 8 m in at 32 km and 100 m at 400 km. Short of the first slice the air fades to nothing.
- The sky behind. Pixels without geometry keep the sky pass' own, which holds all of the air along its ray; a point
  where the ray's air ends, far beyond the horizon, comes out as that sky, without the Sun's disc and its aureole,
  which the froxels are too coarse for.
- Shadows. The volume takes the air along a ray as lit, but for the planet's own shadow. The air's light between two
  distances is the difference of two lookups, so a stretch known to lie in shadow, under a cloud deck or in a valley,
  gives a share of it back. `@himmelszelt/gewoelk` shades the air under its clouds that way, and takes the volume as
  it is for the air in front of them.
- The Moon. With `moonlight` the volume holds the Moon's light in the air as well, the same march from its direction
  at its share of the Sun's light, so a night scene fades into the moonlit sky.

## Light from beyond the air

A star, the Moon, a planet, a satellite, the Sun's disc: whatever lies outside the atmosphere reaches the eye through
it, and the air does the same to all of them. It bends the light, dims and reddens it, bends blue more than red, and
stirs it with its turbulence. dunstkreis draws none of these bodies; it has the air for them, as one kit: a table,
lookups for it in TypeScript and in WGSL, a seeing model, and a pass.

**The air table.** The atmosphere is the same all round, so for one observer height everything depends on a ray's
apparent altitude alone. `airTable(model, observerHeightM)` traces 256 rays through the model's air, from the horizon
the air shows up to the zenith, or from above the atmosphere up to the ray that touches its top, crowded towards the
horizon by the fourth power, and holds for each what `airAt(table, altitude)` reads back:

| | |
|---|---|
| `bend` | how far the air turned the ray down, in degrees |
| `transmittance` | what it lets through of sunlight, per channel of linear sRGB |
| `airmass` | the air crossed, in columns of it straight up from sea level |
| `dilution` | how much the air squeezes the sky there, 1 / (1 - d bend / d altitude): a point's light is multiplied by it |
| `seeing` | the turbulence along the ray for an image's motion: its amount, distance and wind |
| `scintillation` | the same for a point's flicker, each part weighed by its distance to the power 5/6 |

A fifth row holds the inverse of the bend, the lift over the true altitude: `liftedDirection(table, direction)` is
where a body shows, `unbentDirection(table, view)` where a ray came from, and the two agree to a hundredth of an
arcsecond. No iteration: from orbit the bend falls nine degrees per degree at the limb, and iterating on it diverges.
Below the true horizon a body sinks on behind the ground at the horizon's rate, and `airShows` or a `null` from
`airAt` says the ground hides it. Between its entries the table reads the traced bend to half an arcsecond and the
transmittance to 0.4% at any height from the ground to 408 km, which a test pins.

The table is traced on the CPU on purpose: 9 ms in JavaScript, only when the observer's height or the model changes,
in double precision, and the CPU needs it anyway, to aim a camera at the Moon or to meter, without a round trip.
`createAirTexture(device, table)` makes the texture the shaders read, 256 by 5 texels of rgba32float (20 KiB), and
`writeAirTexture` refills it. Its layout is documented at the top of `src/air.ts` and `src/wgsl/air.wgsl`, and
`airTableFrom` fills it from any function of the altitude, for an air that is not dunstkreis' own.

**The lookups in WGSL.** `wgsl.air` reads the table with `textureLoad`, so it needs no sampler and no device feature,
and takes the texture as an argument: bind it wherever you like, as an unfilterable float texture.

```wgsl
${wgsl.air}
${wgsl.seeing}
@group(0) @binding(4) var airTable: texture_2d<f32>;
@group(0) @binding(5) var<uniform> seeing: DkSeeing;      // seeingUniformData(), 32 bytes

// A star: lifted, dimmed, diluted, twinkling. Nothing if the ground hides it.
let shown = dkAirLifted(airTable, trueDirection);
let air = dkAirTowards(airTable, shown);
let light = select(vec3f(0.0), illuminance * air.transmittance * air.dilution
    * dkScintillation(seeing, air, starIndex, time), air.shows);

// A pixel's ray into a star map or onto the Moon: where it came from.
let beyond = dkAirUnbent(airTable, viewRay);
```

`dkAirLight` and `dkAirLift` take altitudes in radians instead of directions, `dkAirAt` gives the whole `DkAir` for
one, and `DK_AIR_DISPERSION` holds how much more or less than green the air bends red and blue, by Edlén's formula.
The functions need nothing of the atmosphere model, so a package that draws such a body can bundle `air`, `seeing`
and `shimmer` alone, at build time, and take the texture as a plain input.

**Seeing.** One model of the turbulence for an image's motion and for a point's flicker: the Hufnagel-Valley 5/7
profile of Cn² over the height, carried by Bufton's wind, summed along each of the table's bent rays and scaled by
Fried's parameter. `Seeing` is `{ r0, wind, speed, aperture, exposure }`: `r0` in meters at 550 nm straight up from
sea level, 0.1 by default; the wind up high in m/s, 21; the observer's own speed across the line of sight, 0, 7700
in orbit; the lens' width, 0.007, the eye's pupil; the exposure in seconds, 0.1, the eye's. `shimmerScales(seeing,
air.seeing)` gives an image's rms tilt, the finest patch that moves as one and its drift across the sky;
`scintillation(seeing, air.scintillation)` a star's variance and how long its flicker stays alike, with the aperture
and the exposure averaged over; `scintillationIndex` the standard deviation of the logarithm of its light. On the GPU
`dkScintillation(seeing, air, seed, time)` in `wgsl.seeing` is the star's factor for the moment, lognormal, per
channel: the air's dispersion parts the colors' paths, and low stars flicker in colors. Because the turbulence is
summed along the traced ray, it holds looking down from a plane, where an airmass of 1 / sin has no answer, and from
orbit, where the turbulence lies 2,300 km away on the limb.

**The shimmer pass.** `createShimmerPass(device, { format })` makes a compute pass over any linear layer with
coverage in alpha: the Moon, a planet's disc, a satellite, the Sun. It writes the layer as a camera takes it in one
short exposure, moved about by eight octaves of Kolmogorov's waves, blurred by those the pixels cannot follow, its
colors spread by the dispersion, and nothing of it below the horizon. The turbulence's amount and the bend are read
from the table per pixel, so a disc half inside the limb from orbit trembles only there.

```js
const table = airTable(model, observerHeightM);          // when the height changes
const airTexture = createAirTexture(device, table);
const shimmer = await createShimmerPass(device);          // once

const shown = liftedDirection(table, moonDirection);
shimmer.update({ direction: shown, seeing: { r0: 0.1, aperture: 0.1 }, time, inverseViewProjection });
shimmer.encode(encoder, moonLayer, airTexture, shimmered);
```

`shimmerShows(seeing, air, pixel)` tells whether any of it would move the image by a tenth of a pixel, to leave the
pass out otherwise, and `shimmerReach` how far around the body it has to work, for `reach`. A pass of your own that
would rather shimmer its layer and finish the pixel in one go calls `dkShimmerLayer` from `wgsl.shimmer` instead, with
its own layer, sampler and camera.

## Quality and cost

Every sample count and table size is a parameter (`PrecomputedTextureConfig` and the cube pass' `samples`), and the
defaults hold the luminance within a fraction of a percent of references with far more of either, for well under a
millisecond per sky-view rebuild on a desktop GPU. What each costs and gains, how the defaults were chosen, and the
experiments behind the four wavelengths, the table shapes and the rest are in [research/](research/README.md).

## Device requirements

Everything stays within WebGPU's default limits; only bgra8unorm output needs a feature, "bgra8unorm-storage", for
`getPreferredCanvasFormat()` on Windows and macOS (or configure the canvas as rgba8unorm). `skyRequirements(options)`
gives the features and limits to request a device with, `unmetRequirements(adapterOrDevice, options)` what one lacks,
in words:

```js
const options = { format: "rgba8unorm", outputSize: 4096, cube: { format: "rgba16float" } };
const unmet = unmetRequirements(adapter, options);
if (unmet.length) throw new Error(unmet.join("; "));
// With the adapter, also "subgroups" and "float32-filterable" where it has them.
const device = await adapter.requestDevice(skyRequirements(options, adapter));
```

The limits fit WebGPU's compatibility mode too. The passes that sum over a workgroup, the multiple-scattering table
(one workgroup of 64 per texel), and the light meter, use subgroup operations where the device
has "subgroups", and a tree in workgroup memory where it has not (`wgsl.workgroupSum`). Pass creation is asynchronous throughout (`createComputePipelineAsync`), so compiling never blocks a frame.

## Status

Implemented so far:

- `src/model.ts`: the physical model and LUT configuration, with `OSGHIMMEL_ATMOSPHERE_MODEL` reproducing
  the original's `t_modelCfg` exactly and the defaults moved to modern values (thinner aerosol layer,
  stronger forward scattering, ozone).
- `src/refraction.ts`: the refraction the shaders trace, on the CPU, for where the Sun shows.
- `src/wgsl/atmosphere.wgsl` and `src/uniforms.ts`: the `DkAtmosphere` uniform block and its packer.
- `src/wgsl/quality.wgsl`, `src/wgsl/features.wgsl` and `src/quality.ts`: the pipeline-overridable sample counts and
  the passes' switches.
- `src/wgsl/frame.wgsl`: the per-frame uniform and the light meter's buffer, which the per-frame passes share.
- `src/requirements.ts`: the device features and limits, `skyRequirements()` and `unmetRequirements()`.
- `src/wgsl/common.wgsl`: ray-sphere geometry, rays bent by the air, density profiles and phase functions.
- `src/pass.ts`: the `SkyPass`/`AtmosphereLUTs` interfaces.
- `src/luts.ts`: the transmittance and multiple-scattering tables, `precomputeAtmosphere()`.
- `src/sky.ts`: the sky-view table, the light meter, the sky pass and its cube pass, `createSkyPass()`.
- `src/exposure.ts`: the automatic exposure's ramp.
- `src/air.ts` and `src/wgsl/air.wgsl`: the air table for light from beyond the atmosphere, `airTable()`, and its
  lookups on both sides.
- `src/seeing.ts`, `src/wgsl/seeing.wgsl`: the turbulence, an image's motion and a point's scintillation.
- `src/shimmer.ts`, `src/wgsl/shimmer.wgsl` and `src/wgsl/shimmerlayer.comp.wgsl`: the shimmer over a linear layer,
  `createShimmerPass()`.
- `src/wgsl/aerial.wgsl`, `src/wgsl/aerialvolume.comp.wgsl` and `src/wgsl/aerialapply.comp.wgsl`: the aerial
  perspective volume's lookup, the pass that fills it and the pass that lays it over a rendered scene.

Bruneton's table as another filler follows.

### Composing the shaders

The shaders are authored as real `.wgsl` files under `src/wgsl/` and exported as strings, so they can be
pasted into a shader of yours instead of going through this package's passes:

```js
import { wgsl, atmosphereUniformData, pipelineConstants, DEFAULT_ATMOSPHERE_MODEL, DEFAULT_TEXTURE_CONFIG }
    from "@himmelszelt/dunstkreis";

const module = device.createShaderModule({ code: `
${wgsl.scattering}                                        // DkAtmosphere + the functions that take it
@group(2) @binding(0) var<uniform> sky: DkAtmosphere;     // your binding, your indices

@fragment fn fs(@location(0) ray: vec3f) -> @location(0) vec4f {
    let mu = dot(normalize(ray), up);
    let horizon = dkHorizonMu(sky, h);   // altitude in km, not the radius
    ...
}` });

device.queue.writeBuffer(buffer, 0, atmosphereUniformData(DEFAULT_ATMOSPHERE_MODEL)); // 192 bytes
```

Three properties make this composable:

**No bindings are declared.** `common.wgsl`'s functions take the `DkAtmosphere` struct by value as their
first argument rather than reading a `var<uniform>`, so nothing here can collide with your group or binding
indices, and you decide where the data lives.

**Parameters are a uniform block, not string substitution.** `atmosphereUniformData()` packs a model into the
192-byte layout `atmosphere.wgsl` declares. A test parses that struct, walks it applying WGSL's uniform layout
rules, and checks the packer writes the right value at every offset, since nothing in the toolchain would
otherwise catch the two drifting apart.

**Quality is specialized with `override`s, not uniforms.** Sample counts live in `quality.wgsl` as
pipeline-overridable constants, set through `constants` on the pipeline descriptor via `pipelineConstants(config)`,
and the passes' switches (tone mapping, dithering, auto exposure, the Sun's disc, the cube map) in `features.wgsl`.
Integration loop bounds stay compile-time constants so the compiler can unroll them, and a disabled feature leaves no
code behind rather than branching per pixel. `common.wgsl` declares one of its own, `DK_REFRACTION`, on by default,
which is right either way. The uniforms keep only what changes per frame: 176 bytes for the sky.

Every identifier is prefixed `dk`/`DK_` so several `@himmelszelt/*` fragments can share one shader module.
Rolldown inlines the `.wgsl` files at build time, so `dist` reads nothing from disk and stays browser-safe.

### A note on testing shaders

The WGSL is tested by executing it, against the TypeScript twins, via Dawn in-process (`tests/gpu.ts`), not
in a browser. Those tests are opt-in (`pnpm test:gpu`), since a CI runner has no GPU, so the pure-TypeScript
tests carry the baseline there; run them when touching WGSL. The crashes and deadlocks they used to suffer were not
the binding's: the GPU instance from `create()` went unreferenced and was collected, taking the device with it.

## References

osgHimmel itself originated as [Daniel Limberger](https://daniellimberger.de)'s (né Müller) master's thesis at
HPI: ["Photorealistisches Rendering atmosphärischer Effekte in geovirtuellen 3D-Umgebungen in
Echtzeit"](https://daniellimberger.de/resources/2012%20%E2%80%93%20Mueller%20%28now%20Limberger%29%20%E2%80%93%20Photorealistisches%20Rendering%20atmosphaerischer%20Effekte%20in%20geovirtuellen%203D-Umgebungen%20in%20Echtzeit.pdf)
(2012, German).

- E. Bruneton, F. Neyret, ["Precomputed Atmospheric Scattering"](https://inria.hal.science/inria-00288758)
  (EGSR 2008): the model osgHimmel's atmosphere is built on.
- S. Hillaire, ["A Scalable and Production Ready Sky and Atmosphere Rendering
  Technique"](https://sebh.github.io/publications/egsr2020.pdf) (EGSR 2020): the tables and the sky pass, and the
  ozone layer's profile and absorption coefficients.
- T. Nishita, T. Sirai, K. Tadamura, E. Nakamae, "Display of the Earth Taking into Account Atmospheric
  Scattering" (SIGGRAPH 1993): atmosphere thickness constant.
- K. Riley, D. S. Ebert, M. Kraus, J. Tessendorf, C. Hansen, "Efficient Rendering of Atmospheric Phenomena"
  (EGSR 2004): the Rayleigh scattering coefficients, by way of Bruneton & Neyret.
- G. G. Bennett, "The Calculation of Astronomical Refraction in Marine Navigation" (1982): the fit the traced
  refraction is tested against.
- B. Edlén, "The Refractive Index of Air" (Metrologia, 1966): the refractivity of air, and its dispersion.
- D. L. Fried, "Optical Resolution Through a Randomly Inhomogeneous Medium for Very Long and Very Short Exposures"
  (JOSA, 1966), and "Anisoplanatism in adaptive optics" (JOSA, 1982): the parameter r0 the seeing is set by, and the
  isoplanatic distance of the turbulence.
- G. C. Valley, "Isoplanatic degradation of tilt correction and short-term imaging systems" (Applied Optics, 1980):
  the Hufnagel-Valley profile of the turbulence.
- J. L. Bufton, "Comparison of vertical profile turbulence structure with stellar observations" (Applied Optics,
  1973): the wind that carries it.
- M. Sarazin, F. Roddier, "The ESO differential image motion monitor" (Astronomy and Astrophysics, 1990): how far an
  image moves for a given r0.
- D. Dravins, L. Lindegren, E. Mezey, A. T. Young, "Atmospheric Intensity Scintillation of Stars" I to III (PASP,
  1997 to 1998): a star's scintillation and how apertures and exposures average it.
- L. C. Andrews, R. L. Phillips, "Laser Beam Propagation through Random Media" (SPIE Press, 2nd ed. 2005): the
  aperture averaging factor.
- F. N. Fritsch, R. E. Carlson, "Monotone Piecewise Cubic Interpolation" (SIAM J. Numer. Anal., 1980): the curve
  through the exposure keys.
- G. Kopp, J. L. Lean, "A new, lower value of total solar irradiance" (Geophysical Research Letters, 2011): the
  solar constant.
- S. Lagarde, C. de Rousiers, "Moving Frostbite to Physically Based Rendering" (SIGGRAPH course, 2014): EV100 and the
  light meter's calibration.
- R. Ulichney, "The void-and-cluster method for dither array generation" (SPIE 1913, 1993): the blue noise, the dither.
- M. Roberts, ["The Unreasonable Effectiveness of Quasirandom
  Sequences"](https://extremelearning.com.au/unreasonable-effectiveness-of-quasirandom-sequences/) (2018): the R2
  sequence, the cube map's samples per texel.
- H. Vogel, "A better way to construct the sunflower head" (Mathematical Biosciences, 1979): the spiral the ground's
  light is gathered on.
- T. Sobotka, [AgX](https://github.com/sobotka/AgX) (2023), in B. Wrensch's minimal fit,
  ["Minimal AgX Implementation"](https://iolite-engine.com/blog_posts/minimal_agx_implementation) (2023): a display
  tone curve.
- Khronos Group, ["PBR Neutral"](https://github.com/KhronosGroup/ToneMapping/tree/main/PBR_Neutral) (2024): the default.
- K. Narkowicz, ["ACES Filmic Tone Mapping Curve"](https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/)
  (2016): the third.
- Maxime Heckel, ["On rendering the sky, sunsets and
  planets"](https://blog.maximeheckel.com/posts/on-rendering-the-sky-sunsets-and-planets/): a WebGL/three.js
  single-scattering raymarcher, and a fine introduction to the topic.
- Daniel Müller (now Limberger), Juri Engel, Jürgen Döllner,
  ["Single-Pass Rendering of Day and Night Sky Phenomena"](https://diglib.eg.org/items/0b9332fd-d155-452a-b9e0-1c605d557730)
  (VMV 2012).

## Development

Part of the [himmelszelt monorepo](https://github.com/cgcostume/himmelszelt); run these from the repository root.

```sh
pnpm install     # everything, once
pnpm build       # rolldown -> dist/*.js + dist/*.d.ts, for every package
pnpm typecheck
pnpm lint        # biome, repo-wide
pnpm test        # playwright
pnpm dev         # the site, where this library's chapter lives: http://localhost:4321/himmelszelt/dunstkreis/
```

Inside `packages/dunstkreis`:

```sh
pnpm test:gpu    # the tests plus the WGSL ones, which execute real shaders via Dawn
```

The `webgpu` package needs its install script to run, which is approved in the root `pnpm-workspace.yaml`.
