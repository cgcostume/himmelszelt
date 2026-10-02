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

// Draw the debug overlay: altitude lines, the compass directions and a ring around the Sun.
override DK_DEBUG_GRID: bool = false;

// Draw the sun disc. Off for a cube map lighting a scene, which takes the sun as a light of its own: a disc of some
// 10^9 cd/m² in a few texels would outshine the whole sky in every filtered lookup.
override DK_SUN_DISC: bool = true;

// Write the six faces of a cube map, in cd/m², rather than an image through the camera.
override DK_CUBE: bool = false;

// Write the cube map's luminance times skyViewScale, like the sky-view table: half floats then hold the sky from noon
// into the night, where cd/m² would fall below their normal values in deep twilight.
override DK_CUBE_SCALED: bool = false;

// Spread the cube map's texels evenly over the sphere: see cube.wgsl.
override DK_CUBIFY: bool = false;

// Which rows of the sky-view table a dispatch writes: 0 all, 1 the sky above the horizon, 2 the ground below it, lit
// by the sky as well as the sun.
override DK_SKY_VIEW_ROWS: u32 = 0u;
