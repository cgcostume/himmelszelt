// What the passes share along a pixel's ray: its direction, layers of cloud to composite front to back, the ground
// beneath a point, the sun's light aloft, and the sheets of high cloud, read once each where the ray crosses their
// sphere, cheap enough for every pixel of the frame. Requires `noise.wgsl`, `params.wgsl` and `camera.wgsl`, and of
// the pass `gwParams`, `gwMap`, `gwVolumeSampler`, `gwSunlight`, `gwAerialLuminance`, `gwAerialTransmittance` and
// `gwClampSampler`.

// The ray through a point of the target, in pixels from its top left corner, on dunstkreis' camera.
fn gwPixelRay(position: vec2f, size: vec2u) -> vec3f {
    let uv = position / vec2f(size);
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    return dkProjectRay(gwParams.inverseViewProjection, ndc, clamp(gwParams.projectionDistance, 0.0, 1.0));
}

// The sun's elevation above the local horizon where `up` points up, in radians.
fn gwElevation(sun: vec3f, up: vec3f) -> f32 {
    return asin(clamp(dot(sun, up), -1.0, 1.0));
}

// The sun's illuminance from `row` of the sunlight table at `elevation`.
fn gwSunAt(row: u32, elevation: f32) -> vec3f {
    let span = gwSunlight.span[row].xy;
    let f = clamp((elevation - span.x) / max(span.y - span.x, 1e-6), 0.0, 1.0) * f32(GW_SUNLIGHT_ENTRIES - 1u);
    let i = min(u32(f), GW_SUNLIGHT_ENTRIES - 2u);
    let at = row * GW_SUNLIGHT_ENTRIES + i;
    return mix(gwSunlight.illuminance[at].rgb, gwSunlight.illuminance[at + 1u].rgb, f - f32(i));
}

// Where a sheet's strands run at `w`, km along and across the wind: lines across it swept along a broad flow and
// curled into hooks by a smaller one, as the shear draws the fall streaks of ice out.
fn gwFlow(w: vec2f, width: f32, seed: u32) -> vec2f {
    let period = vec3i(1 << 20);
    let sweep = gwPerlin(vec3f(w / (25.0 * width), 0.5), period, seed) * 4.0 * width;
    let hook = gwPerlin(vec3f(w / (5.0 * width), 1.5), period, seed + 1u) * 0.8 * width;
    return vec2f(w.x, w.y + sweep + hook);
}

// A sheet's fibers along the flow `p`: ridges of gradient noise, finer and more drawn out each octave down to hairs,
// each faded where a pixel's `footprint` is wider than it.
fn gwFibers(p: vec2f, width: f32, footprint: f32, seed: u32) -> f32 {
    let period = vec3i(1 << 20);
    var sum = 0.0;
    var total = 0.0;
    var weight = 0.5;
    var size = width;
    for (var k = 0u; k < 5u; k = k + 1u) {
        let stretch = 10.0 + 4.0 * f32(k);
        let ridge = pow(1.0 - abs(gwPerlin(vec3f(p.x / (stretch * size), p.y / size, f32(k) * 7.1), period, seed + 2u + k)), 4.0);
        sum = sum + weight * mix(ridge, 0.35, smoothstep(0.06 * size, 0.25 * size, footprint));
        total = total + weight;
        weight = weight * 0.75;
        size = size / 2.5;
    }
    return clamp(1.4 * sum / total, 0.0, 1.0);
}

// Ripples of cirrocumulus along the flow `p`: crests across the wind, bent and broken into cells, 1 where a crest is.
fn gwRipples(p: vec2f, width: f32, footprint: f32, seed: u32) -> f32 {
    let period = vec3i(1 << 20);
    let wavelength = 0.5 * width;
    let bend = 6.0 * gwPerlin(vec3f(p / (8.0 * width), 2.5), period, seed + 9u);
    let crest = 0.5 + 0.5 * sin(6.2831853 * p.x / wavelength + bend);
    // Each crest a row of cloudlets, and rows strong and weak by turns.
    let lumps = 0.5 + 0.5 * gwPerlin(vec3f(p.x / wavelength, p.y / (1.3 * wavelength), 3.3), period, seed + 10u);
    let rows = 0.5 + 0.5 * gwPerlin(vec3f(p / (4.0 * width), 4.1), period, seed + 11u);
    let ripple = smoothstep(0.3, 0.9, crest) * smoothstep(0.25, 0.7, lumps) * smoothstep(0.2, 0.6, rows) * 1.8;
    return mix(ripple, 0.35, smoothstep(0.05 * wavelength, 0.2 * wavelength, footprint));
}

// Light scattered along a ray and what passes through: premultiplied, to composite front to back.
struct GwLayer {
    luminance: vec3f,
    transmittance: f32,
}

fn gwOver(front: GwLayer, behind: GwLayer) -> GwLayer {
    return GwLayer(front.luminance + front.transmittance * behind.luminance, front.transmittance * behind.transmittance);
}

// The air between the observer and a point: what passes of the point's light, per channel, and what light the air
// adds in front of it, in cd/m².
struct GwAir {
    transmittance: vec3f,
    luminance: vec3f,
}

// The air in front of a point `distance` km along the ray through `uv`, in [0, 1] from the target's top left. From an
// aerial perspective volume where one is bound, its froxels laid out as dunstkreis' (x and y the screen, slice k at
// reach * ((k + 0.5) / slices)^2 km), in RGB; else the point fades into `sky` by `fade`, 1/e of its light left there.
fn gwAirAt(uv: vec2f, distance: f32, sky: vec3f) -> GwAir {
    let aerial = gwParams.cloudscape.aerial;
    if (aerial.x > 0.0) {
        let slices = f32(textureDimensions(gwAerialLuminance).z);
        let first = 0.5 / slices;
        let p = vec3f(uv, max(sqrt(max(distance, 0.0) / aerial.x), first));
        // Short of the first slice's center, a share of it, as both grow with the distance there.
        let near = min(distance / (aerial.x * first * first), 1.0);
        let luminance = textureSampleLevel(gwAerialLuminance, gwClampSampler, p, 0.0).rgb / max(aerial.y, 1e-9);
        let transmittance = textureSampleLevel(gwAerialTransmittance, gwClampSampler, p, 0.0).rgb;
        return GwAir(mix(vec3f(1.0), transmittance, near), luminance * near);
    }
    let f = exp(-distance / max(gwParams.fade, 1e-3));
    return GwAir(vec3f(f), sky * (1.0 - f));
}

// Seen through `air`: the layer's own light dimmed by it, and the air's added where the layer covers what lies behind,
// which brings the air's own light along with it.
fn gwFaded(layer: GwLayer, air: GwAir) -> GwLayer {
    return GwLayer(layer.luminance * air.transmittance + air.luminance * (1.0 - layer.transmittance), layer.transmittance);
}

// The air's light along a ray, what far clouds fade into: the sky behind the pixel where there is one, held below a
// few times the horizon's so the sun's disc and its glare do not shine through a distant cloud; the horizon's else.
fn gwAirLight(behind: vec3f, hasBehind: bool) -> vec3f {
    let horizon = gwParams.horizonLuminance;
    if (!hasBehind) {
        return horizon;
    }
    let weights = vec3f(0.2126, 0.7152, 0.0722);
    let cap = max(4.0 * dot(horizon, weights), 1e-3);
    return behind * min(1.0, cap / max(dot(behind, weights), 1e-6));
}

// A sheet where the ray crosses its sphere: the map's value as an optical depth, thicker at a slant, lit by the sun
// through it with a forward lobe, and by the sky and the ground as an even glow. The map gives the sheet's patches;
// fibers swept along a flow erode them into strands, as the fall streaks of ice crystals drawn out by the shear look,
// or ripples break them into the waves of cirrocumulus.
fn gwSheet(index: u32, o: vec3f, v: vec3f, sun: vec3f, spread: f32, distance: ptr<function, f32>) -> GwLayer {
    let sheet = gwParams.sheet[index];
    let r = gwParams.planetRadius + sheet.altitude;
    let hit = gwSphere(o, v, r);
    let ro = length(o);
    var t = hit.far;
    if (ro > r) {
        t = hit.near;
    }
    let earth = gwSphere(o, v, gwParams.planetRadius);
    if (!hit.hits || t <= 0.0 || (ro < r && earth.hits && earth.near > 0.0)) {
        *distance = -1.0;
        return GwLayer(vec3f(0.0), 1.0);
    }
    *distance = t;
    let p = o + v * t;
    let ground = gwGround(p) - sheet.drift;
    let wind = vec2f(dot(ground, sheet.streak), dot(ground, vec2f(-sheet.streak.y, sheet.streak.x)));
    // Its coverage falls towards the clearing as the cloudscape's does: fewer patches, not fainter ones. The patches
    // are the map's, drawn out three times along the wind into plumes.
    let left = gwClearing(p);
    let mapped = textureSampleLevel(gwMap, gwVolumeSampler, vec2f(wind.x / 3.0, wind.y) / sheet.scale, i32(index + 1u), 0.0).r;
    let patches = mapped * smoothstep(1.0 - left, min(1.0 - left + 0.4, 1.0), mapped) * smoothstep(0.0, 0.3, left);
    if (patches <= 0.0) {
        return GwLayer(vec3f(0.0), 1.0);
    }
    let up = p / length(p);
    let slant = max(abs(dot(v, up)), 0.1);
    let footprint = t * spread / slant;
    let flow = gwFlow(wind, sheet.fiberScale, sheet.seed);
    // The strands gather in bundles, feathers with the sky between them.
    let bundle = 0.5 + 0.5 * gwPerlin(vec3f(flow.x / (12.0 * sheet.fiberScale), flow.y / (2.5 * sheet.fiberScale), 5.7), vec3i(1 << 20), sheet.seed + 12u);
    let fiber = gwFibers(flow, sheet.fiberScale, footprint, sheet.seed) * mix(1.0, smoothstep(0.3, 0.75, bundle), sheet.detail);
    // A veil the strands run through: eroded at its thin edges, and modulated within; or broken into ripples.
    let eroding = (1.0 - fiber) * sheet.detail * 0.9;
    var n = clamp((patches - eroding) / max(1.0 - eroding, 1e-3), 0.0, 1.0) * mix(1.0, 1.8 * fiber, sheet.detail);
    if (sheet.ripples > 0.0) {
        n = n * mix(1.0, gwRipples(flow, sheet.fiberScale, footprint, sheet.seed), sheet.ripples);
    }
    let tau = n * sheet.opticalDepth;
    let transmittance = exp(-tau / slant);
    let scattered = 1.0 - transmittance;
    // Half the depth towards the sun, as its light scatters on through the sheet; at a grazing sun no more than
    // three sheets' worth.
    let toSun = exp(-tau / max(abs(dot(sun, up)), 0.3) * 0.5);
    let cosTheta = dot(v, sun);
    // Ice crystals: a sharp forward peak, and a broad lobe as much again for the light they scatter sideways.
    let phase = 0.5 * gwHenyeyGreenstein(cosTheta, sheet.forwardG) + 0.5 * gwHenyeyGreenstein(cosTheta, 0.2);
    let direct = gwSunAt(2u + index, gwElevation(sun, up)) * toSun * phase;
    let ambient = (gwParams.skyIrradiance + gwParams.groundIrradiance) / (2.0 * GW_PI) * 0.5;
    return GwLayer(sheet.albedo * scattered * (direct + ambient), transmittance);
}

// Where a point stands over the ground, east and north in km along the planet's surface from below the observer,
// not across the tangent plane: the maps bend around the planet with the shells, and never fold back from orbit.
fn gwGround(p: vec3f) -> vec2f {
    let across = length(p.xy);
    return p.xy / max(across, 1e-6) * (gwParams.planetRadius * atan2(across, p.z));
}


// What is left of the clouds over `p` towards the clearing, 1 to 0: the cloudscape's, which the sheets share.
fn gwClearing(p: vec3f) -> f32 {
    let clearing = gwParams.cloudscape.clearing;
    if (clearing <= 0.0) {
        return 1.0;
    }
    let start = min(gwParams.cloudscape.clearingFrom, 0.99 * clearing);
    return 1.0 - smoothstep(start, clearing, length(gwGround(p)));
}

// The sheets along the ray, farthest first, each faded into the sky by the air before it.
fn gwSheets(o: vec3f, v: vec3f, sun: vec3f, spread: f32, uv: vec2f, sky: vec3f) -> GwLayer {
    var layers: array<GwLayer, 2>;
    var at = array<f32, 2>(-1.0, -1.0);
    for (var s = 0u; s < min(gwParams.sheets, 2u); s = s + 1u) {
        if (gwParams.sheet[s].enabled == 0u) {
            continue;
        }
        var distance = -1.0;
        let sheet = gwSheet(s, o, v, sun, spread, &distance);
        if (distance > 0.0) {
            layers[s] = gwFaded(sheet, gwAirAt(uv, distance, sky));
            at[s] = distance;
        }
    }
    var result = GwLayer(vec3f(0.0), 1.0);
    let far = select(0u, 1u, at[1] > at[0]);
    for (var k = 0u; k < 2u; k = k + 1u) {
        let s = select(far, 1u - far, k == 1u);
        if (at[s] > 0.0) {
            result = gwOver(layers[s], result);
        }
    }
    return result;
}
