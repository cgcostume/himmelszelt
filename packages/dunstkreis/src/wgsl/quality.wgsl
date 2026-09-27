// Pipeline-overridable constants, WGSL's specialization mechanism. Unlike the physical parameters in
// `atmosphere.wgsl`, these are not data the shader reads at runtime: they are fixed when the pipeline is
// created, so the compiler can unroll the integration loops and fold the bounds away.
//
// That is exactly right for quality knobs. Changing one means recompiling a pipeline, which is what you want
// for a quality preset switched at most a handful of times, and wrong for something read per frame. Set them
// through `constants` on the pipeline descriptor; `pipelineConstants()` builds that record.

// Steps along each ray traced for the transmittance LUT, 18 rays per texel with refraction, to find the one arriving
// from the texel's direction. The single largest quality/cost lever in the precompute, and the reason it is an
// override: the loop bound has to be a constant for the compiler to unroll it.
override DK_SAMPLES_TRANSMITTANCE: u32 = 100u;

// Samples for the single-scattering integral, Bruneton's inscatter1 pass.
override DK_SAMPLES_INSCATTER: u32 = 50u;

// Samples for the irradiance integral over the hemisphere.
override DK_SAMPLES_IRRADIANCE: u32 = 32u;

// Samples for the spherical integral in Bruneton's multiple-scattering orders, which is quadratic in this
// count, so it dominates precompute time.
override DK_SAMPLES_INSCATTER_SPHERICAL: u32 = 16u;

// Samples for Hillaire's multiple-scattering LUT.
override DK_SAMPLES_MULTI_SCATTERING: u32 = 20u;

// Raymarch steps for Hillaire's per-frame sky-view LUT. The only one of these on the per-frame path.
override DK_SAMPLES_SKY_VIEW: u32 = 30u;

// Whether the sky pass tone maps its output for a display: exposed, compressed into [0, 1] and sRGB encoded, for an
// 8-bit target. Off, it writes the exposed luminance itself, linear and unclamped, for a float target and a renderer
// that tone maps the whole frame itself.
override DK_TONE_MAP: bool = true;

// Whether the sky pass dithers its output: grain of one 8-bit step against the bands smooth gradients show on an
// 8-bit target. Off for a float target, which has no such steps.
override DK_DITHER: bool = true;

// Whether the sky pass draws the debug overlay: altitude lines, the compass directions and a ring around the Sun.
override DK_DEBUG_GRID: bool = false;

// Whether the sky pass writes the six faces of a cube map, in cd/m², rather than an image through the camera.
override DK_CUBE: bool = false;

// Whether the sky-view pass redoes the table's lower half with the ground lit by the sky as well as the sun.
override DK_GROUND_LIGHT: bool = false;

// Samples of the sky gathering its light on the ground, 8 or 64, spread by the golden sets.
override DK_GROUND_SAMPLES: u32 = 64u;

// Samples per texel of a cube map, spread over it by the golden sets: 1, 8 or 64. More smooth the edges a texel
// straddles, the horizon's and the sun disc's.
override DK_CUBE_SAMPLES: u32 = 1u;

// Whether the sky pass draws the sun disc. Off for a cube map lighting a scene, which takes the sun as a light of its
// own: a disc of some 10^9 cd/m² in a few texels would outshine the whole sky in every filtered lookup.
override DK_SUN_DISC: bool = true;
