# Plan

Open work on the site and the libraries, newest first. Check items off by deleting them; move anything that turns
into a decision into CLAUDE.md.

## Bugs

- **Metered exposure from orbit at sunrise sits on the floor of EV 4** and blows the lit rim out: the sampling caps
  above and below the horizon are mostly black space and night side, and the ten-stop range still lets them pull the
  geometric mean down. Meter the lit directions alone from space, or weight by luminance, as a camera's spot meter would.
- **Fig. 5 with the sky map: the sun disc vanishes whole** once its true center sinks below the observer's horizon,
  though a sliver of the refracted disc should still show: the scene draws that disc itself, lit by `sunIlluminance`,
  which the meter measures at the center only, and as a round disc, not flattened by the air. Behind the live
  atmosphere the sky pass draws it, along every bent ray, as in Fig. 1.

## Site: color and themes

- **Wide gamut**: under `@media (color-gamut: p3)` the accent and the figures' colors may reach beyond sRGB, which
  OKLCH gives for free (the browser maps them back to sRGB elsewhere). HDR is not possible in CSS: no CSS color goes
  brighter than white, and `dynamic-range-limit` only limits images and video. HDR stays with the WebGPU canvases,
  which support it already.
- **Light theme, by eye**: every figure in both themes, on a phone too. Known: the texel outlines on the tables
  (`--lookup-skyView`, `--accent` on the canvas overlays) are dark on the dark table images in the light theme; the
  key of Fig. 7 names the day in the accent, while its band is a lightened accent; the WebGPU canvases' info line is
  low in contrast in both themes.
- **Open**: whether a light page with a light accent, or a dark page with a dark one, should stay possible at all; for
  now the step picks the theme, from step 23 on light.

## dunstkreis chapter: structure

- The new sections are in the chapter as `<Planned what="section">` boxes: Any wavelengths you like, Color spaces,
  A default exposure for any atmosphere, On the display; "From light to pixels" is split into Exposure and Tone
  mapping. Most of the planned figures will not be built: filter them once the sections are written.
- Proposed order, in four parts: the physics (why blue, sunset, more than one bounce, bent light, Luftperspektive,
  from the ground to orbit), the machinery (tables, resolution and sampling, encoding), the color (four wavelengths,
  color spaces, from light to pixels, exposure, tone mapping, on the display), and the use (lighting a scene, precise
  and approximate, make your own, code examples). That moves Four wavelengths and Color spaces down from after the
  sunset, and Lighting a scene behind the color part. Open until the sections are written.

## dunstkreis: wavelengths

- **Any number of wavelengths**, in batches of four: the tables are computed once per batch, and each batch's sky
  view is turned into RGB through its own matrix and summed into one RGB table, which the sky pass reads with the
  identity in place of `toRgb`. Slower by the number of batches, so never the default; it is the reference for the
  chapter and for tests, and lets the generator export a sky from the whole spectrum.
- **A custom `toRgb`**: the matrix given rather than fitted, for the batches above and for random wavelengths, where
  it holds the color matching functions' weights divided by the sampling density.
- **Random wavelengths, a Monte Carlo reference**: four wavelengths per frame, one random and three at equal offsets
  from it (Wilkie et al.'s hero wavelengths), weighted as above and accumulated over frames. Unbiased, but noisy for a
  long time; the sky's spectra are smooth, so a fixed set of some 48 wavelengths with the exact weights converges
  without any noise and is likely the better ground truth. Worth showing both, and how the noise fades.
- **Report the fit's error in ΔE in OKLab** next to the percent, in `research/`: a percentage of what is hard to say,
  a perceptual difference is what the reader sees.

## dunstkreis: color

- **The fit's target space as an option**: linear sRGB today; linear Display P3 or Rec. 2020 by swapping the XYZ
  matrix in `fitSpectrumToRgb`, for a canvas configured with `colorSpace: "display-p3"`. Measure first how much of
  the sky, sunsets and deep twilight above all, lies outside sRGB at all; if it is little, this is a chapter point,
  not an option.
- **Gamut mapping after tone mapping**: a color outside the display's gamut today clips per channel, which shifts its
  hue. Reducing chroma in OKLCH at constant lightness and hue, as CSS Color 4 maps gamut, keeps it. An option of the
  tone map, if the measurement above shows it matters.
- **Not in OKLCH**: scattering adds light, and adding is only meaningful in a linear space of radiance. OKLCH comes in
  after the physics, for gamut mapping, for comparing colors and for the site's UI, never for the sky's computation.

## dunstkreis: exposure

- **A default curve for any atmosphere**: meter the model once, offline or at precompute time, at sun altitudes from
  some 18° below to 90°, add the compensation keys, and keep the result as absolute EV100 keys joined by the same
  monotone cubic. A few numbers, serializable, so a renderer without exposure gets a good one with no readback; the
  default atmosphere's curve ships with the package. Open: the observer's height as a second dimension, or the curve
  only for the ground.
- **No exposure baked into the tables**: it is one multiply at readout, and baking it in would lose the physical
  units the IBL, the meter and aerial perspective rely on. But the sky-view table's power of two that follows the
  Sun (`skyViewScale`) is already a baked exposure in all but name, kept for precision. Open: whether with a curve
  exposure, which needs no metering of the table first, that scale and the exposure become one, which would remove
  one concept rather than add one.

## Tooling

- **dunstkreis does not tree-shake**: importing only `exposureFromEV100` costs 8.7 kB, since two module-level
  statements cannot be dropped by a bundler: the loop that fills `TRAINING_SPECTRA` with `push`, and the `.join()`
  composing WGSL snippets in `wgsl/index.ts`. Build both lazily or mark them `/* @__PURE__ */`, then lower the limit
  in `.size-limit.json`.
- **The WGSL ships with its comments**, the larger part of dunstkreis' 27 kB for a sky: strip comments (and maybe
  whitespace) at build time, in a rolldown plugin, the source keeping them.

## Lookup figure (dunstkreis Fig. 2)

- The text says "30 steps" and "sixty lookups", true only at the default sample count.
- The view ray can be picked from the tables and the sky, not dragged in the scene itself.
- Fig. 1's marker for the picked ray is hidden when the ray is out of view; an arrow at the edge would point to it.
- On a phone the square scene leaves empty space under the drawing.
- The info line at the scene's foot runs into the arcs.
- Elevation stretch is 3 and the air 30 units thick; check whether thinner air reads better.

## Photon paths (part 2 of the lookup figure)

- A figure of a few random photon paths, traced back from the eye along the picked view ray and drawn from the sun,
  colored by wavelength (blue bounces often, red passes), under "Why is the sky blue?" or "More than one bounce".
  Shares the picked ray, the sun and the camera with the lookup figure. Replaces the planned "Scattering orders".

## Cleanup

- `rayAt` exists twice, in `tables.js` and `lookup.js`: move the texel-to-ray step into `lutmap.js`.
- `traceView` still returns the bent `path`, which no figure draws any more since every ray is drawn straight.
- The large tables figure no longer marks the picked ray but still picks on hover and click: keep or drop.
- `lookup.js` grew in steps (billboards, labels, the sun line, the slider): reread it as a whole and tidy.
- Fig. 1 of sternzeit now sizes its Moon by `SUN_SYMBOL` in pixels: check it next to the Sun at phone width.
- Check the dither toggles (Fig. 1, Fig. 5) and the rail cursor in Chrome by eye.

## Later

- **Tafeln**, a site section for all schematic figures, once dunstkreis and nachtgestirn stand: it references the
  figures and does not move them out of their chapters. Each figure can be embedded on its own, with or without its UI,
  themed light, dark or custom, and downloaded as SVG. Until then, build every new figure so it can be lifted out:
  colors only from CSS tokens, the UI switchable off, no reach into the chapter's DOM.
- **sternenheer: constellations**, their lines and names, and possibly their boundaries, not only the stars.
- **gewoelk: more than clouds**: contrails, flocks of birds.
- **gewoelk: rainbows and halos**, optics in raindrops and in the ice crystals of cirrus, not in the clear sky of
  dunstkreis.
- **Aurora**, last of all: references are hard to come by. No package decided yet.
- **Weather as input**: cloud cover, rain and haze as plain parameters for every package, like the sun direction. A live
  local weather approximation from an online service would then be an adapter on the site or an extra package, never a
  dependency of a library.
