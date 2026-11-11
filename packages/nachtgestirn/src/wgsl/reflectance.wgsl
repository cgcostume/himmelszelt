// How the Moon reflects sunlight, binding-free: `ngReflectance`, the one function the Moon pass calls for it. Another
// law takes its place by a snippet of its own that defines the same function, `MoonPassOptions.reflectance`.
//
// Hapke's model as his 2012 book has it, with Sato et al.'s 2014 parameters for the Moon from LRO's wide angle camera,
// the near side's medians at 566 nm: the single scattering albedo w, a two-lobed Henyey-Greenstein phase function
// (b, c), the shadow hiding surge (amplitude BS0, width HS), multiple scattering through Chandrasekhar's H function in
// Hapke's 2002 approximation, and the shadows of a surface rough by a mean slope of 23.657° (Hapke 1984). Coherent
// backscatter and porosity are held off, as in the fit. It follows the measured Moon, ROLO, within a fifth of a stop.
// Everything that depends on the parameters alone is folded into constants; a call costs five exp, two log, an acos.

const NG_H12_W = 0.3231;
const NG_H12_B = 0.2366;
const NG_H12_C = 0.3344;
const NG_H12_BS0 = 1.75;
const NG_H12_HS = 0.05309;
const NG_H12_TAN = 0.43807450;
// chi = 1 / sqrt(1 + pi tan^2), and the factors of E1 = exp(-2 / (pi tan) cot y) and E2 = exp(-1 / (pi tan^2) cot^2 y).
const NG_H12_CHI = 0.78985375;
const NG_H12_E1 = 1.45322263;
const NG_H12_E2 = 1.65864783;
// r0 = (1 - gamma) / (1 + gamma), gamma = sqrt(1 - w).
const NG_H12_R0 = 0.09724960;
// One over the radiance factor at normal incidence and emission, so that point reflects like a Lambert surface.
const NG_H12_NORM = 5.35742953;

// Chandrasekhar's H function, multiple scattering, in Hapke's 2002 approximation.
fn ngH12H(x: f32) -> f32 {
    let y = max(x, 1e-4);
    return 1.0 / (1.0 - NG_H12_W * y * (NG_H12_R0 + (1.0 - 2.0 * NG_H12_R0 * y) * 0.5 * log((1.0 + y) / y)));
}

// E1 and E2 of an angle from its cosine and sine; both 0 straight on.
fn ngH12E(cosY: f32, sinY: f32) -> vec2f {
    if (sinY < 1e-4) {
        return vec2f(0.0);
    }
    let cotY = cosY / sinY;
    return vec2f(exp(-NG_H12_E1 * cotY), exp(-NG_H12_E2 * cotY * cotY));
}

// Luminance over the illuminance arriving along the light's direction, for normal albedo 1: `mu0` and `mu` the cosines
// of the angles of incidence and emission, `cosG` the cosine of the phase angle.
fn ngReflectance(mu0: f32, mu: f32, cosG: f32) -> f32 {
    if (mu0 <= 0.0 || mu <= 0.0) {
        return 0.0;
    }
    // The angles of incidence and emission, and the azimuth between their planes, psi, and what the shadows make of it.
    let sinI = sqrt(max(1.0 - mu0 * mu0, 0.0));
    let sinE = sqrt(max(1.0 - mu * mu, 0.0));
    let ei = ngH12E(mu0, sinI);
    let ee = ngH12E(mu, sinE);
    let cosPsi = select(1.0, clamp((cosG - mu0 * mu) / max(sinI * sinE, 1e-6), -1.0, 1.0), sinI * sinE > 1e-6);
    let psi = acos(cosPsi) / NG_PI;
    let half2 = 0.5 - 0.5 * cosPsi;
    let f = exp(-2.0 * sqrt(half2 / max(1.0 - half2, 1e-6)));

    // The rough surface's effective cosines, and its shadows, S, from whichever of the two angles is larger.
    let etaI = NG_H12_CHI * (mu0 + sinI * NG_H12_TAN * ei.y / (2.0 - ei.x));
    let etaE = NG_H12_CHI * (mu + sinE * NG_H12_TAN * ee.y / (2.0 - ee.x));
    var mu0e: f32;
    var mue: f32;
    var shadow: f32;
    if (mu0 >= mu) {
        let d = 2.0 - ee.x - psi * ei.x;
        mu0e = NG_H12_CHI * (mu0 + sinI * NG_H12_TAN * (cosPsi * ee.y + half2 * ei.y) / d);
        mue = NG_H12_CHI * (mu + sinE * NG_H12_TAN * (ee.y - half2 * ei.y) / d);
        shadow = mue / etaE * mu0 / etaI * NG_H12_CHI / (1.0 - f + f * NG_H12_CHI * mu0 / etaI);
    } else {
        let d = 2.0 - ei.x - psi * ee.x;
        mu0e = NG_H12_CHI * (mu0 + sinI * NG_H12_TAN * (ei.y - half2 * ee.y) / d);
        mue = NG_H12_CHI * (mu + sinE * NG_H12_TAN * (cosPsi * ei.y + half2 * ee.y) / d);
        shadow = mue / etaE * mu0 / etaI * NG_H12_CHI / (1.0 - f + f * NG_H12_CHI * mu / etaE);
    }

    // The phase function, the shadow hiding surge over tan(g / 2), and the multiple scattering.
    let b2 = NG_H12_B * NG_H12_B;
    let back = 1.0 - 2.0 * NG_H12_B * cosG + b2;
    let forth = 1.0 + 2.0 * NG_H12_B * cosG + b2;
    let p = (1.0 - b2) * (0.5 * (1.0 + NG_H12_C) / (back * sqrt(back)) + 0.5 * (1.0 - NG_H12_C) / (forth * sqrt(forth)));
    let tanHalf = sqrt(max(1.0 - cosG, 0.0) / max(1.0 + cosG, 1e-6));
    let surge = 1.0 / (1.0 + tanHalf / NG_H12_HS);
    let multiple = ngH12H(mu0e) * ngH12H(mue) - 1.0;

    let radiance = NG_H12_W * 0.25 * mu0e / max(mu0e + mue, 1e-6) * (p * (1.0 + NG_H12_BS0 * surge) + multiple) * shadow;
    return max(radiance, 0.0) * NG_H12_NORM / NG_PI;
}
