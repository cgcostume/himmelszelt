# @himmelszelt/helldunkel

From light to pixels: how bright a scene in cd/m² is shown, how its range is folded into the display's, and how the
result is written. A few plain functions and binding-free WGSL, with no dependency on any other package and no device
or pass of its own.

*Helldunkel* is the German word for *clair-obscur* and *chiaroscuro*, the interplay of light and shadow.

- `exposureFromEV100(ev100)`: what luminance in cd/m² is multiplied by, 1 / (1.2 · 2^EV100), the convention of cameras,
  Frostbite and Unreal (Lagarde & de Rousiers 2014). About 15 for a sunny day, 0 in twilight.
- `ev100FromLuminance(luminance)`: what a light meter reads for an average luminance, log2(L · 100 / 12.5).
- `wgsl.tonemap`, also as `@himmelszelt/helldunkel/wgsl`: exposed, scene-linear Rec. 709 to sRGB-encoded values, by
  `hdToneMapNeutral` (Khronos PBR Neutral), `hdToneMapAgx` (Sobotka's AgX in Wrensch's fit), `hdToneMapAces` (Narkowicz's
  ACES fit) or `hdToneMapClip`, none. `hdToneMapNeutralHdr` and `hdToneMapClipHdr` compress into a display's headroom,
  for a float canvas with extended tone mapping. Every identifier is prefixed `hd`/`HD_`.

```js
import { exposureFromEV100, wgsl } from "@himmelszelt/helldunkel";

const exposure = exposureFromEV100(15);
const code = `${wgsl.tonemap}
fn show(luminance: vec3f, exposure: f32) -> vec3f {
    return hdToneMapNeutral(luminance * exposure);
}`;
```

Gamut mapping and Display P3 are planned. `@himmelszelt/dunstkreis` bundles this package's curves for its sky pass, so
installing it needs nothing else. Part of the [himmelszelt monorepo](https://github.com/cgcostume/himmelszelt).
