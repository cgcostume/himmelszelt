# @himmelszelt/helldunkel

From light to pixels: how bright a scene in cd/m² is shown, how its range is folded into the display's, and how the
result is written. Plain functions, binding-free WGSL and two small WebGPU passes, with no dependency on any other
package.

*Helldunkel* is the German word for *clair-obscur* and *chiaroscuro*, the interplay of light and shadow.

- `exposureFromEV100(ev100)`: what luminance in cd/m² is multiplied by, 1 / (1.2 · 2^EV100), the convention of cameras,
  Frostbite and Unreal (Lagarde & de Rousiers 2014). About 15 for a sunny day, 0 in twilight.
- `ev100FromLuminance(luminance)`: what a light meter reads for an average luminance, log2(L · 100 / 12.5).
- `localAdaptation(sceneEV100, objectEV100, strength)`: the stops an object far brighter than its scene is drawn darker,
  as the eye adapts to what it looks at: the Moon's disc in a night sky. 0 for a camera, the whole difference for the eye.
- `lowLightCompensation(luminance)`: the stops a dim scene is exposed darker than metered, so night stays dark rather than
  lifted to day: Krawczyk et al.'s (2005) key over middle gray, 0 from about 1.25 cd/m² up, -2.6 at night. Subtract it
  from a metered EV100; `hdLowLightCompensation` in `wgsl.exposure`, and the meter's `lowLight` reading applies it.
- `whiteBalance(white)`: a camera's white balance, the 3x3 matrix over linear sRGB that shows a reference white as D65,
  the working white of linear sRGB, at its own luminance, by the linear Bradford transform (Lam 1985), as ICC profiles
  (ICC.1:2022, Annex E) and raw converters adapt, column-major for WGSL's `mat3x3f`. Apply it before the exposure, by
  `applyWhiteBalance(rgb, balance)` or `hdWhiteBalance(rgb, balance)` in `wgsl.whitebalance`; `hdWhiteBalanceFor(white)`
  builds the same matrix on the GPU, for a white metered there. The whites: `whiteFromChromaticity([x, y])`,
  `planckianWhite(kelvin)` (Kang et al. 2002), `daylightWhite(kelvin)` (the CIE daylight locus, D65 at 6,504 K), all at
  unit luminance, `D65_WHITE`, whose balance is `NO_WHITE_BALANCE`, the identity, which changes nothing, and the CIE's
  standard white points A, D50, D55, D65, D75 and E as chromaticities, `WHITE_POINTS` (CIE 15:2018). For a sky,
  `SUN_WHITE`, the Sun above the air, about 6,000 K, a camera's daylight, and `MOON_WHITE`, the Moon above the air,
  about 4,750 K, on which the Moon is a neutral gray high in the sky and only the air colors it lower down.
  `whiteBalance(white, degree)` goes only part of the way, as an eye does: `adaptationDegree(luminance, surround)` is
  CIECAM02's degree of adaptation, 1 by day and about two thirds for the Moon in a night sky, and
  `hdWhiteBalanceBy(white, degree)` its matrix on the GPU.
- `wgsl.tonemap`, also as `@himmelszelt/helldunkel/wgsl`: exposed, scene-linear Rec. 709 to sRGB-encoded values, by
  `hdToneMapNeutral` (Khronos PBR Neutral), `hdToneMapAgx` (Sobotka's AgX in Wrensch's fit), `hdToneMapAces` (Narkowicz's
  ACES fit) or `hdToneMapClip`, none. `hdToneMapNeutralHdr` and `hdToneMapClipHdr` compress into a display's headroom,
  for a float canvas with extended tone mapping. `hdDitherBlue(color, pixel, levels, noise)` adds a step of blue noise
  (Ulichney's void and cluster, 1993) before an 8-bit target rounds, tiled from the texture `blueNoiseTexture(device)`
  makes; dunstkreis' sky pass and gewoelk's and sternenheer's compose dither by it. `hdBlueNoise(noise, pixel, frame)`
  reads it, moved along by the golden ratio each frame for a pass whose grain may change. `hdDither(color, pixel,
  levels)` adds interleaved gradient noise (Jimenez 2014) instead: no texture and cheaper, but its diagonal order shows
  in dark, flat areas. `hdDitherBy(color, noise, levels)` takes noise of your own, and `hdBayer(pixel)` gives Bayer's
  8x8 thresholds. Every identifier is prefixed `hd`/`HD_`.
- `blueNoiseTexture(device)`: the blue noise as a 64x64 r8unorm texture, made once per device and shared, from 4 KB of
  ranks carried in the code (`blueNoiseData()`, `pnpm data:bluenoise` regenerates them).

```js
import { exposureFromEV100, wgsl } from "@himmelszelt/helldunkel";

const exposure = exposureFromEV100(15);
const code = `${wgsl.tonemap}
fn show(luminance: vec3f, exposure: f32) -> vec3f {
    return hdToneMapNeutral(luminance * exposure);
}`;
```

- `createMeterPass(device, { source })`: a light meter over a cube map, an equirectangular panorama or an image. On the
  GPU it counts every texel, by the solid angle it covers, into histograms of red, green, blue, luminance and the
  brightest channel, and averages them. `encode` takes where it looks (`focus`, center-weighted or spot), a `mask`, how it
  averages (a floor of `rangeStops`, or `percentiles`) how fast it follows (`adapt`) and how many texels it counts (`maxSize`). A renderer binds `result` in its
  own shader, with no round trip; `readHistogram()`, `readLuminance()` and `readEV100()` read it back.
- `adaptEV100(current, target, seconds, { toBrighter, toDarker })`: the same following on the CPU.
- `createBloomPass(device)`: `encode(encoder, source, target, strength)` over a linear, exposed rgba16float image, after
  Jimenez 2014, before the tone curve. It moves light rather than adding it.
- `veilingGlare(angle, age, pigment)` and `hdVeil` in `wgsl.glare`: the eye's veil around a bright point source, CIE's
  general disability glare equation (CIE 146:2002), in cd/m² per lux at the eye, to add before the exposure. The Sun's
  veil in a sky, where bloom knows only the image. At a two-hundredth of its strength it is a camera lens's.
- `meanVeilingGlare(radius, sourceRadius, age, pigment)`: that veil on average over a field around the source, for
  metering a frame with the Sun or the Moon in it; finite where the equation at the source is not.
- `hdStarburst(offset, radius, blades)` in `wgsl.lens`: the spikes an aperture's straight blades diffract a bright
  point source into, falling with the square of the angle along each and longer in red than in blue, laid out in the
  image plane, in cd/m² per lux at the lens, to add before the exposure; `starburstSpikes(blades)` counts them, as many
  as blades for an even count, twice as many for an odd one. Like the veil a point spread of the whole source: whoever
  has something in front of it, or the source out of the frame, dims the illuminance.
- `darkAdaptedEye(rgb)` and `hdDarkAdaptedEye` in `wgsl.vision`: linear sRGB in cd/m² as the eye sees it at night, Jensen et
  al.'s blue shift (Night Rendering, 2000) on Larson et al.'s scotopic luminance. Below 0.01 cd/m² the rods see alone,
  above 4 the cones, `coneShare` between; the rods' light takes the chromaticity (0.25, 0.25), so colors fade and the
  moonlit night turns blue. Per pixel, before the exposure; a camera, which has no rods, sees none of it.

Gamut mapping and Display P3 are planned. `@himmelszelt/dunstkreis` bundles this package's curves for its sky pass, so
installing it needs nothing else. Part of the [himmelszelt monorepo](https://github.com/cgcostume/himmelszelt).
