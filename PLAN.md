# Plan

Open work on the site and the libraries, newest first. Check items off by deleting them; move anything that turns
into a decision into CLAUDE.md.

## Bugs

- **Fig. 5 (lighting), the sun is wrong.** To pin down: position, brightness or visibility, and from which height.
  The disc is placed and lit from the camera's height (its own sky pass, read back), the solids are lit from the
  observer's (`environment.sun`, `sky.apparentSun`).
- **Fig. 5, sometimes black with refraction on and the sun under the horizon.** Not reproduced yet. Suspects: the
  disc illuminance read back as zero while the refracted disc should still show; `apparentDirection` putting a hidden
  sun on the horizon.
- **Fig. 5, observer and camera height disagree.** The background and the sun disc follow the camera, the sky map,
  the spherical harmonics, the sunlight on the solids and the metered exposure follow the observer. Decide which
  height the scene stands for, and use it everywhere, or say in the caption why they differ.
- **The sun disc vanishes whole** once its true center sinks below the horizon seen from the camera, though a sliver
  of the refracted disc should still show: the meter measures `sunIlluminance` at the center only.

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
