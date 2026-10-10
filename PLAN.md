# Plan

Open work on the site and the libraries, newest first. Check items off by deleting them; move anything that turns
into a decision into CLAUDE.md.

## Bugs

- **Fig. 5 with the sky map: the sun disc vanishes whole** once its true center sinks below the observer's horizon,
  though a sliver of the refracted disc should still show: the scene draws that disc itself, lit by `sunIlluminance`,
  which the meter measures at the center only, and as a round disc, not flattened by the air. Behind the live
  atmosphere the sky pass draws it, along every bent ray, as in Fig. 1.

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
