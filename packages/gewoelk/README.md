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
- the **summed light** (rgba16float): per cloud voxel the density summed to the sun, to the sky above and to the
  ground below, once per sun instead of per pixel and step;
- the **detail noise** (rgba8unorm, 128³, once): alligator noise after SideFX's for billows, inverted and swirled by a
  curl field for wisps, each at two frequencies.

The march per pixel is Nubis3's: outside the clouds the step is the signed distance, inside it grows with the square
root of the distance from the camera, and the first is jittered; at each step inside, the profile is eroded by the
detail composite, two samples towards the sun add detail to the summed light, Henyey-Greenstein lobes shape the
scattering, the orders of scattering after the first come as octaves (Wrenninge 2013, Hillaire 2016), each through
no less of a factor of the depth than its share, so they keep energy, and the ambient light fades with depth after
Nubis3's profile. Nubis3's inner glow is left out: it stands in for the same orders the octaves already give.

The air in front of the clouds is taken step by step, at each step's own distance, and leaves them as opaque as they
are. Given an `aerialPerspective` volume at `encode`, RGB froxels laid out as Hillaire's (dunstkreis' volume, turned
into RGB), it is the atmosphere's own in-scattering and transmittance. Without, for a baked background, far clouds fade
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

The air in front of the clouds lies in their shadow where the deck closes towards the sun: its light is dimmed by what
the light grid lets through where the ray meets the slab, which the grid holds for every voxel, cloud or not.

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
them itself, and `toneMap: false` leaves the composed result linear. `maxSteps` and `nearLightSamples` set the march's
cost at creation.

Every identifier in the WGSL is prefixed `gw`/`GW_`; `wgsl` exports the fragments for inlining. The camera rays are
dunstkreis' `camera.wgsl` and the tone curves helldunkel's, bundled at build time.

## Status

A first draft: the cloudscape, the sheets, wind and evolution, Nubis3's march and lighting. Not yet: the split into a
low resolution near the camera and a high one far away, temporal accumulation against the jitter's grain, mip
levels of the detail noise, clouds casting shadows on the ground, and contrails, flocks of birds, rainbows and halos.

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
- D. Müller (now Limberger), "Photorealistisches Rendering atmosphärischer Effekte in geovirtuellen 3D-Umgebungen in
  Echtzeit" (master's thesis, HPI, 2012): the cloud map and the offset that flattens the bottoms.

## Development

Part of the [himmelszelt monorepo](https://github.com/cgcostume/himmelszelt); run `pnpm build`, `pnpm typecheck`,
`pnpm test` and `pnpm test:gpu` from the repository root or here.
