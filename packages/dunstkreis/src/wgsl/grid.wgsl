// The grid over a view of the sky, in the observer's frame, unbent: lines of altitude every 10 degrees with the horizon
// stronger, the eight compass directions up to 80 degrees, and the sun symbol where the Sun truly is, at any exposure.
// Binding-free and self-contained, so any view composes it; the sky pass draws it with `debugGrid`.

const DK_DEG_TO_RAD: f32 = 0.01745329251994330;
// The grid's lines' width, as a share of the angle a pixel spans across and down, and how far their strongest goes
// towards the ink: two thirds of the way.
const DK_GRID_LINE: f32 = 0.65;
const DK_GRID_FAINT: f32 = 1.5;

fn dkLine(distance: f32, width: f32) -> f32 {
    return 1.0 - smoothstep(0.5 * width, 1.5 * width, distance);
}

fn dkAltitudeDeg(v: vec3f) -> f32 {
    return asin(clamp(v.z, -1.0, 1.0)) / DK_DEG_TO_RAD;
}

fn dkAzimuthDeg(v: vec3f) -> f32 {
    return atan2(v.x, v.y) / DK_DEG_TO_RAD;
}

// An azimuth difference, wrapped into [-180, 180]: the azimuth jumps by 360 degrees due south.
fn dkAzimuthStep(first: f32, second: f32) -> f32 {
    return abs(fract((second - first) / 360.0 + 0.5) - 0.5) * 360.0;
}

// sternwarte's sun symbol around the Sun's true direction, unbent by the air: a circle and eight rays of two round dots
// each, the same size on screen at any zoom. The circle is the Sun's true disc, 8.5 pixels at the least, and the rays
// fade as it grows past that, gone before it would reach their first dots at 13.5 pixels. Where it is, rather than
// where it shows, so near the horizon the disc stands above it, and below the horizon it is drawn over the ground.
// `pixel` is the angle of one CSS pixel, `disc` the disc's radius in CSS pixels, `ratio` device pixels per CSS pixel.
fn dkSunSymbol(view: vec3f, sun: vec3f, pixel: f32, disc: f32, ratio: f32) -> f32 {
    if (dot(view, sun) <= 0.0) {
        return 0.0;
    }
    let level = cross(vec3f(0.0, 0.0, 1.0), sun);
    let across = select(vec3f(1.0, 0.0, 0.0), normalize(level), length(level) > 1e-6);
    let up = cross(sun, across);
    // In pixels from the Sun, in the plane facing it.
    let p = vec2f(dot(view - sun, across), dot(view - sun, up)) / pixel;
    let distance = length(p);
    // As thin as the grid's lines, in device pixels.
    let circle = dkLine(abs(distance - max(disc, 8.5)), 1.3 * DK_GRID_LINE / ratio);
    // The nearest of the eight rays, and the nearest of its two dots, at 13.5 and 18.8 pixels, 1.7 across.
    let step = 45.0 * DK_DEG_TO_RAD;
    let angle = round(atan2(p.y, p.x) / step) * step;
    let ray = vec2f(cos(angle), sin(angle));
    let along = dot(p, ray);
    let center = select(18.8, 13.5, along < 16.15);
    let bead = (1.0 - smoothstep(0.35, 1.35, length(p - ray * center))) * (1.0 - smoothstep(8.5, 11.5, disc));
    return max(circle, bead);
}

// How strongly the grid covers the pixel of `view`, 0 to 0.3 at the horizon and the Sun's symbol, for a view to draw it
// over its own marks, such as texel edges, rather than under. `right` and `below` are the rays of the neighboring
// pixels: a compute pass has no fwidth, so the lines' widths come from how much the angles change from one pixel to
// the next. `sun` is the Sun's true direction, `sunAngularRadius` its disc's radius in radians, `pixelRatio` device
// pixels per CSS pixel.
fn dkGridCoverage(view: vec3f, right: vec3f, below: vec3f, sun: vec3f, sunAngularRadius: f32, pixelRatio: f32) -> f32 {
    let altitude = dkAltitudeDeg(view);
    let azimuth = dkAzimuthDeg(view);
    // The lines about a device pixel thin, from the angle a pixel spans across and down; the symbol's size and the
    // gaps for the compass labels in CSS pixels, so they look the same on a display with twice the pixels.
    let ratio = max(pixelRatio, 1.0);
    let altitudeWidth = DK_GRID_LINE * (abs(dkAltitudeDeg(right) - altitude) + abs(dkAltitudeDeg(below) - altitude));
    let azimuthWidth = DK_GRID_LINE
        * (dkAzimuthStep(azimuth, dkAzimuthDeg(right)) + dkAzimuthStep(azimuth, dkAzimuthDeg(below)));

    let altitudeLine = dkLine(abs(fract(altitude / 10.0 + 0.5) - 0.5) * 10.0, altitudeWidth);
    let horizonLine = dkLine(abs(altitude), 1.5 * altitudeWidth);
    // Measured along the circle of altitude, so the lines keep their width as they converge towards the zenith.
    let compassDistance = abs(fract(azimuth / 45.0 + 0.5) - 0.5) * 45.0 * cos(altitude * DK_DEG_TO_RAD);
    let compassLine = dkLine(compassDistance, azimuthWidth * cos(altitude * DK_DEG_TO_RAD))
        * (1.0 - smoothstep(70.0, 80.0, abs(altitude)));
    let sunPixel = length(right - view) * ratio;
    let discPixels = sunAngularRadius / sunPixel;
    let symbol = dkSunSymbol(view, sun, sunPixel, discPixels, ratio);
    // Where a compass direction meets the horizon, its label stands: the lines leave it a gap 11 CSS pixels around.
    let compass = round(azimuth / 45.0) * 45.0 * DK_DEG_TO_RAD;
    let crossing = acos(clamp(dot(view, vec3f(sin(compass), cos(compass), 0.0)), -1.0, 1.0)) / sunPixel;
    let gap = smoothstep(9.0, 12.0, crossing);

    // Faint, the Sun as strong as the horizon.
    let grid = max(max(0.1 * altitudeLine, 0.3 * horizonLine), 0.15 * compassLine) * gap;
    return max(grid, 0.3 * symbol);
}

// The grid over `color` in `ink`, as dkGridCoverage covers it.
fn dkGridOverlay(
    color: vec3f,
    view: vec3f,
    right: vec3f,
    below: vec3f,
    ink: vec3f,
    sun: vec3f,
    sunAngularRadius: f32,
    pixelRatio: f32,
) -> vec3f {
    return mix(color, ink, dkGridCoverage(view, right, below, sun, sunAngularRadius, pixelRatio) / DK_GRID_FAINT);
}
