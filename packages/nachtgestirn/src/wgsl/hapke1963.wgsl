// Hapke's lunar law of 1963 as Jensen et al. 2001 give it, as osgHimmel had it, as nachtgestirn's `ngReflectance`:
// Lommel-Seeliger's mu0 / (mu0 + mu), a surface of particles lit and seen through the same layer, with the phase
// angle's two factors, scaled so a point seen straight on at opposition reflects like a Lambert surface: the full Moon
// as bright at its edge as in its middle. A quarter of a stop too bright at the quarters. In place of `reflectance.wgsl`,
// by `MoonPassOptions.reflectance`.

// The opposition surge, Hapke's retrodirective function B(g, h) with the lunar h of 0.6: 2 at opposition, 1 from 90°.
fn ngHapke1963Surge(g: f32) -> f32 {
    let h = 0.6;
    if (g < 1e-4) {
        return 2.0;
    }
    if (g >= 1.5707963) {
        return 1.0;
    }
    let t = tan(g);
    let e = exp(-h / t);
    return 2.0 - t / (2.0 * h) * (1.0 - e) * (3.0 - e);
}

// Hapke's single particle scattering, S(g): a Lambert sphere's phase function and a little forward scattering, which
// lets a crescent keep a thin rim towards the Sun.
fn ngHapke1963Scattering(g: f32) -> f32 {
    let forward = 0.1;
    let c = cos(g);
    return (sin(g) + (3.141592653589793 - g) * c) / 3.141592653589793 + forward * (1.0 - c * 0.5) * (1.0 - c * 0.5);
}

fn ngReflectance(mu0: f32, mu: f32, cosG: f32) -> f32 {
    if (mu0 <= 0.0) {
        return 0.0;
    }
    let g = acos(cosG);
    let phase = ngHapke1963Surge(g) * ngHapke1963Scattering(g) / (2.0 * ngHapke1963Scattering(0.0));
    return 2.0 * mu0 / max(mu0 + max(mu, 0.0), 1e-4) * phase / 3.141592653589793;
}
