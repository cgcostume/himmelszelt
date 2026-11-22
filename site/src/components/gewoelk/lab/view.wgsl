// What the research figures share: the view, a stand-in sky and sun, and the way to the display. Binding-free; requires
// dunstkreis' `camera.wgsl`, helldunkel's `tonemap.wgsl` and the site's `groundgrid.wgsl`. Lengths in km, directions ENU, light in lux and cd/m².
// The sky here is a gradient, not dunstkreis': these figures are for the clouds' shape, and stand alone.

struct LabView {
    inverseViewProjection: mat4x4f,
    sun: vec3f,
    projectionDistance: f32,
    // The observer's height and the planet's radius, in km.
    observer: f32,
    planetRadius: f32,
    // What luminance in cd/m² is multiplied by, and the angle a pixel spans, in radians.
    exposure: f32,
    pixelAngle: f32,
    // Seconds, and the frame, which animates the jitter.
    time: f32,
    frame: f32,
    // How far the observer has flown from where the figure started, in km east and north.
    flown: vec2f,
    // The same per level of the ground's grid, as a share of that level's cell: two levels a vector, the coarsest first.
    grid: array<vec4f, 4>,
    // How much brighter a grid line makes the ground, 0 for no grid.
    gridStrength: f32,
    // What the stand-in sun's light is multiplied by: 1, or the Moon's share of it where the Moon is the light.
    lightScale: f32,
    // The luminance in cd/m² the stand-in sky's colors are brought to for the clouds' ambient light: a real sky's, where
    // the figure has one behind its clouds; 0 for the stand-in's own.
    skyLuminance: f32,
    // How many times SDR white the display may show: 1, or more on an HDR display.
    headroom: f32,
}

const LAB_PI: f32 = 3.141592653589793;
// How much of the ground's light a cloud's full shadow takes, the rest being the sky's.
const LAB_SHADOW: f32 = 0.7;

fn labRay(view: LabView, position: vec2f, size: vec2u) -> vec3f {
    let uv = position / vec2f(size);
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    return dkProjectRay(view.inverseViewProjection, ndc, clamp(view.projectionDistance, 0.0, 1.0));
}

// Where a ray from `o` meets the sphere of radius `r` about the planet's center, the nearer and the farther distance;
// negative x where it misses.
fn labSphere(o: vec3f, v: vec3f, r: f32) -> vec2f {
    let b = dot(o, v);
    let c = dot(o, o) - r * r;
    let h = b * b - c;
    if (h < 0.0) {
        return vec2f(-1.0, -1.0);
    }
    let s = sqrt(h);
    return vec2f(-b - s, -b + s);
}

// Where on a unit sphere about the planet's center `up` lies from the observer's zenith, as an arc east and north: by
// the sine, which keeps its precision near the zenith where the cosine has lost it.
fn labGround(up: vec3f) -> vec2f {
    let s = length(up.xy);
    return up.xy * select(1.0, atan2(s, up.z) / max(s, 1e-12), s > 1e-6);
}

// The ground's grid through the pixel at `position`, 0 to 1 (see groundgrid.wgsl).
fn labGrid(view: LabView, position: vec2f, size: vec2u) -> f32 {
    return gridLines(view.inverseViewProjection, view.projectionDistance, view.observer, view.planetRadius, view.grid, position, size);
}

fn labHenyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    return (1.0 - g2) / (4.0 * LAB_PI * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5));
}

// The sun's illuminance at `altitude` km for a sun `sine` of its elevation up: reddened by the air mass in the way.
fn labSunlight(sine: f32, altitude: f32) -> vec3f {
    let mass = exp(-altitude / 8.0) / (max(sine, 0.0) + 0.035);
    let up = smoothstep(-0.07, 0.02, sine + 0.012 * sqrt(max(altitude, 0.0)));
    return 128000.0 * exp(-vec3f(0.085, 0.15, 0.33) * mass) * up;
}

// The light of the view's sun, or of whatever stands in its place.
fn labLight(view: LabView, sine: f32, altitude: f32) -> vec3f {
    return labSunlight(sine, altitude) * view.lightScale;
}

// A color of the stand-in sky as the clouds' ambient light: at the real sky's luminance where the view has one.
fn labAmbient(view: LabView, color: vec3f) -> vec3f {
    if (view.skyLuminance <= 0.0) {
        return color;
    }
    return color * view.skyLuminance / max(dot(color, vec3f(0.2126, 0.7152, 0.0722)), 1e-6);
}

// What a layer of cloud of the optical depth `tau` lets through of the light on it, scattered or not, where it scatters
// forwards with the asymmetry `g`: two streams. A shadow on the ground is as deep as this is small.
fn labPassed(tau: f32, g: f32) -> f32 {
    return 1.0 / (1.0 + 0.75 * (1.0 - g) * tau);
}

// A clear sky's luminance along `v`: blue overhead, pale at the horizon, a glow about the sun, the ground below
// `horizon`, the height of the horizon as a ray's z.
fn labSkyOver(v: vec3f, sun: vec3f, horizon: f32) -> vec3f {
    let day = smoothstep(-0.1, 0.25, sun.z);
    let low = 1.0 - smoothstep(0.0, 0.35, sun.z);
    let zenith = vec3f(0.06, 0.17, 0.48) * 12000.0 * (0.12 + 0.88 * day);
    let warm = mix(vec3f(1.0), vec3f(1.25, 0.8, 0.5), low * (0.5 + 0.5 * dot(normalize(v.xy + vec2f(1e-5)), normalize(sun.xy + vec2f(1e-5)))));
    let pale = vec3f(0.42, 0.58, 0.85) * 14000.0 * (0.1 + 0.9 * day) * warm;
    let t = pow(clamp((v.z - horizon) / (1.0 - horizon), 0.0, 1.0), 0.38);
    var sky = mix(pale, zenith, t);
    sky = sky + labSunlight(sun.z, 0.0) * 0.006 * labHenyeyGreenstein(dot(v, sun), 0.76);
    let ground = pale * vec3f(0.42, 0.4, 0.36);
    return mix(ground, sky, smoothstep(-0.004, 0.0, v.z - horizon));
}

// The sky from the ground, its horizon level.
fn labSky(v: vec3f, sun: vec3f) -> vec3f {
    return labSkyOver(v, sun, 0.0);
}

// The sky from the observer's height, the horizon as far below eye level as the planet's curve puts it.
fn labSkyFrom(view: LabView, v: vec3f, sun: vec3f) -> vec3f {
    let r = view.planetRadius + view.observer;
    return labSkyOver(v, sun, -sqrt(view.observer * (2.0 * view.planetRadius + view.observer)) / r);
}

// The air's color in front of what lies along `v`, from the observer's height: the sky's there, and for a ray that
// ends on the ground the sky's at the horizon, since the air in front of the ground is no darker than the air beside it.
fn labAirFrom(view: LabView, v: vec3f, sun: vec3f) -> vec3f {
    let r = view.planetRadius + view.observer;
    let horizon = -sqrt(view.observer * (2.0 * view.planetRadius + view.observer)) / r;
    let level = vec3f(normalize(v.xy + vec2f(1e-9)) * sqrt(1.0 - horizon * horizon), horizon);
    return labSkyOver(select(v, level, v.z < horizon), sun, horizon);
}

// Exposed and tone mapped for the canvas, as the site's other figures: helldunkel's Neutral, towards `headroom` times
// SDR white.
fn labDisplay(luminance: vec3f, exposure: f32, headroom: f32) -> vec4f {
    return vec4f(hdToneMapNeutralHdr(luminance * exposure, headroom), 1.0);
}
