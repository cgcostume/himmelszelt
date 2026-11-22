# @himmelszelt/gewoelk

Clouds for a WebGPU sky, after Nubis3, Guerrilla's voxel cloud renderer (Schneider 2023), on the cloud map of
[osgHimmel](https://github.com/cgcostume/osghimmel)'s thesis. Compute passes only, into textures you own: it never
creates a device, a canvas or a context, and depends on no other package at runtime. The sun comes in as a direction
and its light in lux, the sky's light as irradiance; where they come from is the caller's business,
[`@himmelszelt/sternzeit`](../sternzeit) and [`@himmelszelt/dunstkreis`](../dunstkreis) in the himmelszelt site.

*Gewölk* is the German word for a mass of many clouds.

## Two kinds of cloud

A **cloudscape** of low clouds lives in a voxel volume: a slab `heightKm` tall from `baseKm` up, repeating every
`extentKm` east and north, so it reaches the horizon. Nubis3 models its volumes offline, in Houdini; here the volume is
built on the GPU from a two-dimensional **cloud map**, the thesis' trick: octaves of tileable noise shaped by a coverage
and a sharpness, each value read as a height, the bottoms dipping a little below a base level and the tops rising by
the rest, so the clouds are flat below and billow above. From that volume, three passes make what Nubis3 stores per
voxel:

- the **modeling data** (rgba8unorm, 256 x 256 x 32 by default): the dimensional profile, a gradient from the surface
  into the cloud; the detail type, wispy to billowy; a density scale; and the signed distance outside, from a jump
  flood over the grid, over 8 bits rounded down so a step never overshoots;
- the **summed light** (rgba16float): per voxel the density summed to the sun, once per sun instead of per pixel and
  step;
- the **ambient light** (rgba16float, half the voxels east and north): per voxel how much of the sky's light and the
  ground's gets through, along two rings of rays up and two down, cosine-weighted, once per cloudscape and density. A
  wall under an overhang sees the sky beside it, so the ambient light is not dimmed by the profile again, as Nubis3's
  is;
- the **detail noise** (rgba8unorm, 128³, once): alligator noise after SideFX's for billows, inverted and swirled by a
  curl field for wisps, each at two frequencies.

The march per pixel is Nubis3's: outside the clouds the step is the signed distance, inside it grows with the square
root of the distance from the camera, and the first is jittered; at each step inside, the profile is eroded by the
detail composite, two samples towards the sun add detail to the summed light, Henyey-Greenstein lobes shape the
scattering, the orders of scattering after the first come as octaves (Wrenninge 2013, Hillaire 2016), each through
no less of a factor of the depth than its share, so they keep energy, and the ambient light fades with depth by the
ambient light's grid, not by the profile. Nubis3's inner glow is left out: it stands in for the same orders the octaves already give.

The air in front of the clouds is taken step by step, at each step's own distance, and leaves them as opaque as they
are. Given an `aerialPerspective` volume at `encode`, the `aerialPerspective` of dunstkreis' sky pass as it is, made
for the same camera, it is the atmosphere's own in-scattering and transmittance, by dunstkreis' own lookup, bundled
here. Without, for a baked background, far clouds fade
into the background's own pixel by `horizonFadeKm`, held below a few times `horizonLuminance` so the sun's disc does
not shine through, or into `horizonLuminance` where there is no background. With `clearingKm` the clouds grow fewer towards that distance from `clearingFromKm` on, the map's coverage falling and their tops
sinking first, and leave a clear horizon, under which a low sun reaches them.

The voxels are shaped from the map in a pass of their own: where a second, broader field is up (`towers`), clouds
rise up to `towerScale` times the layer's height and spread at the top, while the others keep to the layer; the slab
grows with the towers, so more `grid.layers` keep its voxels fine; `billows` of 3D turbulence
heap the surface up, deeper with height, so tops grow cauliflowers over flat bases.

The volume repeats every `extentKm`; `variation` thins its clouds out in places by a broad field that does not
repeat with it (the map's raw field, turned and stretched to `variationKm`), so the repetition hides towards the
horizon. Like the clearing, it only removes clouds, and it lightens the light grid's shadows as far as it does.

The air in front of the clouds is not dimmed by their shadow, as the sky beside them is not: a far cloud seen from under
the deck would else fade into a darker copy of the sky, a band along the horizon. The ground in the background lies in
it: where a ray meets the ground, the light grid at the base towards the sun
dims the sun's share of what the ground sends back, so the clouds cast their shadows, the air in front kept. What the
deck lets through on average, of the sun's light and the sky's, dims the ground's light on the clouds' undersides.
Deep in a thick cloud, where the octaves of scattering die out, the light diffuses on: the two-stream approximation's
1 / (1 + 3/4 (1 - g) tau) holds it up.

The layers are shells around the planet, so the sun stands higher over a cloud towards it, by a degree every 111 km.
The light grid holds the summed density towards the sun at four elevations above the local horizon, along straight
rays through the curved slab, and the march interpolates them at each point's own elevation: no flip when the sun
crosses the horizontal, but a sweep across the sky. The sun's light itself comes from `sunlight`, a table by altitude
and elevation that `sunlightRows` asks for (dunstkreis' transmittance table fills it): far clouds towards the sun stay
lit after the near ones, reddened, and the planet's shadow climbs them at dusk.

Up to two **sheets** of high cloud, cirrus and cirrostratus, are read once each where the ray crosses their sphere,
in the compose pass at the target's full size, so their strands stay sharp at any `scale`, and clear away towards the
cloudscape's `clearingKm` with it:
the map's value as an optical depth, thicker at a slant. Its patches are drawn out along the wind into plumes; strands
of ridged noise, finer and longer each octave down to hairs, sweep along a broad flow, curl into hooks and gather in
bundles, so feathers stand apart against the sky. `ripples` breaks the sheet into the rows of cloudlets of
cirrocumulus instead. Over both, a broad field makes the sheet denser and thinner by turns, fine turbulence breaks
it into flocks, and a grain of four turned octaves roughens it; every layer's strength and size is in `SheetNoise`.

`WEATHER` holds presets of the clouds' shape, from clear to overcast, the sheet's included, and `mixWeather` blends
two, number by number, for weather that changes.

Wind drifts each layer at its own speed; evolution, in map changes per hour, reshapes a map over time and, for the
cloudscape, rebuilds its voxels, distance field and light. Both are 0 for a sky that stands still, which then costs
nothing but the march.

## Use

```js
import { createCloudPass, DEFAULT_CLOUDSCAPE, DEFAULT_SHEET } from "@himmelszelt/gewoelk";

const clouds = await createCloudPass(device, { format: "rgba8unorm", scale: 0.5 });
// Per frame: the sky pass writes the background in cd/m² into an rgba32float texture, the clouds go over it.
clouds.update({ sunDirection, sunIlluminance, skyIrradiance, groundIrradiance, inverseViewProjection, ev100, timeS });
clouds.encode(encoder, canvasTexture, { background: skyTexture });
```

`scale` renders the clouds at a share of the target's size and composes them bilinearly: at 0.5 a quarter of the rays.
`background: false` writes the clouds alone, premultiplied luminance and transmittance, for a renderer that composites
them itself, and `toneMap: false` leaves the composed result linear. `whiteBalance`, helldunkel's `whiteBalance(white)`,
is applied with the exposure to the clouds and the background alike, the identity by default, so a background from
dunstkreis' sky pass is written without one. `maxSteps` and `nearLightSamples` set the march's
cost at creation.

Thin cloud lays a corona around the Sun and the Moon: its droplets diffract their light into a glow of a degree or two,
bluish white inside and red at its rim, where the clouds let some of that light through. `corona`, `DEFAULT_CORONA` by
default, sets the droplets' radius, 10 µm, and how far their sizes vary, 0.25, which leaves no ring; `false`
turns it off. The Sun's is lit by `sunIlluminance`, the Moon's by `moonDirection` and `moonIlluminance`, none by
default; the clouds themselves are lit by the Sun alone. `diffractionLobe` and `coronaShare` are the same numbers in
TypeScript, and `wgsl.corona` holds the binding-free functions, `gwCorona` and `gwCoronaLobe`.

### Kinds, quality and contrails

`CLOUDSCAPE_TYPES` names kinds of voxel cloud by their species, `humilis`, `mediocris`, `congestus`, `stratocumulus`
and `stratus`: each a `shape`, the cloudscape's numbers it sets, and the `grid` that holds it without waste. The
weathers take their cloudscapes from them.

```js
import { CLOUDSCAPE_TYPES, cloudQuality, contrailBehind, createCloudPass, DEFAULT_CLOUDSCAPE } from "@himmelszelt/gewoelk";

const quality = cloudQuality({ reach: "high", sampling: "medium", motion: "low" });
const clouds = await createCloudPass(device, { format: "rgba8unorm", high: true, ...quality.voxel });
const cloudscape = { ...DEFAULT_CLOUDSCAPE, ...CLOUDSCAPE_TYPES.congestus.shape, ...quality.clearing };
const contrails = [contrailBehind({ atKm: [4, -2], headingDeg: 70 }, { persistenceS: 600, wind: [18, 7] })];
clouds.update({ ...frame, cloudscape, contrails });
```

`cloudQuality` turns three dials of four levels each, `"low"` to `"ultra"`, into what the passes are made and updated
with: `reach`, how far the clouds are seen, `sampling`, the share of the frame, a ray's steps and the sizes of the
volumes and maps, and `motion`, how the shape changes, from not at all to every frame. One level sets all three. It
returns `voxel` for `createCloudPass`, `layered` and `march` for `createLayeredCloudPass`, the `clearing`, and for the
change `evolves`, the keyframes' `stepsPerFrame` and the layered model's `evolutionEveryS`, the seconds between two
bakes of its maps. `nearDetailKm` reads the detail noise a second time, five times finer, within that distance of
the eye, for an observer who flies among the clouds.

Contrails are streaks at the high sheet's altitude, `MAX_CONTRAILS` at most, drawn where the sheet is read, with a
sheet or without, for a pass made with `high`. A `Contrail` is two ends over the ground, a width at each and an optical
depth; `contrailBehind` lays one behind an `Aircraft` in a `ContrailAir`, as long as the aircraft flew while the trail
lasted, less the wind's drift. Where the aircraft are, and how long a trail lasts in the air up there, is the caller's
to say.

### Change over time

Three things change a cloudscape, at three costs. The wind's drift is a uniform. So is `detailShiftKm`, how far the
detail noise has risen through the clouds: add to it over time and the billows move, with nothing rebuilt. A change
of shape, of the Sun or of the weather rebuilds the volumes, some 24 ms for 256 x 256 x 64 voxels on a Radeon RX 7900
XT, which `update` does at once in the frame that asks.

With `keyframes: true` the pass builds them ahead instead, and the march reads a blend of the last two:

```js
const clouds = await createCloudPass(device, { format: "rgba8unorm", keyframes: true });
const { keyframes } = clouds;
// Per frame, t running from 0 to 1 over as long as a keyframe should take to blend in.
clouds.update(params, encoder);
if (keyframes.stale && keyframes.pending === 0 && !keyframes.ready) keyframes.begin();
keyframes.advance(2, { encoder });
if (t >= 1 && keyframes.ready) {
    keyframes.promote();
    t = 0;
}
keyframes.blend(Math.min(t, 1), { encoder });
```

`begin` freezes the parameters as last updated, `advance` runs that many of the build's steps, some fourteen passes,
and returns their names, `promote` makes the built keyframe the one blended towards, and `blend` writes the volumes
the march reads. It costs three more sets of the volumes in memory, and the blend each frame it runs. The first
keyframe is built by the first `update`.

Every identifier in the WGSL is prefixed `gw`/`GW_`; `wgsl` exports the fragments for inlining. The camera rays are
dunstkreis' `camera.wgsl` and the tone curves and the white balance helldunkel's, bundled at build time.

## Status

A first draft: the cloudscape, the sheets, wind and evolution, Nubis3's march and lighting. Not yet: the split into a
low resolution near the camera and a high one far away, temporal accumulation against the jitter's grain, mip
levels of the detail noise, clouds casting shadows on the ground, flocks of birds and halos.

## References

- A. Schneider, ["Nubis³: Methods (and madness) to model and render immersive real-time voxel-based
  clouds"](https://advances.realtimerendering.com/s2023/) (Advances in Real-Time Rendering in Games, SIGGRAPH 2023).
- A. Schneider, "The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn" (Advances in Real-Time Rendering in
  Games, SIGGRAPH 2015).
- J. C. Hart, "Sphere Tracing: A Geometric Method for the Antialiased Ray Tracing of Implicit Surfaces" (The Visual
  Computer, 1996): the distance field's steps.
- L. G. Henyey, J. L. Greenstein, "Diffuse radiation in the Galaxy" (Astrophysical Journal, 1941): the phase function.
- A. Beer, "Bestimmung der Absorption des rothen Lichts in farbigen Flüssigkeiten" (Annalen der Physik, 1852).
- M. Wrenninge, C. Kulla, V. Lundqvist, "Oz: The Great and Volumetric" (SIGGRAPH Talks 2013), and S. Hillaire,
  "Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite" (SIGGRAPH course 2016): the octaves of
  multiple scattering.
- K. Perlin, "Improving Noise" (SIGGRAPH 2002): the cloud map's noise.
- SideFX, [Alligator noise](https://www.sidefx.com/docs/hdk/alligator_2alligator_8_c-example.html), the HDK's example.
- M. Jarzynski, M. Olano, "Hash Functions for GPU Rendering" (JCGT, 2020): pcg3d and pcg4d, a cell's numbers; and
  C. Wellons, [lowbias32](https://nullprogram.com/blog/2018/07/31/), the corners' hash.
- I. Quílez, [gradient noise derivatives](https://iquilezles.org/articles/gradientnoise/): the curl field's slopes.
- J. Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare" (SIGGRAPH course 2014): the
  interleaved gradient noise a march is jittered by.
- D. Müller (now Limberger), "Photorealistisches Rendering atmosphärischer Effekte in geovirtuellen 3D-Umgebungen in
  Echtzeit" (master's thesis, HPI, 2012): the cloud map and the offset that flattens the bottoms.

## Development

Part of the [himmelszelt monorepo](https://github.com/cgcostume/himmelszelt); run `pnpm build`, `pnpm typecheck`,
`pnpm test` and `pnpm test:gpu` from the repository root or here.

`research/noise` times the noise and the passes that bake from it under Dawn, A/B against an earlier commit, and
renders both side by side: see its README.
