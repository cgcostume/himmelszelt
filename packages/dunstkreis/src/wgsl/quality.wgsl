// Sample counts as pipeline-overridable constants, WGSL's specialization mechanism. Unlike the physical parameters in
// `atmosphere.wgsl`, these are not data the shader reads at runtime: they are fixed when the pipeline is created, so the
// compiler can unroll the integration loops and fold the bounds away.
//
// That is exactly right for quality knobs. Changing one means recompiling a pipeline, which is what you want for a
// quality preset switched at most a handful of times, and wrong for something read per frame. Set them through
// `constants` on the pipeline descriptor; `pipelineConstants()` builds that record.

// Samples along each ray traced for the transmittance LUT, 18 rays per texel with refraction, to find the one arriving
// from the texel's direction. The single largest quality/cost lever in the precompute.
override DK_SAMPLES_TRANSMITTANCE: u32 = 100u;

// Samples for Hillaire's multiple-scattering LUT.
override DK_SAMPLES_MULTI_SCATTERING: u32 = 20u;

// Raymarch samples for Hillaire's per-frame sky-view LUT. The only one of these on the per-frame path.
override DK_SAMPLES_SKY_VIEW: u32 = 30u;

// Samples of the sky gathering its light on the ground, on Vogel's spiral.
override DK_SAMPLES_GROUND: u32 = 64u;

// Samples per texel of a cube map, spread over it by the R2 sequence. More smooth the edges a texel straddles, the
// horizon's and the sun disc's.
override DK_SAMPLES_CUBE: u32 = 1u;
