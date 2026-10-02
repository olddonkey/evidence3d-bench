# Occluders (trees, parked vehicles, poles) and the distant backdrop.
#
# Every occluder is built from the parameters the Node planner chose, and every
# vertex is kept inside a slightly shrunken copy of the proxies the planner
# returns to the scorer (v1/lib/evidence/photos.mjs occluderProxies). The kernel
# tessellates proxy ellipsoids (24x16) and cylinders (20 sides) inside the true
# surface by up to ~1.4 % of the radius, so the shrink factors below leave room.
import colorsys
import math
import random

import bpy
from mathutils import Vector

from e3d_common import MeshBuilder, bevel, mesh_object, yaw_matrix
import e3d_materials as mats

ELLIPSOID_SHRINK = 0.955
CYLINDER_SHRINK = 0.95


def _inside_ellipsoid(p, centre, radii, shrink=ELLIPSOID_SHRINK):
    return sum(((p[i] - centre[i]) / (radii[i] * shrink)) ** 2 for i in range(3)) <= 1.0


def _random_unit(rnd):
    while True:
        v = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1)))
        if 0.01 < v.length <= 1:
            return v.normalized()


def _card(centre, normal, size, rnd):
    """A square card around a model-space centre, facing roughly `normal`."""
    helper = Vector((0, 1, 0)) if abs(normal.y) < 0.9 else Vector((1, 0, 0))
    u = normal.cross(helper).normalized()
    v = normal.cross(u).normalized()
    spin = rnd.uniform(0, 2 * math.pi)
    u, v = u * math.cos(spin) + v * math.sin(spin), v * math.cos(spin) - u * math.sin(spin)
    h = size / 2
    c = Vector(centre)
    return [tuple(c + (-u - v) * h), tuple(c + (u - v) * h), tuple(c + (u + v) * h), tuple(c + (-u + v) * h)]


def _leaf_tint(rnd, hue, autumn):
    h = hue + rnd.uniform(-0.025, 0.025)
    s = rnd.uniform(0.55, 0.8)
    v = rnd.uniform(0.18, 0.36)
    r, g, b = colorsys.hsv_to_rgb(h, s, v)
    if autumn > 0 and rnd.random() < autumn:
        k = rnd.uniform(0.25, 0.7)
        r, g, b = r + (0.5 - r) * k, g + (0.42 - g) * k, b + (0.1 - b) * k
    return tuple(c ** 2.2 for c in (r, g, b))


def _crown(rnd, centre, radii, count, size_range, hue, autumn, flat_bottom=None):
    """Leaf cards filling an ellipsoid envelope: most in clumps (lumps and gaps
    like a real crown), the rest spread through the outer shell so the
    silhouette is full. Every card corner stays inside the shrunken envelope."""
    clumps = []
    for k in range(rnd.randint(8, 14)):
        d = _random_unit(rnd)
        d.y = abs(d.y) * 0.8 + 0.05
        clumps.append((Vector(centre) + Vector((d.x * radii[0], d.y * radii[1], d.z * radii[2])) * rnd.uniform(0.35, 0.75),
                       rnd.uniform(0.6, 1.25)))
    cards, colors = MeshBuilder(), []
    bottom = centre[1] - radii[1]
    placed = attempts = 0
    while placed < count and attempts < count * 6:
        attempts += 1
        # Mostly clumps, so the outline is lumpy with gaps instead of a clean
        # ellipse; a few cards in the shell keep the crown from looking hollow.
        if rnd.random() < 0.9:
            c, k = rnd.choice(clumps)
            spread = Vector((rnd.gauss(0, 0.3), rnd.gauss(0, 0.26), rnd.gauss(0, 0.3))) * k
            point = c + Vector((spread.x * radii[0], spread.y * radii[1], spread.z * radii[2]))
        else:
            d = _random_unit(rnd)
            point = Vector(centre) + Vector((d.x * radii[0], d.y * radii[1], d.z * radii[2])) * (rnd.random() ** 0.25)
        if point.y < bottom + 0.15 * radii[1] and rnd.random() < 0.7:
            continue
        if flat_bottom is not None and point.y < flat_bottom:
            continue
        outward = Vector(((point.x - centre[0]) / radii[0], (point.y - centre[1]) / radii[1], (point.z - centre[2]) / radii[2]))
        normal = (outward.normalized() * 0.6 + _random_unit(rnd)).normalized() if outward.length > 1e-3 else _random_unit(rnd)
        size = rnd.uniform(*size_range)
        corners = _card(point, normal, size, rnd)
        while size > size_range[0] * 0.35 and not all(_inside_ellipsoid(q, centre, radii) for q in corners):
            size *= 0.7
            corners = _card(point, normal, size, rnd)
        if not all(_inside_ellipsoid(q, centre, radii) for q in corners):
            continue
        cards.add(corners, [[0, 1, 2, 3]], uvs=[[(0, 0), (1, 0), (1, 1), (0, 1)]])
        colors.extend([_leaf_tint(rnd, hue, autumn)] * 4)
        placed += 1
    return cards, colors


def _limbs(wood, rnd, trunk_top, centre, radii, radius, count):
    """Limbs from the upper trunk into the crown. Both ends lie inside the
    (convex) crown ellipsoid, so the whole limb does."""
    x0, y0, z0 = trunk_top
    for k in range(count):
        t = rnd.uniform(0.15, 0.95)
        start = Vector((x0 + (centre[0] - x0) * t, y0 + (centre[1] - y0) * t, z0 + (centre[2] - z0) * t))
        if not _inside_ellipsoid(start, centre, radii, 0.9):
            continue
        direction = _random_unit(rnd)
        direction.y = abs(direction.y) * 0.8 + 0.2
        direction.normalize()
        end = Vector(centre) + Vector((direction.x * radii[0], direction.y * radii[1], direction.z * radii[2])) * rnd.uniform(0.45, 0.75)
        wood.tube(tuple(start), tuple(end), radius, 0.025, segments=6)


def broadleaf_tree(occ, collection, quality, autumn):
    p = occ['params']
    rnd = random.Random(p['seed'])
    x0, _, z0 = occ['position']
    rt, cy, radii = p['trunk_radius'], p['crown_centre_y'], p['crown_radii']
    centre = (x0 + p['crown_offset'][0], cy, z0 + p['crown_offset'][1])
    wood = MeshBuilder()
    # Straight while only the trunk proxy covers it, then leaning towards the
    # crown centre once it is inside the crown.
    straight_top = cy - radii[1] + 0.4
    wood.tube((x0, 0.0, z0), (x0, straight_top, z0), rt * 1.35, rt * 0.95, segments=12)
    wood.tube((x0, straight_top, z0), centre, rt * 0.95, rt * 0.55, segments=10)
    _limbs(wood, rnd, (x0, straight_top, z0), centre, radii, rt * 0.45, rnd.randint(5, 9))
    wood_obj = wood.build(occ['id'] + '.wood', collection, [mats.bark_material(p['seed'])], smooth=True)
    volume = radii[0] * radii[1] * radii[2] / (2.2 * 2.4 * 2.2)
    count = int((6000 if quality == 'final' else 2600) * max(0.5, min(volume, 2.2)))
    cards, colors = _crown(rnd, centre, radii, count, (0.26, 0.42), rnd.uniform(0.2, 0.29), autumn)
    leaf_obj = mesh_object(occ['id'] + '.leaves', cards.vertices, cards.faces, collection,
                           material=mats.foliage_material('leaves-' + occ['id']), uvs=cards.uvs, colors=colors)
    return [wood_obj, leaf_obj]


def conifer_tree(occ, collection, quality, autumn):
    """Whorls of drooping branches, each a few needle cards turned at random
    about the branch, inside a cone; the proxy is the enclosing cylinder."""
    p = occ['params']
    rnd = random.Random(p['seed'])
    x0, _, z0 = occ['position']
    base, top, radius = p['crown_base_y'], p['height'], p['crown_radius'] * CYLINDER_SHRINK
    wood = MeshBuilder()
    wood.tube((x0, 0.0, z0), (x0, top * 0.95, z0), p['trunk_radius'] * 1.3, 0.03, segments=10)
    wood_obj = wood.build(occ['id'] + '.wood', collection, [mats.bark_material(p['seed'])], smooth=True)
    cards, colors = MeshBuilder(), []
    hue = rnd.uniform(0.3, 0.38)
    y = base + 0.3
    step = 0.28 if quality == 'final' else 0.4
    per_branch = (5, 8) if quality == 'final' else (3, 5)

    def inside(q):
        return math.hypot(q[0] - x0, q[2] - z0) <= radius and base <= q[1] <= top

    while y < top - 0.15:
        reach = radius * (1 - (y - base) / (top - base)) ** 0.9
        for k in range(rnd.randint(7, 10)):
            angle = rnd.uniform(0, 2 * math.pi)
            length = reach * rnd.uniform(0.8, 1.0)
            direction = Vector((math.cos(angle), -0.35, math.sin(angle))).normalized()
            for j in range(rnd.randint(*per_branch)):
                t = rnd.uniform(0.1, 0.9)
                centre = Vector((x0, y, z0)) + direction * (length * t)
                normal = (direction.cross(Vector((0, 1, 0))).normalized() * rnd.uniform(-1, 1) + Vector((0, 1, 0))).normalized()
                size = rnd.uniform(0.35, 0.55) * (0.6 + 0.4 * (1 - (y - base) / (top - base)))
                corners = _card(centre, normal, size, rnd)
                while size > 0.12 and not all(inside(q) for q in corners):
                    size *= 0.75
                    corners = _card(centre, normal, size, rnd)
                if not all(inside(q) for q in corners):
                    continue
                cards.add(corners, [[0, 1, 2, 3]], uvs=[[(0, 0), (1, 0), (1, 1), (0, 1)]])
                colors.extend([tuple(c * 0.7 for c in _leaf_tint(rnd, hue, 0.0))] * 4)
        y += step * rnd.uniform(0.8, 1.2)
    needle_obj = mesh_object(occ['id'] + '.needles', cards.vertices, cards.faces, collection,
                             material=mats.foliage_material('needles-' + occ['id'], needles=True), uvs=cards.uvs, colors=colors)
    return [wood_obj, needle_obj]


# ---------------------------------------------------------------------------
# Vehicles: built in a local frame (length along +x, up +y, width along z, all
# model-space axes) and placed with the planner's yaw. Everything stays inside
# [-L/2, L/2] x [0, H] x [-(W/2 + 0.12), W/2 + 0.12]; the proxy box is larger.

PAINT, GLASS, TYRE, RIM, TRIM, LAMP, TAIL = range(7)


def _clip(polygon, keep):
    """Sutherland-Hodgman clip of a 2-D polygon by a half-plane: keep(p) >= 0."""
    out = []
    for i, a in enumerate(polygon):
        b = polygon[(i + 1) % len(polygon)]
        da, db = keep(a), keep(b)
        if da >= 0:
            out.append(a)
        if (da >= 0) != (db >= 0):
            t = da / (da - db)
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def _arch_profile(length, bottom, wheels, wheel_radius, lower):
    """Lower-body side profile with wheel arches cut into the bottom edge, and a
    material slot per profile edge: paint over the top, dark trim for the
    chamfers, sills and arch liners."""
    arch = wheel_radius + 0.05
    bottom_edge = [(length / 2 - 0.08, bottom)]
    for xw in sorted(wheels, reverse=True):
        dx = math.sqrt(max(arch ** 2 - (bottom - wheel_radius) ** 2, 0.0))
        start = math.atan2(bottom - wheel_radius, dx)
        bottom_edge.append((xw + dx, bottom))
        for k in range(1, 12):
            a = start + (math.pi - 2 * start) * k / 12
            bottom_edge.append((xw + math.cos(a) * arch, wheel_radius + math.sin(a) * arch))
        bottom_edge.append((xw - dx, bottom))
    bottom_edge.append((-length / 2 + 0.08, bottom))
    # `lower` runs rear-bottom, over the top, to front-bottom; the bottom edge
    # then runs back from the front to the rear.
    return list(lower) + bottom_edge, [PAINT] * (len(lower) - 1) + [TRIM] * (len(bottom_edge) + 1)


def _taper(points, half_length, half_width, amount=0.07):
    """Narrows the body towards both ends in plan view and rounds its shoulders."""
    out = []
    for x, y, z in points:
        k = 1 - amount * (abs(x) / half_length) ** 3
        out.append((x, y, z * k))
    return out


def vehicle(occ, collection, quality):
    p = occ['params']
    form, L, W, H = p['form'], p['length'], p['width'], p['height']
    s = L / 4.5
    wheel_r = {'sedan': 0.31, 'hatchback': 0.3, 'suv': 0.36, 'van': 0.33}[form]
    front_axle, rear_axle = L / 2 - 0.85 * s, -L / 2 + (0.95 if form != 'van' else 0.8) * s
    bottom = 0.2 if form != 'suv' else 0.26
    if form == 'sedan':
        belt, nose = 0.64 * H, 0.42 * H
        lower = [(-L / 2, bottom + 0.12), (-L / 2, 0.56 * H), (-L / 2 + 0.12, belt), (L / 2 - 1.15 * s, belt + 0.03), (L / 2 - 0.15, 0.5 * H), (L / 2, nose), (L / 2, bottom + 0.12)]
        cabin = [(-L / 2 + 0.5 * s, belt - 0.05), (-L / 2 + 0.5 * s, belt), (-L / 2 + 1.2 * s, H), (L / 2 - 1.95 * s, H), (L / 2 - 1.15 * s, belt + 0.03), (L / 2 - 1.15 * s, belt - 0.05)]
    elif form == 'hatchback':
        belt, nose = 0.62 * H, 0.42 * H
        lower = [(-L / 2, bottom + 0.12), (-L / 2, belt - 0.02), (-L / 2 + 0.06, belt), (L / 2 - 1.05 * s, belt + 0.03), (L / 2 - 0.15, 0.5 * H), (L / 2, nose), (L / 2, bottom + 0.12)]
        cabin = [(-L / 2 + 0.08, belt - 0.05), (-L / 2 + 0.1, belt), (-L / 2 + 0.38 * s, H), (L / 2 - 1.85 * s, H), (L / 2 - 1.05 * s, belt + 0.03), (L / 2 - 1.05 * s, belt - 0.05)]
    elif form == 'suv':
        belt, nose = 0.6 * H, 0.47 * H
        lower = [(-L / 2, bottom + 0.12), (-L / 2, belt - 0.02), (-L / 2 + 0.06, belt), (L / 2 - 1.0 * s, belt + 0.02), (L / 2 - 0.12, 0.54 * H), (L / 2, nose), (L / 2, bottom + 0.12)]
        cabin = [(-L / 2 + 0.08, belt - 0.05), (-L / 2 + 0.1, belt), (-L / 2 + 0.25 * s, H), (L / 2 - 1.55 * s, H), (L / 2 - 1.0 * s, belt + 0.02), (L / 2 - 1.0 * s, belt - 0.05)]
    else:  # van
        belt, nose = 0.5 * H, 0.42 * H
        lower = [(-L / 2, bottom + 0.12), (-L / 2, belt - 0.02), (-L / 2 + 0.04, belt), (L / 2 - 0.55, belt + 0.04), (L / 2 - 0.1, 0.46 * H), (L / 2, nose), (L / 2, bottom + 0.12)]
        cabin = [(-L / 2 + 0.04, belt - 0.05), (-L / 2 + 0.04, belt), (-L / 2 + 0.07, H), (L / 2 - 1.0, H), (L / 2 - 0.55, belt + 0.04), (L / 2 - 0.55, belt - 0.05)]
    materials = [mats.paint_material(p['paint'], p['metallic'], p['seed']),
                 mats.plain_material('car-glass', (0.04, 0.05, 0.06), roughness=0.03, Specular_IOR_Level=0.8),
                 mats.weathered_material('tyre', (0.05, 0.05, 0.05), roughness=0.85, bump=0.1, seed=p['seed']),
                 mats.plain_material('rim', (0.62, 0.63, 0.65), roughness=0.3, metallic=1.0),
                 mats.plain_material('trim', (0.035, 0.035, 0.035), roughness=0.55),
                 mats.plain_material('headlamp', (0.75, 0.77, 0.8), roughness=0.06, Specular_IOR_Level=0.8),
                 mats.plain_material('taillamp', (0.5, 0.03, 0.03), roughness=0.12)]
    half = W / 2
    body = MeshBuilder()
    profile, edge_slots = _arch_profile(L, bottom, (front_axle, rear_axle), wheel_r, lower)
    start = len(body.vertices)
    body.prism(profile, -half, half, slot=PAINT, edge_slots=edge_slots)
    # Glasshouse: a painted shell (pillars, roof) narrower than the body, with
    # glass panes laid on its faces, inset so the frame shows around them.
    inset = 0.11 if form != 'van' else 0.06
    body.prism(cabin, -half + inset, half - inset, slot=PAINT)
    body.vertices[start:] = _taper(body.vertices[start:], L / 2, half)
    cabin_half = half - inset
    taper_at = lambda x: 1 - 0.07 * (abs(x) / (L / 2)) ** 3
    frame = 0.06
    glass_top = H - 0.07
    side_glass = _clip(_clip(cabin, lambda q: glass_top - q[1]), lambda q: q[1] - belt - 0.03)
    # Shrink the pane about its centroid so a frame of about `frame` metres shows.
    cx = sum(q[0] for q in side_glass) / len(side_glass)
    cy = sum(q[1] for q in side_glass) / len(side_glass)
    span_x = max(q[0] for q in side_glass) - min(q[0] for q in side_glass)
    span_y = max(q[1] for q in side_glass) - min(q[1] for q in side_glass)
    kx, ky = 1 - 2 * frame / span_x, 1 - 2 * frame / span_y
    pane = [(cx + (q[0] - cx) * kx, cy + (q[1] - cy) * ky) for q in side_glass]
    pillar = (cabin[2][0] + cabin[3][0]) / 2 if form != 'van' else L / 2 - 1.5
    panes = [_clip(pane, lambda q: pillar - 0.05 - q[0]), _clip(pane, lambda q: q[0] - pillar - 0.05)] if form != 'van' else [_clip(pane, lambda q: q[0] - pillar)]
    for side in (-1, 1):
        for poly in panes:
            if len(poly) < 3:
                continue
            verts = [(x, y, side * (cabin_half * taper_at(x) + 0.004)) for x, y in poly]
            body.add(verts, [list(range(len(verts))) if side > 0 else list(reversed(range(len(verts))))], slot=GLASS)
    # Windscreen and rear window: panes on the sloped cabin faces.
    for a, b in ((cabin[3], cabin[4]), (cabin[1], cabin[2])):
        ax, ay = a
        bx, by = b
        nx, ny = (by - ay), -(bx - ax)
        length = math.hypot(nx, ny)
        nx, ny = nx / length, ny / length
        if (nx * ((ax + bx) / 2 - cx) + ny * ((ay + by) / 2 - cy)) < 0:
            nx, ny = -nx, -ny
        quad = []
        for t, zs in ((0.08, -1), (0.92, -1), (0.92, 1), (0.08, 1)):
            x, y = ax + (bx - ax) * t + nx * 0.004, ay + (by - ay) * t + ny * 0.004
            quad.append((x, y, zs * (cabin_half * taper_at(x) - frame)))
        body.add(quad, [[0, 1, 2, 3]], slot=GLASS)
    # Lamps, grille, bumpers, mirrors (mirrors reach 0.12 m past the body; the proxy allows 0.17).
    for side in (-1, 1):
        body.box((L / 2 - 0.016, nose - 0.07, side * (half - 0.3) * taper_at(L / 2)), (0.03, 0.08, 0.3), slot=LAMP)
        body.box((-L / 2 + 0.016, 0.52 * H, side * (half - 0.22) * taper_at(L / 2)), (0.03, 0.09, 0.24), slot=TAIL)
        mirror_x = (cabin[4][0] if form != 'van' else L / 2 - 0.6) - 0.05
        body.box((mirror_x, belt + 0.07, side * (half + 0.05)), (0.13, 0.09, 0.12), slot=PAINT)
    body.box((L / 2 - 0.012, nose - 0.2, 0), (0.03, 0.11, W - 1.0), slot=TRIM)
    body.box((L / 2 - 0.03, bottom + 0.1, 0), (0.06, 0.13, (W - 0.12) * taper_at(L / 2)), slot=TRIM)
    body.box((-L / 2 + 0.03, bottom + 0.1, 0), (0.06, 0.13, (W - 0.12) * taper_at(L / 2)), slot=TRIM)
    # Wheels: tyre, then a rim disc proud of the tyre by a few millimetres.
    for xw in (front_axle, rear_axle):
        for side in (-1, 1):
            zc = side * (half * taper_at(xw) - 0.16)
            body.tube((xw, wheel_r, zc - 0.105), (xw, wheel_r, zc + 0.105), wheel_r, wheel_r, segments=24, slot=TYRE)
            body.tube((xw, wheel_r, zc + side * 0.1), (xw, wheel_r, zc + side * 0.112), wheel_r * 0.62, wheel_r * 0.62, segments=24, slot=RIM)
    obj = body.build(occ['id'], collection, materials, smooth=False)
    obj.matrix_world = yaw_matrix(occ['position'], occ['yaw'])
    bevel(obj, 0.05, segments=3, angle_deg=35)
    return [obj]


# ---------------------------------------------------------------------------
# Poles

def pole(occ, collection, quality):
    p = occ['params']
    H = p['height']
    parts = MeshBuilder()
    if p['form'] == 'lamp':
        material = mats.weathered_material('lamp-pole', (0.45, 0.47, 0.48), roughness=0.45, metallic=0.85, bump=0.05, seed=p['seed'])
        parts.tube((0, 0, 0), (0, 0.45, 0), 0.16, 0.13, segments=16)
        parts.tube((0, 0.45, 0), (0, H, 0), 0.11, 0.065, segments=16)
        parts.tube((0, H - 0.3, 0), (p['arm_length'], H - 0.1, 0), 0.045, 0.04, segments=10)
        parts.box((p['arm_length'] + 0.05, H - 0.12, 0), (0.6, 0.13, 0.27))
        parts.box((p['arm_length'] + 0.05, H - 0.19, 0), (0.48, 0.02, 0.2), slot=1)
        lens = mats.plain_material('lamp-lens', (0.85, 0.85, 0.82), roughness=0.2)
        obj = parts.build(occ['id'], collection, [material, lens], smooth=True)
    else:
        wood = mats.weathered_material('pole-wood', (0.36, 0.3, 0.24), roughness=0.85, bump=0.4, seed=p['seed'])
        parts.tube((0, 0, 0), (0, H, 0), 0.15, 0.11, segments=14)
        parts.box((0, H - 0.5, 0), (0.1, 0.1, p['arm_length']))
        porcelain = mats.plain_material('insulator', (0.75, 0.74, 0.7), roughness=0.25)
        for k in (-0.4, 0.0, 0.4):
            parts.tube((0, H - 0.45, k * p['arm_length']), (0, H - 0.3, k * p['arm_length']), 0.04, 0.03, segments=10, slot=1)
        obj = parts.build(occ['id'], collection, [wood, porcelain], smooth=True)
    obj.matrix_world = yaw_matrix(occ['position'], occ['yaw'])
    return [obj]


def build_occluder(occ, collection, quality, autumn):
    if occ['kind'] == 'tree':
        builder = broadleaf_tree if occ['params']['form'] == 'broadleaf' else conifer_tree
        return builder(occ, collection, quality, autumn)
    if occ['kind'] == 'vehicle':
        return vehicle(occ, collection, quality)
    return pole(occ, collection, quality)


# ---------------------------------------------------------------------------
# Backdrop: a few template trees and shrubs made of leaf cards like the
# occluder trees, instanced (linked meshes) around the site.

def backdrop(plan, collection, quality, seed):
    items = plan['trees'] if quality == 'final' else plan['trees'][::2]
    bark = mats.bark_material(seed)
    foliage = mats.foliage_material('backdrop-leaves', haze=True)
    templates = []
    for variant in range(4):
        rnd = random.Random(seed * 31 + variant)
        shrub = variant == 3
        wood = MeshBuilder()
        if shrub:
            radii = (rnd.uniform(1.2, 1.8), rnd.uniform(0.8, 1.1), rnd.uniform(1.0, 1.5))
            centre = (0.0, radii[1] * 0.85, 0.0)
        else:
            radii = (rnd.uniform(2.2, 3.2), rnd.uniform(2.4, 3.4), rnd.uniform(2.2, 3.2))
            centre = (rnd.uniform(-0.3, 0.3), rnd.uniform(2.0, 3.0) + radii[1], rnd.uniform(-0.3, 0.3))
            top = (0.0, centre[1] - radii[1] + 0.4, 0.0)
            wood.tube((0, 0, 0), top, 0.22, 0.17, segments=8)
            wood.tube(top, centre, 0.17, 0.1, segments=8)
            _limbs(wood, rnd, top, centre, radii, 0.08, 5)
        count = (1700 if quality == 'final' else 900) if not shrub else (500 if quality == 'final' else 250)
        cards, colors = _crown(rnd, centre, radii, count, (0.5, 0.8), rnd.uniform(0.2, 0.3), 0.0,
                               flat_bottom=0.05 if shrub else None)
        parts = []
        if wood.faces:
            parts.append(wood.build('backdrop-wood-%d' % variant, collection, [bark], smooth=True))
        parts.append(mesh_object('backdrop-leaves-%d' % variant, cards.vertices, cards.faces, collection,
                                 material=foliage, uvs=cards.uvs, colors=[tuple(c * 0.85 for c in col) for col in colors]))
        for part in parts:
            part.hide_render = True
        templates.append(parts)
    instances = []
    for k, item in enumerate(items):
        for template in templates[3 if item.get('shrub') else item['variant'] % 3]:
            obj = bpy.data.objects.new('backdrop-%d-%s' % (k, template.name), template.data)
            collection.objects.link(obj)
            obj.matrix_world = yaw_matrix(item['position'], item['yaw'])
            obj.scale = (item['scale'],) * 3
            instances.append(obj)
    return instances
