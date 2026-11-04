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
scattering, the orders of scattering after the first come as octaves (Wrenninge 2013, Hillaire 2016), the profile
stands in for Nubis3's inner glow, and the ambient light fades with depth.

Far clouds fade into the sky along the horizon, `horizonLuminance`, as aerial perspective does, and stay as opaque as
they are. Each layer may take the sun's illuminance at its own altitude, `sunIlluminance` on the layer: after sunset
the ground lies in shadow while a cloud base 2 km up is still lit from below by a reddened sun, and the summed density
towards it runs downward through the volume then.

Up to two **sheets** of high cloud, cirrus and cirrostratus, are read once each where the ray crosses their sphere:
the map's value as an optical depth, thicker at a slant.

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
