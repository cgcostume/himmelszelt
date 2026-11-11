// Oren and Nayar's rough diffuse surface, as nachtgestirn's `ngReflectance`, with a roughness of 0.5 rad: the law a
// renderer reaches for when Lambert's limb looks wrong. It brightens the limb towards full Moon, but has no surge and
// lets a half Moon fade into its terminator. The azimuth between the light and the viewer about the normal from the
// three angles alone. For the chapter's figures, by `MoonPassOptions.reflectance`.

fn ngReflectance(mu0: f32, mu: f32, cosG: f32) -> f32 {
    if (mu0 <= 0.0) {
        return 0.0;
    }
    let muSeen = max(mu, 0.0);
    let sigma2 = 0.25;
    let a = 1.0 - 0.5 * sigma2 / (sigma2 + 0.33);
    let b = 0.45 * sigma2 / (sigma2 + 0.09);
    let sinI = sqrt(max(1.0 - mu0 * mu0, 0.0));
    let sinE = sqrt(max(1.0 - muSeen * muSeen, 0.0));
    let cosAzimuth = max((cosG - mu0 * muSeen) / max(sinI * sinE, 1e-4), 0.0);
    let sinAlpha = max(sinI, sinE);
    let tanBeta = min(sinI / max(mu0, 1e-4), sinE / max(muSeen, 1e-4));
    return mu0 * (a + b * cosAzimuth * sinAlpha * tanBeta) / 3.141592653589793;
}
