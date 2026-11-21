// What the air does to light arriving from beyond it, looked up in the air table: how far it bends a ray, what it lets
// through, how much of it the ray crosses and the turbulence on the way, by the ray's apparent altitude alone, for one
// observer height. For a star, the Moon, a planet, a satellite: anything outside the atmosphere. Binding-free: the
// table comes in as an argument, an rgba32float texture read with textureLoad, so it needs no sampler and no device
// feature. Fill it with `airTable` and `createAirTexture`, or yourself:
//
//     row 0   transmittance of sunlight, linear sRGB (r, g, b), and the bend in radians (a)
//     row 1   airmass (r), and the seeing's turbulence: its amount (g), distance in m (b) and wind (a)
//     row 2   the scintillation's turbulence: its amount (r), distance in m (g) and wind (b), and the dilution (a)
//     row 3   over the true altitude: the lift in radians (r)
//     row 4   texel 0: horizon, top, true horizon, true top, in radians; texel 1: the observer's height in m (r)
//
// Rows 0 to 2 run over the apparent altitude from the horizon to the top, row 3 over the true altitude from the true
// horizon to the true top, entry i at from + (to - from) (i / (width - 1))^4. Directions are ENU, z up, unit length.

const DK_AIR_ROW_LIGHT: i32 = 0;
const DK_AIR_ROW_SEEING: i32 = 1;
const DK_AIR_ROW_SCINTILLATION: i32 = 2;
const DK_AIR_ROW_LIFT: i32 = 3;
const DK_AIR_ROW_RANGE: i32 = 4;

// How much more or less than green's 550 nm the air bends sRGB's red, 610 nm, and blue, 465 nm: its refractivity
// there by Edlén's formula, over green's. A hundredth between red and blue, which near the horizon parts a star's
// colors by tens of arcseconds, red lowest: by the bend times the dilution times the difference.
const DK_AIR_DISPERSION: vec3f = vec3f(0.9964, 1.0, 1.0078);

// The altitudes the table spans, in radians: the apparent horizon and top, and the true ones.
fn dkAirRange(table: texture_2d<f32>) -> vec4f {
    return textureLoad(table, vec2i(0, DK_AIR_ROW_RANGE), 0);
}

// Where a ray `above` radians over a row's first altitude falls in it, the row `span` radians long: the entry below it
// and the share of the next.
fn dkAirEntry(table: texture_2d<f32>, above: f32, span: f32) -> vec2f {
    let last = f32(textureDimensions(table).x - 1u);
    let x = sqrt(sqrt(clamp(above / max(span, 1e-9), 0.0, 1.0))) * last;
    let i = min(floor(x), last - 1.0);
    return vec2f(i, x - i);
}

fn dkAirRow(table: texture_2d<f32>, row: i32, entry: vec2f) -> vec4f {
    let i = i32(entry.x);
    return mix(textureLoad(table, vec2i(i, row), 0), textureLoad(table, vec2i(i + 1, row), 0), entry.y);
}

fn dkAirAltitude(direction: vec3f) -> f32 {
    return atan2(direction.z, length(direction.xy));
}

// How far a direction lies above the altitude `low`, in radians. Its altitude less `low`, but turned down first: a
// GPU's atan2 is good to a few millionths of its result, which next to the horizon leaves nothing, where the
// difference of two altitudes would be off by an arcsecond, and the limb seen from orbit is squeezed sevenfold.
fn dkAirAbove(direction: vec3f, low: f32) -> f32 {
    let horizontal = length(direction.xy);
    return atan2(direction.z * cos(low) - horizontal * sin(low), horizontal * cos(low) + direction.z * sin(low));
}

// Whether a ray seen at an apparent altitude reaches space: below the horizon the ground hides what lies beyond.
fn dkAirShows(table: texture_2d<f32>, apparentAltitude: f32) -> bool {
    return apparentAltitude >= dkAirRange(table).x;
}

// The transmittance (rgb) and the bend in radians (a) of a ray seen at an apparent altitude in radians: how far the
// air turned it down, so what it shows lies that much lower. Below the horizon the horizon's.
fn dkAirLight(table: texture_2d<f32>, apparentAltitude: f32) -> vec4f {
    let range = dkAirRange(table);
    return dkAirRow(table, DK_AIR_ROW_LIGHT, dkAirEntry(table, apparentAltitude - range.x, range.y - range.x));
}

// How much higher a body `above` radians over the true horizon shows, in radians. Row 3's, then one step of Newton's
// towards the bend's own row, by its slope, which the dilution holds: a star lifted and the sky behind it unbent stay
// together to f32. Below the true horizon the horizon's, so a setting body sinks on behind the ground instead of
// dropping back to its true place.
fn dkAirLiftAbove(table: texture_2d<f32>, range: vec4f, above: f32) -> f32 {
    let lift = dkAirRow(table, DK_AIR_ROW_LIFT, dkAirEntry(table, above, range.w - range.z)).r;
    let shown = dkAirEntry(table, above + range.z + lift - range.x, range.y - range.x);
    let bend = dkAirRow(table, DK_AIR_ROW_LIGHT, shown).a;
    return lift + (bend - lift) * dkAirRow(table, DK_AIR_ROW_SCINTILLATION, shown).a;
}

// How much higher a body at a true altitude shows, in radians.
fn dkAirLift(table: texture_2d<f32>, trueAltitude: f32) -> f32 {
    let range = dkAirRange(table);
    return dkAirLiftAbove(table, range, trueAltitude - range.z);
}

// A direction turned up by an angle within its vertical plane. A rotation, not a round trip through its altitude and
// azimuth, which would take the direction through a GPU's atan2 and back.
fn dkAirTurnedUp(direction: vec3f, angle: f32) -> vec3f {
    let horizontal = length(direction.xy);
    if (horizontal < 1e-6) {
        return direction;
    }
    let up = vec3f(-direction.xy * (direction.z / horizontal), horizontal);
    return direction * cos(angle) + up * sin(angle);
}

// Where a body in the true direction shows, lifted by the air. Whether the ground hides it there, dkAirTowards tells.
fn dkAirLifted(table: texture_2d<f32>, direction: vec3f) -> vec3f {
    let range = dkAirRange(table);
    return dkAirTurnedUp(direction, dkAirLiftAbove(table, range, dkAirAbove(direction, range.z)));
}

// The direction a ray seen along `view` has once it has left the air: for looking up what lies beyond it. Green's;
// red's and blue's by dkAirTurnedUp with the bend times DK_AIR_DISPERSION.
fn dkAirUnbent(table: texture_2d<f32>, view: vec3f) -> vec3f {
    let range = dkAirRange(table);
    let entry = dkAirEntry(table, dkAirAbove(view, range.x), range.y - range.x);
    return dkAirTurnedUp(view, -dkAirRow(table, DK_AIR_ROW_LIGHT, entry).a);
}

// The air along a ray.
struct DkAir {
    // Whether the ray reaches space. The rest is the horizon's where it does not.
    shows: bool,
    // What the air lets through of sunlight, per channel of linear sRGB.
    transmittance: vec3f,
    // How far the air turned the ray down, in radians.
    bend: f32,
    // The air crossed, in columns of it straight up from sea level.
    airmass: f32,
    // The turbulence along the ray for the image's motion: its amount over that straight up from sea level, how far
    // away it lies, in meters, and the wind that carries it, as a share of the seeing's.
    seeing: vec3f,
    // The same for a point's flicker, each part weighed by its distance to the power 5/6. The amount is not capped:
    // through the limb from orbit it reaches ten thousand times the zenith's.
    scintillation: vec3f,
    // How much the air squeezes the sky here, the apparent altitude gained per true one: what a point's light, a
    // star's or a planet's, is multiplied by besides the transmittance, and its colors' spread. Not a surface's.
    dilution: f32,
}

fn dkAirOf(table: texture_2d<f32>, above: f32, span: f32) -> DkAir {
    let entry = dkAirEntry(table, above, span);
    let light = dkAirRow(table, DK_AIR_ROW_LIGHT, entry);
    let seeing = dkAirRow(table, DK_AIR_ROW_SEEING, entry);
    let scintillation = dkAirRow(table, DK_AIR_ROW_SCINTILLATION, entry);
    return DkAir(above >= 0.0, light.rgb, light.a, seeing.r, seeing.gba, scintillation.rgb, scintillation.a);
}

// The air along a ray seen at an apparent altitude in radians.
fn dkAirAt(table: texture_2d<f32>, apparentAltitude: f32) -> DkAir {
    let range = dkAirRange(table);
    return dkAirOf(table, apparentAltitude - range.x, range.y - range.x);
}

// The air along a ray seen along `view`: a body's lifted direction, or a pixel's ray.
fn dkAirTowards(table: texture_2d<f32>, view: vec3f) -> DkAir {
    let range = dkAirRange(table);
    return dkAirOf(table, dkAirAbove(view, range.x), range.y - range.x);
}
