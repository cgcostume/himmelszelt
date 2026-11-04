// What the passes share along a pixel's ray: its direction, layers of cloud to composite front to back, the ground
// beneath a point, the sun's light aloft, and the sheets of high cloud, read once each where the ray crosses their
// sphere, cheap enough for every pixel of the frame. Requires `noise.wgsl`, `params.wgsl` and `camera.wgsl`, and of
// the pass `gwParams`, `gwMap`, `gwVolumeSampler`, `gwSunlight`, `gwAerialLuminance`, `gwAerialTransmittance`,
// `gwClampSampler`, `gwLight` and `gwDeck`.

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
fn gwFlow(w: vec2f, sheet: GwSheet) -> vec2f {
    let period = vec3i(1 << 20);
    let width = sheet.fiberScale;
    let sweep = gwPerlin(vec3f(w / (25.0 * width), 0.5), period, sheet.seed) * 4.0 * width * sheet.sweep;
    let hook = gwPerlin(vec3f(w / (5.0 * width), 1.5), period, sheet.seed + 1u) * 0.8 * width * sheet.hook;
    return vec2f(w.x, w.y + sweep + hook);
}

// A sheet's fibers along the flow `p`: ridges of gradient noise, finer and more drawn out each octave down to hairs,
// `stretch` times as long as wide at first, raised to `power` to thin them, each faded where a pixel's `footprint` is
// wider than it.
fn gwFibers(p: vec2f, width: f32, power: f32, stretch0: f32, footprint: f32, seed: u32) -> f32 {
    let period = vec3i(1 << 20);
    var sum = 0.0;
    var total = 0.0;
    var weight = 0.5;
    var size = width;
    for (var k = 0u; k < 5u; k = k + 1u) {
        let stretch = stretch0 * (1.0 + 0.4 * f32(k));
        let ridge = pow(1.0 - abs(gwPerlin(vec3f(p.x / (stretch * size), p.y / size, f32(k) * 7.1), period, seed + 2u + k)), power);
        sum = sum + weight * mix(ridge, 0.35, smoothstep(0.1 * size, 0.4 * size, footprint));
        total = total + weight;
        weight = weight * 0.75;
        size = size / 2.5;
    }
    return clamp(1.4 * sum / total, 0.0, 1.0);
}

// Flocks at `p`, km over the ground: two octaves of turbulence, |gradient noise|, round tufts between thin creases
// `size` and 0.4 of it across, 1 on a tuft, each octave faded where a pixel's `footprint` is wider than it.
fn gwFlocks(p: vec2f, size0: f32, footprint: f32, seed: u32) -> f32 {
    let period = vec3i(1 << 20);
    var sum = 0.0;
    var size = size0;
    var weight = 0.65;
    for (var k = 0u; k < 2u; k = k + 1u) {
        let tuft = clamp(abs(gwPerlin(vec3f(p / size, 6.3 + f32(k)), period, seed + 20u + k)) * 2.2, 0.0, 1.0);
        sum = sum + weight * mix(tuft, 0.6, smoothstep(0.15 * size, 0.6 * size, footprint));
        size = size * 0.4;
        weight = 0.35;
    }
    return sum;
}

// Grain at `p`, km over the ground: four octaves of gradient noise from `size` down, each turned by 37° against the
// one before so no lattice shows, in [0, 1], each faded to the middle where a pixel's `footprint` is wider than it.
fn gwGrain(p: vec2f, size0: f32, footprint: f32, seed: u32) -> f32 {
    let period = vec3i(1 << 20);
    var sum = 0.0;
    var total = 0.0;
    var weight = 1.0;
    var size = size0;
    var q = p;
    for (var k = 0u; k < 4u; k = k + 1u) {
        let n = gwPerlin(vec3f(q / size, 9.7 + f32(k)), period, seed + 40u + k);
        sum = sum + weight * mix(n, 0.0, smoothstep(0.15 * size, 0.6 * size, footprint));
        total = total + weight;
        q = vec2f(0.7986 * q.x - 0.6018 * q.y, 0.6018 * q.x + 0.7986 * q.y);
        weight = weight * 0.6;
        size = size * 0.5;
    }
    return clamp(0.5 + 0.9 * sum / total, 0.0, 1.0);
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
    return mix(ripple, 0.35, smoothstep(0.08 * wavelength, 0.3 * wavelength, footprint));
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
    let over = gwGround(p);
    let ground = over - sheet.drift;
    let wind = vec2f(dot(ground, sheet.streak), dot(ground, vec2f(-sheet.streak.y, sheet.streak.x)));
    // Its coverage falls towards the clearing as the cloudscape's does: fewer patches, not fainter ones. The patches
    // are the map's, drawn out three times along the wind into plumes.
    let left = gwClearingOver(over);
    let mapped = textureSampleLevel(gwMap, gwVolumeSampler, vec2f(wind.x / 3.0, wind.y) / sheet.scale, i32(index + 1u), 0.0).r;
    let patches = mapped * smoothstep(1.0 - left, min(1.0 - left + 0.4, 1.0), mapped) * smoothstep(0.0, 0.3, left);
    if (patches <= 0.0) {
        return GwLayer(vec3f(0.0), 1.0);
    }
    let up = p / length(p);
    let slant = max(abs(dot(v, up)), 0.1);
    // A pixel's footprint on the sheet: t * spread across the view, that over the slant along it, stretched towards
    // the horizon. Their geometric mean, so the detail fades as far as it would shimmer, not as far as its longest axis.
    let footprint = t * spread / sqrt(slant);
    let flow = gwFlow(wind, sheet);
    // The strands gather in bundles, feathers with the sky between them, `bundleSize` across, 3.3 times as long.
    let across = max(sheet.bundleSize, 0.01);
    let bundle = 0.5 + 0.5 * gwPerlin(vec3f(flow.x / (3.3 * across), flow.y / across, 5.7), vec3i(1 << 20), sheet.seed + 12u);
    let fiber = gwFibers(flow, sheet.fiberScale, max(sheet.fiberPower, 0.5), max(sheet.fiberStretch, 1.0), footprint, sheet.seed) * mix(1.0, smoothstep(0.45, 0.8, bundle), sheet.bundles);
    // A veil the strands run through: eroded at its thin edges, and modulated within; or broken into ripples.
    let eroding = (1.0 - fiber) * sheet.detail * 0.9;
    var n = clamp((patches - eroding) / max(1.0 - eroding, 1e-3), 0.0, 1.0) * mix(1.0, 1.8 * fiber, sheet.detail);
    if (sheet.ripples > 0.0) {
        n = n * mix(1.0, gwRipples(flow, sheet.fiberScale, footprint, sheet.seed), sheet.ripples);
    }
    // Over it all, denser and thinner by turns over `broadSize`, broken into flocks in the small, and grained finer
    // still, so neither the flocks' cells nor smooth stretches show.
    let broad = gwPerlin(vec3f(ground / max(sheet.broadSize, 0.1), 8.9), vec3i(1 << 20), sheet.seed + 30u);
    let flocks = gwFlocks(ground, max(sheet.flockSize, 0.005), footprint, sheet.seed);
    let flocking = (1.0 - flocks) * sheet.flocks;
    n = clamp((n - flocking) / max(1.0 - flocking, 1e-3), 0.0, 1.0);
    // The grain keeps the density on average, rougher only.
    let grain = gwGrain(ground, max(sheet.grainSize, 0.005), footprint, sheet.seed);
    n = n * mix(1.0, 2.0 * grain, sheet.grain) * max(1.0 + sheet.broad * broad, 0.0);
    let tau = n * sheet.opticalDepth;
    let transmittance = exp(-tau / slant);
    let scattered = 1.0 - transmittance;
    // Half the depth towards the sun, as its light scatters on through the sheet; at a grazing sun no more than
    // three sheets' worth.
    let tauSun = tau / max(abs(dot(sun, up)), 0.3) * 0.5;
    let cosTheta = dot(v, sun);
    // Ice crystals: a sharp forward peak, and a broad lobe as much again for the light they scatter sideways. The
    // orders after the first come as octaves, as in the cloudscape, each through half the depth with a wider lobe:
    // a thick sheet stays bright, as its light is scattered on rather than lost; a thin one scatters but once.
    var orders = 0.0;
    var share = 1.0;
    var depth = 1.0;
    var lobe = 1.0;
    for (var k = 0u; k < 4u; k = k + 1u) {
        let phase = 0.5 * gwHenyeyGreenstein(cosTheta, sheet.forwardG * lobe) + 0.5 * gwHenyeyGreenstein(cosTheta, 0.2 * lobe);
        orders = orders + share * exp(-tauSun * depth) * phase;
        // Half the share through half the depth: a <= b, so the orders keep the energy they were given.
        share = share * 0.5 * select(1.0, scattered, k == 0u);
        depth = depth * 0.5;
        lobe = lobe * 0.5;
    }
    let direct = gwSunAt(2u + index, gwElevation(sun, up)) * orders;
    let ambient = (gwParams.skyIrradiance + gwParams.groundIrradiance) / (2.0 * GW_PI) * 0.5;
    return GwLayer(sheet.albedo * scattered * (direct + ambient), transmittance);
}

// Where a point stands over the ground, east and north in km along the planet's surface from below the observer,
// not across the tangent plane: the maps bend around the planet with the shells, and never fold back from orbit.
fn gwGround(p: vec3f) -> vec2f {
    let across = length(p.xy);
    return p.xy / max(across, 1e-6) * (gwParams.planetRadius * atan2(across, p.z));
}


// What is left of the clouds over the point `ground` from the observer towards the clearing, 1 to 0: the cloudscape's,
// which the sheets share.
fn gwClearingOver(ground: vec2f) -> f32 {
    let clearing = gwParams.cloudscape.clearing;
    if (clearing <= 0.0) {
        return 1.0;
    }
    let start = min(gwParams.cloudscape.clearingFrom, 0.99 * clearing);
    return 1.0 - smoothstep(start, clearing, length(ground));
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

// A point in the cloudscape: over which point of the ground, east and north of the observer along the surface, and
// how high above the base, each in km. Taken once per point, as the arc tangent it costs is read many times.
struct GwPoint {
    ground: vec2f,
    height: f32,
}

fn gwPointAt(p: vec3f) -> GwPoint {
    return GwPoint(gwGround(p), length(p) - gwParams.planetRadius - gwParams.cloudscape.base);
}

// A point in the cloudscape's unit cube: east and north wrapped by the extent, the height over the slab's.
fn gwVolumeCoordinate(x: GwPoint) -> vec3f {
    let volume = gwParams.cloudscape;
    return vec3f(fract((x.ground - volume.drift) / volume.extent), x.height / volume.height);
}

// The sun's share of the light on the ground where `up` points up, by illuminance; the rest is the sky's.
fn gwSunShare(up: vec3f, sun: vec3f) -> f32 {
    let weights = vec3f(0.2126, 0.7152, 0.0722);
    let fromSun = dot(gwParams.sunIlluminance, weights) * max(dot(sun, up), 0.0);
    return fromSun / max(fromSun + dot(gwParams.skyIrradiance, weights), 1e-6);
}

// How much of its light the ground keeps under the cloudscape on average, the sun's and the sky's, 1 without one.
fn gwGroundShade(sun: vec3f) -> f32 {
    if (gwParams.cloudscape.enabled == 0u) {
        return 1.0;
    }
    let share = gwSunShare(vec3f(0.0, 0.0, 1.0), sun);
    return share * gwDeck[0] + (1.0 - share) * gwDeck[1];
}

// How much of its light the ground keeps at `g`, on the ground: the sun's through the clouds towards it, from the light
// grid where its ray enters the base, the sky's as on average.
fn gwGroundShadow(g: vec3f, sun: vec3f) -> f32 {
    let volume = gwParams.cloudscape;
    if (volume.enabled == 0u) {
        return 1.0;
    }
    let up = normalize(g);
    var through = 1.0;
    if (dot(sun, up) > 0.0) {
        let b = g + sun * gwSphere(g, sun, gwParams.planetRadius + volume.base).far;
        let x = gwPointAt(b);
        let q = gwVolumeCoordinate(x);
        let span = volume.lightElevations;
        let slice = clamp((gwElevation(sun, b / length(b)) - span.x) / max(span.y - span.x, 1e-6), 0.0, 1.0) * 3.0;
        let summed = dot(textureSampleLevel(gwLight, gwVolumeSampler, vec3f(q.xy, 0.0), 0.0), max(1.0 - abs(slice - vec4f(0.0, 1.0, 2.0, 3.0)), vec4f(0.0)));
        through = gwDiffused(volume.extinction * summed * gwClearingOver(x.ground), volume.forwardG);
    }
    let share = gwSunShare(up, sun);
    return share * through + (1.0 - share) * gwDeck[1];
}
