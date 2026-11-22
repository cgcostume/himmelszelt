// The figures' twins of rundbild's ground.wgsl, in capture heights where not said otherwise: how high up the dome the
// ground meets it, the longest reach for that, and the bend between, a rational quadratic Bezier curve in the meridian.

/** As rbGroundedMeets: radians up the dome, seen from the capture point, for a bend `soft` of the widest. */
export function groundedMeets(height: number, radius: number, soft: number, horizon: number) {
    const r = radius / height;
    const rises = Math.sin(horizon);
    const up = Math.min(Math.max(soft, 0), 1) * Math.min(Math.max((1 + r * rises) / (1 + rises), 0), 0.5 * (r + 1));
    return Math.asin(Math.min(Math.max((up - 1) / (r - up), -1), 1));
}

/** As rbGroundedReach: the longest reach, in meters, for a bend that meets the dome `meets` radians up. */
export function groundedReach(height: number, radius: number, meets: number) {
    const r = radius / height;
    const rises = Math.min(Math.max(Math.sin(meets), -1 / r), 0.99);
    const up = (1 + r * rises) / (1 + rises);
    return height * Math.sqrt(Math.max((r - 1) * (r + 1 - 2 * up), 0));
}

/**
 * The bend as rbGroundedDirection lays it under a dome of `radius`, in capture heights: from the plane's edge `along`,
 * level, to where it meets the dome, at its slope, about the control point on the plane where the dome's tangent comes
 * down to it, of the weight that makes it the circle at the longest reach; `corner` where it meets the dome on the plane.
 */
export function groundedBend(height: number, reach: number, radius: number, meets: number) {
    const r = radius / height;
    const rises = Math.min(Math.max(Math.sin(meets), -1 / r), 0.99);
    const longest = groundedReach(height, radius, meets) / height;
    const corner = 1 + r * rises <= 1e-6;
    return {
        along: corner ? longest : Math.min(Math.max(reach / height, 0), longest),
        control: (r + rises) / Math.sqrt(1 - rises * rises),
        end: [r * Math.sqrt(1 - rises * rises), 1 + r * rises] as const,
        weight: Math.cos(0.5 * Math.asin(rises) + Math.PI / 4),
        corner,
        longest,
    };
}
export type GroundedBend = ReturnType<typeof groundedBend>;

/** The bend's point at `t` from 0 to 1, out from under the capture point and up. */
export function bendPoint({ along, control, end, weight }: GroundedBend, t: number): [number, number] {
    const [w0, w1, w2] = [(1 - t) ** 2, 2 * weight * t * (1 - t), t * t];
    const sum = w0 + w1 + w2;
    return [(along * w0 + control * w1 + end[0] * w2) / sum, (end[1] * w2) / sum];
}

/** How far the bend lies from the capture point along a lookup `down` (the sine of its depression), as rbGroundedGap. */
export function bendDistance(bend: GroundedBend, down: number) {
    const across = Math.sqrt(1 - down * down);
    const a0 = across - bend.along * down;
    const a1 = across - bend.control * down;
    const a2 = -(bend.end[0] * down + (bend.end[1] - 1) * across);
    const qa = a0 - 2 * bend.weight * a1 + a2;
    const qb = 2 * (bend.weight * a1 - a0);
    const q = -0.5 * (qb + Math.sign(qb || 1) * Math.sqrt(Math.max(qb * qb - 4 * qa * a0, 0)));
    let t = a0 / q;
    if ((t < 0 || t > 1) && Math.abs(qa) > 1e-12) t = q / qa;
    const [x, z] = bendPoint(bend, Math.min(Math.max(t, 0), 1));
    return Math.hypot(x, z - 1);
}
