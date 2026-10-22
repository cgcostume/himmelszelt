// The passes' switches, pipeline-overridable like the sample counts in `quality.wgsl`: set once when a pass is made,
// so what is off compiles out instead of branching per pixel, and the uniforms keep only what changes per frame.

// Tone map for a display: exposed, compressed into [0, 1] and sRGB encoded, for an 8-bit target, by Khronos PBR Neutral
// (1), AgX (2) or Narkowicz's ACES fit (3), or only cut off at 1 (4), see tonemap.wgsl. Off (0), the sky pass writes the
// exposed luminance itself, linear and unclamped, for a float target and a renderer that tone maps the frame.
override DK_TONE_MAP: u32 = 1u;

// The display's headroom, how many times SDR white it shows at most, for a float target on an HDR display: Neutral
// and none compress or cut off there instead of at 1. AgX and ACES are fits to SDR and stay within 1.
override DK_HEADROOM: f32 = 1.0;

// Dither the tone mapped output by one 8-bit step against the bands smooth gradients show on an 8-bit target.
override DK_DITHER: bool = true;

// Expose by the light meter's reading, compensated and held within its range, instead of the uniform's exposure.
override DK_AUTO_EXPOSURE: bool = false;

// Draw the debug overlay: altitude lines, the compass directions and the sun symbol at the Sun's true direction.
override DK_DEBUG_GRID: bool = false;

// Draw the sun disc. Off for a cube map lighting a scene, which takes the sun as a light of its own: a disc of some
// 10^9 cd/m² in a few texels would outshine the whole sky in every filtered lookup.
override DK_SUN_DISC: bool = true;

// Without a tone curve, write how much of each pixel the disc covers into alpha, 0 off it: a caller that tone maps can
// then curve the sky and the disc apart and mix them after, as the pass does, rather than whitening every pixel the disc
// barely touches.
override DK_DISC_ALPHA: bool = false;

// Supersample the pixels the sun disc's edge or the horizon crosses, by rays bent each on its own way: the air squeezes
// the disc near the horizon and bends the planet's rim seen from space, sharper than one ray per pixel resolves.
// Off, they are antialiased by the pixel's footprint alone, which steps where the air squeezes.
override DK_SUPERSAMPLE: bool = true;

// Write the six faces of a cube map, in cd/m², rather than an image through the camera.
override DK_CUBE: bool = false;

// Write the cube map's or the panorama's luminance times skyViewScale, like the sky-view table: half floats then hold the
// sky from noon into the night, where cd/m² would fall below their normal values in deep twilight.
override DK_CUBE_SCALED: bool = false;

// Spread the cube map's texels evenly over the sphere: see cube.wgsl.
override DK_CUBIFY: bool = false;

// Write a panorama, in cd/m² like the cube map, rather than an image through the camera: 0 none, or one of the
// projections of panorama.wgsl. The equirectangular's upper half only, and the azimuth turned in radians, as there.
override DK_PANORAMA: u32 = 0u;
override DK_PANORAMA_UPPER_HALF: bool = false;
override DK_PANORAMA_AZIMUTH_OFFSET: f32 = 0.0;

// Which rows of the sky-view table a dispatch writes: 0 all, 1 the sky above the horizon, 2 the ground below it, lit
// by the sky as well as the sun.
override DK_SKY_VIEW_ROWS: u32 = 0u;
