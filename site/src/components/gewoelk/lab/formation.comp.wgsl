// The formation research figure: three layers of cloud, each a map of its own size and kind, marched together as one
// density with nothing baked but the maps, the way Horizon Zero Dawn and Red Dead Redemption 2 do it: every change is
// free, at the price of a march that samples towards the sun. For trying what the layers should be before any of
// them gets a distance field. Requires the research prelude, gewoelk's `noise.wgsl` and the `FormationLab` struct.

// A layer: its kind, 0 a field of heaps, 1 a deck, 2 towers, 3 a front; a slab `depth` km deep from `base` km up; a
// map of one `tile` km with features `feature` km across; and for a front `a` km from the observer to its leading
// edge, along the heading `b` in radians, `c` km deep from front to back.
struct FormLayer {
    enabled: f32,
    kind: f32,
    base: f32,
    depth: f32,
    coverage: f32,
    tile: f32,
    feature: f32,
    extinction: f32,
    detail: f32,
    sharp: f32,
    driftX: f32,
    driftY: f32,
    a: f32,
    b: f32,
    c: f32,
    seed: f32,
}

const FORM_LAYERS: u32 = 3u;

@group(0) @binding(0) var<uniform> F: FormationLab;
@group(0) @binding(1) var<uniform> L: array<FormLayer, 3>;
@group(0) @binding(2) var<uniform> V: LabView;
@group(0) @binding(3) var formMaps: texture_2d_array<f32>;
@group(0) @binding(4) var formSampler: sampler;
@group(0) @binding(5) var formDetail: texture_3d<f32>;
@group(0) @binding(6) var formClouds: texture_2d<f32>;
@group(0) @binding(7) var formClamp: sampler;
@group(0) @binding(8) var<uniform> formBake: vec4u;
@group(0) @binding(9) var formMapOut: texture_storage_2d_array<rgba16float, write>;
@group(1) @binding(0) var formOut: texture_storage_2d<rgba16float, write>;
@group(1) @binding(1) var formCanvas: texture_storage_2d<rgba8unorm, write>;

// Bumps, one per lattice cell where `share` of the cells have one: x the tallest bump's height at `p`, y a wide skirt
// around the tall ones, for their anvils.
fn formBumps(p: vec2f, period: vec2i, share: f32, seed: u32) -> vec2f {
    let cell = vec2i(floor(p));
    let f = p - floor(p);
    var best = vec2f(0.0);
    for (var j = -1; j <= 1; j = j + 1) {
        for (var i = -1; i <= 1; i = i + 1) {
            let o = vec2i(i, j);
            let h = gwLattice(vec3i(cell + o, 0), vec3i(period, 1), seed);
            let r = vec3f(gwUnit(h), gwUnit(gwHash(vec3u(h, 1u, 2u))), gwUnit(gwHash(vec3u(h, 3u, 4u))));
            let chosen = gwUnit(gwHash(vec3u(h, 5u, 6u)));
            if (chosen > share) {
                continue;
            }
            let center = vec2f(o) + 0.5 + (r.xy - 0.5) * 0.8;
            let tall = 0.45 + 0.55 * r.z;
            let d = length(f - center);
            let core = max(1.0 - d * d / (0.07 + 0.1 * r.z), 0.0);
            let skirt = max(1.0 - d * d / 0.3, 0.0) * smoothstep(0.8, 0.95, tall);
            best = max(best, vec2f(pow(core, 0.75) * tall, skirt));
        }
    }
    return best;
}

@compute @workgroup_size(8, 8, 1)
fn formBakeMap(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(formMapOut).xy;
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let layer = formBake.x;
    let l = L[layer];
    let seed = u32(l.seed) + layer * 17u;
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    let cells = max(1, i32(round(l.tile / max(l.feature, 1e-3))));
    let field = gwFbm(vec3f(uv * f32(cells), F.phase), vec3i(cells, cells, 8), 5u, seed);
    let spread = clamp((field - 0.5) * 2.4 + 0.5, 0.0, 1.0);
    let kind = u32(l.kind + 0.5);
    var value = 0.0;
    var extra = 0.0;
    if (kind <= 1u) {
        // The thesis' map: what the coverage leaves of the field, its edges hardened by the sharpness.
        value = pow(clamp((spread - (1.0 - l.coverage)) / max(l.coverage, 1e-3), 0.0, 1.0), 1.0 - 0.8 * l.sharp);
        // Rounded on top: a column grows fast near a cloud's edge and levels off towards its middle.
        value = 1.0 - (1.0 - value) * (1.0 - value);
        if (kind == 1u) {
            // A deck: closed for the most part, its top in lumps.
            let lumps = formBumps(uv * f32(cells * 3), vec2i(cells * 3), 1.0, seed + 7u).x;
            value = value * (0.55 + 0.45 * lumps);
        }
    } else if (kind == 2u) {
        // Towers: a few cells of many, each of its own height, their sides roughened by the field.
        let towers = formBumps(uv * f32(cells), vec2i(cells), l.coverage, seed + 9u);
        value = clamp(towers.x * (0.55 + 0.9 * spread), 0.0, 1.0);
        extra = towers.y;
    } else {
        // A front, x from its leading edge to its back, y along it: a wall of towers behind the edge, and a shield
        // of layered cloud thinning out to the rear.
        let x = uv.x + (field - 0.5) * 0.12;
        let lead = smoothstep(0.0, 0.05, x);
        let wall = exp(-pow((x - 0.09) / 0.05, 2.0));
        let shield = smoothstep(0.98, 0.5, x);
        let towers = formBumps(uv * vec2f(12.0, f32(cells)), vec2i(12, cells), 0.9, seed + 11u);
        value = clamp(lead * shield * (0.3 + 0.25 * spread) * (0.4 + 0.6 * l.coverage) + wall * (0.25 + 0.75 * towers.x), 0.0, 1.0);
        extra = wall * towers.y;
    }
    textureStore(formMapOut, vec2i(id.xy), layer, vec4f(value, extra, field, 1.0));
}

// A layer's map over the ground point `g`, km east and north of the observer: r the column's value, g the anvils'
// skirt. A front is placed, not tiled: nothing ahead of its edge or behind its back.
fn formColumn(i: u32, g: vec2f) -> vec4f {
    let l = L[i];
    var uv = (g - vec2f(l.driftX, l.driftY)) / l.tile;
    if (u32(l.kind + 0.5) == 3u) {
        let heading = vec2f(sin(l.b), cos(l.b));
        let x = (dot(g, heading) - l.a) / l.c;
        if (x <= 0.0 || x >= 1.0) {
            return vec4f(0.0);
        }
        uv = vec2f(x, dot(g, vec2f(heading.y, -heading.x)) / l.tile);
    }
    return textureSampleLevel(formMaps, formSampler, uv, i32(i), 0.0);
}

// Where a column of value `m` has its bottom and its top, as shares of the layer's depth: the bottoms nearly flat,
// as rising air condenses at one height, the tops as tall as the value.
fn formSpan(kind: u32, m: f32) -> vec2f {
    let dip = select(0.12, 0.3, kind == 1u);
    return vec2f(dip * (1.0 - m), dip + m * (1.0 - dip));
}

// The extinction per km at `p` and the optical depth straight up from there to the tops, summed over the layers.
fn formAt(p: vec3f, detailed: bool) -> vec2f {
    let radius = length(p);
    let altitude = radius - V.planetRadius;
    let up = p / radius;
    let g = labGround(up) * radius + V.flown;
    var sum = vec2f(0.0);
    for (var i = 0u; i < FORM_LAYERS; i = i + 1u) {
        let l = L[i];
        let h = (altitude - l.base) / l.depth;
        if (l.enabled < 0.5 || h <= 0.0 || h >= 1.0) {
            continue;
        }
        let kind = u32(l.kind + 0.5);
        let m = formColumn(i, g);
        let span = formSpan(kind, m.r);
        var shape = clamp(min(h - span.x, span.y - h) / 0.08, 0.0, 1.0) * step(1e-3, m.r);
        // An anvil: where a tall tower nears the top of its layer it spreads out over its skirt.
        if (kind >= 2u) {
            let anvil = smoothstep(0.15, 0.6, m.g) * smoothstep(0.8, 0.88, h) * smoothstep(1.0, 0.95, h);
            shape = max(shape, anvil);
        }
        if (shape <= 0.0) {
            continue;
        }
        var density = shape;
        if (detailed && l.detail > 0.0) {
            let noise = textureSampleLevel(formDetail, formSampler, vec3f(g, altitude) / F.noiseKm, 0.0);
            let lumps = mix(noise.b, noise.a, 0.4) * l.detail;
            density = clamp((shape - lumps) / max(1.0 - lumps, 1e-3), 0.0, 1.0);
        }
        sum = sum + l.extinction * vec2f(density, 0.6 * shape * max(l.base + span.y * l.depth - altitude, 0.0));
    }
    return sum;
}

// The lowest base and the highest top of the layers that are on.
fn formBounds() -> vec2f {
    var bounds = vec2f(1e9, -1e9);
    for (var i = 0u; i < FORM_LAYERS; i = i + 1u) {
        if (L[i].enabled > 0.5) {
            bounds = vec2f(min(bounds.x, L[i].base), max(bounds.y, L[i].base + L[i].depth));
        }
    }
    return bounds;
}

@compute @workgroup_size(8, 8, 1)
fn formMarch(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(formOut);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let v = labRay(V, vec2f(id.xy) + 0.5, size);
    let o = vec3f(0.0, 0.0, V.planetRadius + V.observer);
    let sun = normalize(V.sun);
    let bounds = formBounds();
    var luminance = vec3f(0.0);
    var through = 1.0;
    if (bounds.x < bounds.y) {
        // The stretch of the ray between the lowest base and the highest top, short of the ground.
        let inner = labSphere(o, v, V.planetRadius + bounds.x);
        let outer = labSphere(o, v, V.planetRadius + bounds.y);
        let ground = labSphere(o, v, V.planetRadius);
        var t0 = 0.0;
        var t1 = outer.y;
        if (V.observer < bounds.x) {
            t0 = inner.y;
        } else if (V.observer > bounds.y) {
            t0 = max(outer.x, 0.0);
            t1 = select(outer.y, inner.x, inner.x > 0.0);
        } else if (inner.x > 0.0) {
            t1 = inner.x;
        }
        if (ground.x > 0.0) {
            t1 = min(t1, ground.x);
        }
        if (outer.x < 0.0 && outer.y < 0.0) {
            t1 = -1.0;
        }
        t1 = min(t1, t0 + F.reachKm);
        let cosTheta = dot(v, sun);
        let overhead = labSky(vec3f(0.0, 0.0, 1.0), sun);
        let around = labSky(normalize(vec3f(v.xy, 0.08)), sun);
        // Jittered by a whole stride, so the bands a fixed start would draw turn into grain.
        var t = t0 + labJitter(id.xy, V.frame) * F.stepKm * (1.0 + max(t0, 0.0) * F.stepGrowth) * 2.5;
        // Striding through clear air; at the first cloud a stride back, and on in steps until the air has been clear
        // for a few of them.
        var striding = true;
        var clear = 0u;
        for (var i = 0u; i < u32(F.steps); i = i + 1u) {
            if (t >= t1 || through < 0.01) {
                break;
            }
            let step = F.stepKm * (1.0 + t * F.stepGrowth);
            let p = o + v * t;
            let here = formAt(p, true);
            if (here.x <= 0.0) {
                clear = clear + 1u;
                striding = striding || clear > 6u;
                t = t + select(step, step * 2.5, striding);
                continue;
            }
            if (striding) {
                striding = false;
                clear = 0u;
                t = max(t - step * 2.5, t0) + step;
                continue;
            }
            clear = 0u;
            // The cloud between here and the sun: six samples, each twice as far as the last, the first two detailed.
            var tau = 0.0;
            var reach = 0.06;
            for (var k = 0u; k < 6u; k = k + 1u) {
                tau = tau + formAt(p + sun * (reach * 1.5 - 0.06), k < 2u).x * reach;
                reach = reach * 2.0;
            }
            let altitude = length(p) - V.planetRadius;
            let light = labSunlight(dot(sun, p / length(p)), altitude);
            // The sun's light scattered once, and again and again as octaves, each through less cloud with a wider lobe.
            var orders = 0.0;
            var share = 1.0;
            var depth = 1.0;
            var lobe = 1.0;
            for (var k = 0u; k < 4u; k = k + 1u) {
                let phase = 0.8 * labHenyeyGreenstein(cosTheta, 0.8 * lobe) + 0.2 * labHenyeyGreenstein(cosTheta, -0.15 * lobe);
                orders = orders + share * exp(-tau * depth) * phase;
                share = share * F.multiple;
                depth = depth * max(F.multiple, 0.5);
                lobe = lobe * 0.5;
            }
            // Deep inside, the octaves die out long before the light does: it diffuses on, without a direction.
            orders = max(orders, F.multiple / (4.0 * LAB_PI * (1.0 + 0.15 * tau)));
            // The sky's light from above, through the cloud overhead, and the sunlit ground's from below.
            let gray = dot(overhead, vec3f(0.2126, 0.7152, 0.0722));
            let fromSky = mix(overhead, vec3f(gray), 0.5) * 0.6 * exp(-0.2 * here.y);
            let fromGround = labSunlight(sun.z, 0.0) * max(sun.z, 0.0) * 0.25 / LAB_PI * 0.35;
            let ambient = F.ambient * (fromSky + fromGround + around * 0.1);
            let source = light * orders + ambient;
            let passed = exp(-here.x * step);
            let near = exp(-t / F.fadeKm);
            let behind = labSkyFrom(V, v, sun);
            luminance = luminance + through * (1.0 - passed) * (source * near + behind * (1.0 - near));
            through = through * passed;
            t = t + step;
        }
    }
    textureStore(formOut, vec2i(id.xy), vec4f(luminance, through));
}

@compute @workgroup_size(8, 8, 1)
fn formCompose(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(formCanvas);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let sun = normalize(V.sun);
    // From above: every layer's column as a veil over the ground, north up, the observer in the middle.
    if (F.viewMode > 0.5) {
        let g = (vec2f(id.xy) - 0.5 * vec2f(size)) / f32(size.y) * F.mapKm * vec2f(1.0, -1.0) + V.flown;
        var color = vec3f(900.0, 1800.0, 3600.0);
        for (var i = 0u; i < FORM_LAYERS; i = i + 1u) {
            let l = L[i];
            if (l.enabled < 0.5) {
                continue;
            }
            let m = formColumn(i, g);
            let span = formSpan(u32(l.kind + 0.5), m.r);
            let tau = l.extinction * l.depth * max(span.y - span.x, 0.0) * step(1e-3, m.r) + 3.0 * m.g;
            let tint = mix(vec3f(17000.0), vec3f(7000.0, 7500.0, 8500.0), clamp(l.depth / 8.0, 0.0, 1.0));
            color = mix(color, tint, 1.0 - exp(-0.15 * tau));
        }
        let ring = abs(length(g - V.flown) - 0.012 * F.mapKm) < 0.003 * F.mapKm;
        textureStore(formCanvas, vec2i(id.xy), labDisplay(select(color, vec3f(20000.0, 6000.0, 2000.0), ring), V.exposure));
        return;
    }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    let clouds = textureSampleLevel(formClouds, formClamp, uv, 0.0);
    let v = labRay(V, vec2f(id.xy) + 0.5, size);
    let ground = 1.0 + V.gridStrength * labGrid(V, vec2f(id.xy) + 0.5, size);
    textureStore(formCanvas, vec2i(id.xy), labDisplay(labSkyFrom(V, v, sun) * ground * clouds.a + clouds.rgb, V.exposure));
}
