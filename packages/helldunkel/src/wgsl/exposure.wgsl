// Exposure helpers, binding-free, for a consumer's own shaders and the meter.

// The stops a dim scene's exposure is lowered by, Krawczyk et al.'s key of its average luminance in cd/m² over middle
// gray: 0 from about 1.25 cd/m² up, -2.6 at night. Subtract it from a metered EV100. As `lowLightCompensation`.
fn hdLowLightCompensation(averageLuminance: f32) -> f32 {
    let key = 1.03 - 2.0 / (2.0 + log2(max(averageLuminance, 0.0) + 1.0) * 0.30102999566398120);
    return min(log2(key / 0.18), 0.0);
}
