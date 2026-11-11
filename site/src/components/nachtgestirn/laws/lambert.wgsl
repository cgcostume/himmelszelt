// Lambert's law, as nachtgestirn's `ngReflectance`: the law a renderer reaches for first, and the wrong one for the
// Moon, whose limb it darkens like a ball's. For the chapter's figures, by `MoonPassOptions.reflectance`.

fn ngReflectance(mu0: f32, mu: f32, cosG: f32) -> f32 {
    return max(mu0, 0.0) / 3.141592653589793;
}
