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
renderer.

New to terms like inscatter, optical depth, or scale height? The [himmelszelt site](https://github.com/cgcostume/himmelszelt) explains every one of them, right where it is used.

## Hillaire at the core

The sky follows Hillaire 2020 on the model osgHimmel took from Bruneton & Neyret 2008:

| table | size | computed |
|---|---|---|
| transmittance | 256x64 | once per model, `precomputeAtmosphere()` |
| multiple scattering | 32x32 | once per model, `precomputeAtmosphere()` |
| sky view | 192x108 | whenever the Sun or the observer moves, by the pass from `createSkyPass()` |

Hillaire's multiple-scattering term is infinite-order under an isotropic assumption, where Bruneton's is a fixed number
of orders; for the Earth's air the two look nearly alike. Bruneton's four-dimensional inscatter table (32x128x32x8,
osgHimmel's) holds every sun position at once and gives aerial perspective between any two points. It may come later,
as another way to fill the sky-view table, rather than as a second renderer.

## Observer altitude and refraction

The observer can be anywhere from a millimeter above the ground up into space. Inside the atmosphere the sky pass
looks the sky up in the sky-view table; above it, where that table does not reach, it raymarches every pixel from
where its ray enters the atmosphere, and the planet shows, lit by the sun.

Atmospheric refraction is part of the model: the air's refractive index follows its density, `refractivity` times
the Rayleigh layer's, and every ray bends towards the denser air below it, the view rays as well as the sunlight
reaching each point. No fit is involved, so one model covers the observer on the ground, high up looking down and in
space looking through the limb. Bouguer's invariant (n r sin z stays constant along a ray) decides where the ground
starts, which also lifts the visible horizon by terrestrial refraction; the bending itself is traced, in the same steps
that integrate the scattering. The sky-view table is indexed by the apparent direction and stores how far each ray
bent, the transmittance table by the true direction light arrives from, so the sky pass looks both up and bends
nothing. Bodies stay visible while geometrically below the horizon, and the sun flattens there, without either being
special-cased. Near the ground the result lands within a few percent of Bennett's fit (Meeus 16.3), some 10% above it
at the horizon, where the model's single scale height makes the lowest air denser than the real one.

Set `refractivity: 0` to turn it off, which means recomputing the tables. `airRefractivity(temperatureC, pressureHPa)`
gives the value for other air, and `apparentDirection` traces where a body shows on the CPU. Feed the true sun
direction: an already refracted one would be lifted twice.

## Units, exposure and tone mapping

The sky comes out in cd/m². `solarIrradiance` is the sun's spectrum, `solarIlluminance` its illuminance above the
atmosphere, 128 000 lx by default: the solar constant of 1361 W/m² (Kopp & Lean 2011) times sunlight's luminous
efficacy of about 94 lm/W. `atmosphereUniformData` packs the spectrum scaled to it (`luminanceScale(model)`), so the
sky-view table holds cd/m² too: half floats keep full precision from 6·10⁻⁵ cd/m², deep into twilight, up to 65 504,
above the brightest sky around the sun.

Exposure is in EV100, the convention of cameras, Frostbite and Unreal (Lagarde & de Rousiers 2014):
`exposureFromEV100(ev100)` is 1 / (1.2 · 2^EV100). About 15 for a sunny day, 0 in twilight. A scene in cd/m² exposed at
the same EV100 looks the same in any renderer that follows it.

`autoExposure: true` exposes by a light meter instead, for a renderer without an exposure of its own or to follow day
into night. Whenever the sky-view table is rebuilt, a compute pass reads it in directions spread evenly over the sky
above the horizon and, apart, below it, and writes the brighter of the two geometric mean luminances to a buffer the sky
pass reads, so there is no round trip to the CPU. On the ground that is the sky; the air towards the near ground is dim.
High up it is the lit air below, while the sky above turns black. Above the atmosphere, beyond the table, the meter
raymarches its directions instead and so reads the lit planet. The reading is EV100 = log2(L · 100 / 12.5)
(`ev100FromLuminance`), held within `autoExposureRange`, [8, 20] by default, less `exposureCompensation`. The lower
bound keeps night dark: exposed like day, a night sky looks like one. Metering the table rather than the frame keeps the
reading still as the camera turns and leaves the sun disc out of it. It follows at once, with no eye adaptation over
time. `meteredEV100()` reads it back, e.g. for a UI.

`autoExposureKeys` shapes the ramp over the day: compensations at sun altitudes above the observer's horizon, which
sinks with height (some 10° at 100 km, so a sun 5° below the horizontal still shines on the observer and is keyed so),
joined by a monotone cubic (Fritsch & Carlson) that is smooth and never overshoots a key. A key's compensation is one
value, or a pair `{ rising, setting }` for mornings and evenings apart, told by whether the sun is east or west of the
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
−7, some 11 to 15 stops below the floor of 8. The floor stays until the night sky has light of its own: the moon's
scattered light, airglow, zodiacal light and the stars. Exposed that far now, the sky would show only the sun's last
twilight, amplified to where the f16 table runs out of precision. Then the floor drops and the night key follows.

To do: high up, and from space, the metered exposure still looks too bright, if only subjectively.

With `toneMap` on, the default, the pass writes display colors for an 8-bit target: exposed, mapped by Narkowicz's
ACES fit, sRGB encoded and dithered. Off, it writes the exposed luminance, linear and unclamped, for a float target and
a renderer that tone maps the frame itself. osgHimmel used Bruneton's curve, which had the encoding built in and was
tuned to its own arbitrary units.

## Status

Implemented so far:

- `src/model.ts`: the physical model and LUT configuration, with `OSGHIMMEL_ATMOSPHERE_MODEL` reproducing
  the original's `t_modelCfg` exactly and the defaults moved to modern values (thinner aerosol layer,
  stronger forward scattering, ozone).
- `src/refraction.ts`: the refraction the shaders trace, on the CPU, for where the sun shows.
- `src/wgsl/atmosphere.wgsl` and `src/uniforms.ts`: the `DkAtmosphere` uniform block and its packer.
- `src/wgsl/quality.wgsl` and `src/quality.ts`: the pipeline-overridable constants for sample counts and
  feature switches.
- `src/wgsl/common.wgsl`: ray-sphere geometry, rays bent by the air, density profiles and phase functions.
- `src/pass.ts`: the `SkyPass`/`AtmosphereLUTs` interfaces.
- `src/luts.ts`: the transmittance and multiple-scattering tables, `precomputeAtmosphere()`.
- `src/sky.ts`: the sky-view table, the light meter and the sky pass, `createSkyPass()`.
- `src/exposure.ts`: EV100 and the automatic exposure's ramp.

Aerial perspective, Bruneton's table as another filler, and the lit ground seen from inside follow.

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
    let horizon = dkHorizonMu(sky, r);
    ...
}` });

device.queue.writeBuffer(buffer, 0, atmosphereUniformData(DEFAULT_ATMOSPHERE_MODEL)); // 96 bytes
```

Three properties make this composable:

**No bindings are declared.** `common.wgsl`'s functions take the `DkAtmosphere` struct by value as their
first argument rather than reading a `var<uniform>`, so nothing here can collide with your group or binding
indices, and you decide where the data lives.

**Parameters are a uniform block, not string substitution.** `atmosphereUniformData()` packs a model into the
96-byte layout `atmosphere.wgsl` declares. A test parses that struct, walks it applying WGSL's uniform layout
rules, and checks the packer writes the right value at every offset, since nothing in the toolchain would
otherwise catch the two drifting apart.

**Quality is specialized with `override`s, not uniforms.** Sample counts and feature switches live in
`quality.wgsl` as pipeline-overridable constants, set through `constants` on the pipeline descriptor via
`pipelineConstants(config)`. Integration loop bounds stay compile-time constants so the compiler can unroll
them, and a disabled feature leaves no code behind rather than branching per pixel, like dithering with
`pipelineConstants(config, { dither: false })`.

Every identifier is prefixed `dk`/`DK_` so several `@himmelszelt/*` fragments can share one shader module.
Rolldown inlines the `.wgsl` files at build time, so `dist` reads nothing from disk and stays browser-safe.

### A note on testing shaders

The WGSL is tested by executing it, against the TypeScript twins, via Dawn in-process (`tests/gpu.ts`), not
in a browser: Playwright's bundled Chromium exposes no `navigator.gpu` at all, in any launch mode or behind
any flag. Those tests are opt-in (`pnpm test:gpu`) because the `webgpu` package aborts or deadlocks the
process in roughly one run in three, in plain node as much as under Playwright and regardless of the
workload. It has never produced a *wrong* value, only crashes, so the pure-TypeScript tests carry the
baseline and the GPU tests are run deliberately when touching WGSL.

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
- B. Edlén, "The Refractive Index of Air" (Metrologia, 1966): the refractivity of air.
- F. N. Fritsch, R. E. Carlson, "Monotone Piecewise Cubic Interpolation" (SIAM J. Numer. Anal., 1980): the curve
  through the exposure keys.
- G. Kopp, J. L. Lean, "A new, lower value of total solar irradiance" (Geophysical Research Letters, 2011): the
  solar constant.
- S. Lagarde, C. de Rousiers, "Moving Frostbite to Physically Based Rendering" (SIGGRAPH course, 2014): EV100 and the
  light meter's calibration.
- K. Narkowicz, ["ACES Filmic Tone Mapping Curve"](https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/)
  (2016): the display tone curve.
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
