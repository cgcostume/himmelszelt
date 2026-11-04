# @himmelszelt/helldunkel

From light to pixels: how bright a scene in cd/m² is shown, how its range is folded into the display's, and how the
result is written. Plain functions, binding-free WGSL and two small WebGPU passes, with no dependency on any other
package.

*Helldunkel* is the German word for *clair-obscur* and *chiaroscuro*, the interplay of light and shadow.

- `exposureFromEV100(ev100)`: what luminance in cd/m² is multiplied by, 1 / (1.2 · 2^EV100), the convention of cameras,
  Frostbite and Unreal (Lagarde & de Rousiers 2014). About 15 for a sunny day, 0 in twilight.
- `ev100FromLuminance(luminance)`: what a light meter reads for an average luminance, log2(L · 100 / 12.5).
- `wgsl.tonemap`, also as `@himmelszelt/helldunkel/wgsl`: exposed, scene-linear Rec. 709 to sRGB-encoded values, by
  `hdToneMapNeutral` (Khronos PBR Neutral), `hdToneMapAgx` (Sobotka's AgX in Wrensch's fit), `hdToneMapAces` (Narkowicz's
  ACES fit) or `hdToneMapClip`, none. `hdToneMapNeutralHdr` and `hdToneMapClipHdr` compress into a display's headroom,
  for a float canvas with extended tone mapping. `hdDither(color, pixel, levels)` adds a step of
  interleaved gradient noise (Jimenez 2014) before an 8-bit target rounds, `hdDitherBy(color, noise, levels)` a step of
  noise of your own, such as a blue noise texture's, and `hdBayer(pixel)` Bayer's 8x8 thresholds. Every identifier is prefixed `hd`/`HD_`.

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
  veil in a sky, where bloom knows only the image.

Gamut mapping and Display P3 are planned. `@himmelszelt/dunstkreis` bundles this package's curves for its sky pass, so
installing it needs nothing else. Part of the [himmelszelt monorepo](https://github.com/cgcostume/himmelszelt).
