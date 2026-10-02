# Procedural materials. The imported object has no UVs, so building and ground
# textures are driven by world position (consistent scale across parts) and the
# surface normal. The model's solid colour stays the mean colour: variation is
# multiplicative around 1 so the photographed colour is still the true one.
import math
import random

import bpy

from e3d_common import Graph, new_material, principled, scale_color, srgb_to_linear, world_position


def _vary(graph, base, position, large=0.08, small=0.04, large_scale=0.35, small_scale=9.0, seed=0.0):
    """Base colour times a slowly varying factor near 1 (weathering, patching)."""
    big = graph.noise(position, large_scale, detail=3, roughness=0.5, w=seed)
    fine = graph.noise(position, small_scale, detail=4, roughness=0.6, w=seed + 3.1)
    k = graph.math('ADD', graph.math('MULTIPLY', graph.math('SUBTRACT', big, 0.5), 2 * large),
                   graph.math('MULTIPLY', graph.math('SUBTRACT', fine, 0.5), 2 * small))
    k = graph.math('ADD', k, 1.0)
    return graph.mix(1.0, base, graph.combine(k, k, k), blend='MULTIPLY')


def _grime(graph, color, position, height=0.7, amount=0.18, seed=0.0):
    """Darker, slightly warmer band at the foot of walls (splash-back and dirt)."""
    z = graph.separate(position)[2]
    band = graph.map_range(z, 0.0, height, 1.0, 0.0, interpolation='SMOOTHSTEP')
    patchy = graph.noise(position, 1.6, detail=3, w=seed + 7.0)
    fac = graph.math('MULTIPLY', band, graph.map_range(patchy, 0.3, 0.7, amount * 0.4, amount))
    return graph.mix(fac, color, (0.08, 0.07, 0.055))


def _triplanar_brick(graph, position, normal, brick_w=0.23, row_h=0.075, mortar=0.012):
    """Running-bond brick on vertical faces in world space, picking the
    projection plane by the dominant horizontal normal component."""
    x, y, z = graph.separate(position)
    nx, ny, nz = graph.separate(normal)
    facing_x = graph.math('GREATER_THAN', graph.math('ABSOLUTE', nx), graph.math('ABSOLUTE', ny))
    u = graph.mixf(facing_x, x, y)
    vector = graph.combine(u, z, 0.0)
    brick = graph.node('ShaderNodeTexBrick', offset=0.5, offset_frequency=2, squash=1.0, squash_frequency=2,
                       inputs={'Vector': vector, 'Color1': (0.85, 0.85, 0.85), 'Color2': (1.15, 1.15, 1.15),
                               'Mortar': (0.0, 0.0, 0.0), 'Scale': 1.0, 'Mortar Size': mortar, 'Mortar Smooth': 0.2,
                               'Bias': 0.0, 'Brick Width': brick_w, 'Row Height': row_h})
    return brick.outputs['Color'], brick.outputs['Fac']


def building_material(key, spec, seed):
    """One Blender material per model material key, styled by its kind."""
    kind = spec['kind']
    base = srgb_to_linear(spec['color'])
    roughness = float(spec.get('roughness', 0.8))
    metalness = float(spec.get('metalness', 0.0))
    material, g, output = new_material('obj-' + key)
    p = world_position(g)
    geometry = g.node('ShaderNodeNewGeometry')
    normal = geometry.outputs['Normal']
    w = (seed % 997) * 0.37
    if kind == 'glass':
        # Opaque, dark, mirror-like: windows read through their reflections.
        interior = g.noise(p, 0.9, detail=2, w=w)
        tone = g.map_range(interior, 0.35, 0.75, 0.8, 1.35)
        color = g.mix(1.0, base, g.combine(tone, tone, tone), blend='MULTIPLY')
        shader = principled(g, color, roughness=min(roughness, 0.06), IOR=1.52, Specular_IOR_Level=0.6)
    elif kind == 'roof':
        nz = g.separate(normal)[2]
        slope = g.math('SQRT', g.math('MAXIMUM', g.math('SUBTRACT', 1.0, g.math('MULTIPLY', nz, nz)), 0.0004))
        x, y, z = g.separate(p)
        course = g.math('DIVIDE', z, g.math('MULTIPLY', 0.27, g.math('MAXIMUM', slope, 0.12)))
        row = g.math('FLOOR', course)
        along = g.math('ADD', g.math('DIVIDE', g.math('ADD', x, y), 0.24), g.math('MULTIPLY', row, 0.5))
        groove_row = g.map_range(g.math('FRACT', course), 0.0, 0.14, 0.0, 1.0, interpolation='SMOOTHSTEP')
        groove_col = g.map_range(g.math('PINGPONG', g.math('FRACT', along), 0.5), 0.0, 0.05, 0.0, 1.0)
        flat = g.map_range(slope, 0.1, 0.25, 1.0, 0.0)
        groove = g.mixf(flat, g.math('MINIMUM', groove_row, g.mixf(0.6, 1.0, groove_col)), 1.0)
        per_row = g.noise(g.combine(row, g.math('FLOOR', along), w), 7.3, detail=0)
        tile_tone = g.math('ADD', 0.88, g.math('MULTIPLY', per_row, 0.24))
        tone = g.math('MULTIPLY', tile_tone, g.math('ADD', 0.55, g.math('MULTIPLY', groove, 0.45)))
        color = g.mix(1.0, base, g.combine(tone, tone, tone), blend='MULTIPLY')
        color = _vary(g, color, p, large=0.1, small=0.05, seed=w)
        moss = g.map_range(g.noise(p, 0.6, detail=4, w=w + 2), 0.55, 0.75, 0.0, 0.25)
        color = g.mix(moss, color, scale_color(base, 0.55))
        # Nearly no specular: seen from the street a roof is at ~75 degrees
        # incidence, where even rough default specular glints the sun and sky
        # into a white sheet and the roof colour is lost.
        shader = principled(g, color, roughness=max(roughness, 0.9), normal=g.bump(groove, 0.35, 0.02), Specular_IOR_Level=0.05)
    elif 'brick' in key.lower():
        brick_color, mortar = _triplanar_brick(g, p, normal)
        color = g.mix(1.0, base, brick_color, blend='MULTIPLY')
        color = g.mix(g.math('SUBTRACT', 1.0, mortar), (0.42, 0.40, 0.37), color)
        color = _vary(g, color, p, large=0.07, small=0.08, small_scale=14, seed=w)
        shader = principled(g, _grime(g, color, p, seed=w), roughness=roughness, normal=g.bump(mortar, 0.4, 0.01))
    elif kind in ('wall', 'concrete', 'stone'):
        color = _vary(g, base, p, large=0.07 if kind == 'wall' else 0.1, small=0.03 if kind == 'wall' else 0.06,
                      small_scale=14 if kind == 'wall' else 6, seed=w)
        if kind == 'stone':
            cells = g.voronoi(p, 3.5, feature='DISTANCE_TO_EDGE')
            joint = g.map_range(cells.outputs['Distance'], 0.0, 0.04, 0.75, 1.0)
            color = g.mix(1.0, color, g.combine(joint, joint, joint), blend='MULTIPLY')
        color = _grime(g, color, p, amount=0.14 if kind == 'wall' else 0.2, seed=w)
        stucco = g.noise(p, 22.0, detail=6, roughness=0.7, w=w + 1.3)
        shader = principled(g, color, roughness=roughness, normal=g.bump(stucco, 0.18 if kind == 'wall' else 0.3, 0.01), Specular_IOR_Level=0.3)
    elif kind == 'wood':
        x, y, z = g.separate(p)
        grain = g.noise(g.combine(g.math('MULTIPLY', x, 4.0), g.math('MULTIPLY', y, 4.0), g.math('MULTIPLY', z, 0.25)), 6.0, detail=5, w=w)
        color = _vary(g, base, p, large=0.04, small=0.03, seed=w)
        shader = principled(g, color, roughness=min(roughness, 0.6), normal=g.bump(grain, 0.08, 0.005))
    elif kind == 'metal':
        streak = g.noise(p, 4.0, detail=5, w=w)
        shader = principled(g, _vary(g, base, p, large=0.05, small=0.05, seed=w), metallic=max(metalness, 0.6),
                            roughness=g.map_range(streak, 0.3, 0.7, max(roughness - 0.1, 0.15), roughness + 0.12))
    else:  # frame, sign: painted, smooth
        color = _vary(g, base, p, large=0.03, small=0.02, seed=w)
        shader = principled(g, color, roughness=min(roughness, 0.5), metallic=metalness)
    g.set(output.inputs['Surface'], shader)
    return material


# ---------------------------------------------------------------------------
# Aerial perspective. Distant surfaces fade towards the horizon colour of the
# sky; without it the ground meets the sky at a hard, synthetic line. The
# colour is filled in after the sky has been measured (see set_haze).

HAZE_NODES = []


def hazed(g, shader, distance_scale=1.0):
    depth = g.node('ShaderNodeCameraData').outputs['View Distance']
    reach = g.node('ShaderNodeValue', label='haze-reach')
    reach.outputs[0].default_value = 2500.0
    fac = g.math('SUBTRACT', 1.0, g.math('EXPONENT', g.math('DIVIDE', g.math('MULTIPLY', depth, -distance_scale), reach.outputs[0])))
    colour = g.node('ShaderNodeRGB', label='haze-colour')
    colour.outputs[0].default_value = (0.5, 0.55, 0.6, 1.0)
    emission = g.node('ShaderNodeEmission', inputs={'Color': colour.outputs[0], 'Strength': 1.0}).outputs[0]
    HAZE_NODES.append((reach, colour))
    return g.node('ShaderNodeMixShader', inputs={0: fac, 1: shader, 2: emission}).outputs[0]


def set_haze(colour, reach):
    for reach_node, colour_node in HAZE_NODES:
        reach_node.outputs[0].default_value = reach
        colour_node.outputs[0].default_value = (colour[0], colour[1], colour[2], 1.0)


# ---------------------------------------------------------------------------
# Ground

def ground_material(kind, seed, road=None):
    material, g, output = new_material('ground-' + kind)
    p = world_position(g)
    x, y, z = g.separate(p)
    w = (seed % 991) * 0.29
    if kind == 'grass':
        # Lawn: patchy dry and lush areas at several scales, clover-dark
        # clumps, and fine blade noise; a flat green reads as a golf course.
        n1 = g.noise(p, 0.12, detail=4, w=w)
        n2 = g.noise(p, 0.9, detail=6, roughness=0.65, w=w + 1)
        n3 = g.noise(p, 4.0, detail=4, w=w + 3)
        blades = g.noise(p, 70.0, detail=2, w=w + 2)
        lush, dry, dark = srgb_to_linear((0.31, 0.41, 0.17)), srgb_to_linear((0.52, 0.5, 0.3)), srgb_to_linear((0.19, 0.27, 0.1))
        color = g.mix(g.map_range(n1, 0.35, 0.7, 0.05, 0.8), lush, dry)
        color = g.mix(g.map_range(n2, 0.42, 0.68, 0.0, 0.7), color, dark)
        color = g.mix(g.map_range(n3, 0.55, 0.75, 0.0, 0.35), color, srgb_to_linear((0.45, 0.43, 0.3)))
        tone = g.map_range(blades, 0.25, 0.75, 0.72, 1.22)
        color = g.mix(1.0, color, g.combine(tone, tone, tone), blend='MULTIPLY')
        shader = principled(g, color, roughness=0.95, normal=g.bump(g.math('ADD', blades, g.math('MULTIPLY', n3, 0.5)), 0.7, 0.03),
                            Specular_IOR_Level=0.2)
    elif kind in ('paving', 'pavers', 'concrete'):
        size = {'paving': (0.6, 0.6), 'pavers': (0.2, 0.1), 'concrete': (1.5, 1.5)}[kind]
        tint = {'paving': (0.52, 0.50, 0.46), 'pavers': (0.48, 0.44, 0.40), 'concrete': (0.58, 0.57, 0.54)}[kind]
        brick = g.node('ShaderNodeTexBrick', offset=0.5 if kind == 'pavers' else 0.0, offset_frequency=2,
                       inputs={'Vector': g.combine(x, y, 0.0), 'Color1': (0.92, 0.92, 0.92), 'Color2': (1.06, 1.06, 1.06),
                               'Mortar': (0.0, 0.0, 0.0), 'Scale': 1.0, 'Mortar Size': 0.006 if kind != 'paving' else 0.008,
                               'Mortar Smooth': 0.3, 'Bias': 0.0, 'Brick Width': size[0], 'Row Height': size[1]})
        base = srgb_to_linear(tint)
        color = g.mix(1.0, base, brick.outputs['Color'], blend='MULTIPLY')
        color = g.mix(g.math('SUBTRACT', 1.0, brick.outputs['Fac']), scale_color(base, 0.55), color)
        color = _vary(g, color, p, large=0.1, small=0.06, large_scale=0.25, small_scale=4.0, seed=w)
        stains = g.map_range(g.noise(p, 0.7, detail=4, w=w + 4), 0.55, 0.8, 0.0, 0.3)
        color = g.mix(stains, color, scale_color(base, 0.6))
        shader = principled(g, color, roughness=0.88, normal=g.bump(brick.outputs['Fac'], 0.5, 0.01))
    elif kind == 'gravel':
        cells = g.voronoi(p, 70.0)
        stones = cells.outputs['Color']
        base = srgb_to_linear((0.52, 0.49, 0.44))
        tone = g.map_range(g.separate(stones)[0], 0.0, 1.0, 0.7, 1.25)
        color = g.mix(1.0, base, g.combine(tone, tone, tone), blend='MULTIPLY')
        color = _vary(g, color, p, large=0.08, small=0.0, seed=w)
        shader = principled(g, color, roughness=0.9, normal=g.bump(cells.outputs['Distance'], 0.7, 0.01))
    else:  # asphalt, with optional road markings
        base = srgb_to_linear((0.17, 0.17, 0.17))
        grain = g.noise(p, 90.0, detail=2, w=w)
        tone = g.math('ADD', 0.85, g.math('MULTIPLY', grain, 0.3))
        color = g.mix(1.0, base, g.combine(tone, tone, tone), blend='MULTIPLY')
        color = _vary(g, color, p, large=0.14, small=0.05, large_scale=0.08, small_scale=1.5, seed=w)
        patch = g.map_range(g.noise(p, 0.15, detail=2, w=w + 5), 0.62, 0.66, 0.0, 1.0)
        color = g.mix(g.math('MULTIPLY', patch, 0.5), color, scale_color(base, 0.7))
        if road and road.get('centre_line'):
            # Model z of the centre line is Blender -y.
            centre = (road['z0'] + road['z1']) / 2
            offset = g.math('ABSOLUTE', g.math('ADD', y, centre))
            line = g.math('LESS_THAN', offset, 0.06)
            dashes = g.math('LESS_THAN', g.math('FRACT', g.math('DIVIDE', x, 6.0)), 0.5)
            paint = g.math('MULTIPLY', g.math('MULTIPLY', line, dashes), g.map_range(grain, 0.2, 0.5, 0.6, 1.0))
            color = g.mix(paint, color, srgb_to_linear((0.78, 0.78, 0.74)))
        shader = principled(g, color, roughness=0.9, normal=g.bump(grain, 0.35, 0.005))
    g.set(output.inputs['Surface'], hazed(g, shader))
    return material


# ---------------------------------------------------------------------------
# Props

def bark_material(seed):
    material, g, output = new_material('bark-%d' % seed)
    p = world_position(g)
    x, y, z = g.separate(p)
    stretched = g.combine(g.math('MULTIPLY', x, 6), g.math('MULTIPLY', y, 6), g.math('MULTIPLY', z, 0.8))
    ridges = g.noise(stretched, 5.0, detail=6, w=seed * 0.1)
    base = srgb_to_linear((0.24, 0.21, 0.18))
    tone = g.map_range(ridges, 0.3, 0.7, 0.6, 1.25)
    color = g.mix(1.0, base, g.combine(tone, tone, tone), blend='MULTIPLY')
    g.set(output.inputs['Surface'], principled(g, color, roughness=0.9, normal=g.bump(ridges, 0.8, 0.03)))
    return material


def foliage_material(name, needles=False, haze=False):
    """Leaf cards. Each Voronoi cell of the card's UV square holds one leaf: an
    ellipse (long and thin for needles) at a random angle, so cards never show
    a grid of identical discs. Alpha cuts the leaves out; the per-card 'tint'
    colour attribute and a per-leaf tone give variation; translucency lets
    backlit leaves glow instead of turning into black cut-outs."""
    material, g, output = new_material(name)
    uv = g.node('ShaderNodeTexCoord').outputs['UV']
    tint = g.node('ShaderNodeVertexColor', layer_name='tint').outputs['Color']
    scale = 9.0 if needles else 8.5
    cells = g.voronoi(uv, scale, dimensions='2D')
    rand = g.separate(cells.outputs['Color'])
    # Voronoi 'Position' is in input (UV) units; measure the offset in cells.
    offset = g.vmath('SCALE', g.vmath('SUBTRACT', uv, cells.outputs['Position']), factor=scale)
    ox, oy, _ = g.separate(offset)
    angle = g.math('MULTIPLY', rand[0], 6.2832)
    cos_a, sin_a = g.math('COSINE', angle), g.math('SINE', angle)
    along = g.math('ADD', g.math('MULTIPLY', ox, cos_a), g.math('MULTIPLY', oy, sin_a))
    across = g.math('SUBTRACT', g.math('MULTIPLY', oy, cos_a), g.math('MULTIPLY', ox, sin_a))
    size = g.math('ADD', 0.75, g.math('MULTIPLY', rand[1], 0.45))
    length, width = (0.75, 0.2) if needles else (0.5, 0.27)
    e = g.math('ADD', g.math('POWER', g.math('DIVIDE', along, g.math('MULTIPLY', size, length)), 2.0),
               g.math('POWER', g.math('DIVIDE', across, g.math('MULTIPLY', size, width)), 2.0))
    alpha = g.math('MULTIPLY', g.math('LESS_THAN', e, 1.0), g.math('GREATER_THAN', rand[2], 0.12))
    u, v, _ = g.separate(uv)
    border = g.math('MULTIPLY', g.map_range(g.math('ABSOLUTE', g.math('SUBTRACT', u, 0.5)), 0.45, 0.5, 1, 0),
                    g.map_range(g.math('ABSOLUTE', g.math('SUBTRACT', v, 0.5)), 0.45, 0.5, 1, 0))
    alpha = g.math('MULTIPLY', alpha, border)
    shade = g.math('MULTIPLY', g.map_range(rand[1], 0.0, 1.0, 0.72, 1.18), g.map_range(e, 0.0, 1.0, 1.08, 0.82))
    color = g.mix(1.0, tint, g.combine(shade, shade, shade), blend='MULTIPLY')
    leaf = principled(g, color, roughness=0.55, Specular_IOR_Level=0.35)
    translucent = g.node('ShaderNodeBsdfTranslucent', inputs={'Color': g.mix(1.0, color, (1.6, 1.8, 0.9), blend='MULTIPLY')}).outputs[0]
    body = g.node('ShaderNodeMixShader', inputs={0: 0.35, 1: leaf, 2: translucent}).outputs[0]
    clear = g.node('ShaderNodeBsdfTransparent').outputs[0]
    final = g.node('ShaderNodeMixShader', inputs={0: alpha, 1: clear, 2: hazed(g, body) if haze else body}).outputs[0]
    g.set(output.inputs['Surface'], final)
    material.surface_render_method = 'DITHERED'
    return material


def backdrop_foliage_material():
    material, g, output = new_material('backdrop-foliage')
    p = world_position(g)
    tint = g.node('ShaderNodeVertexColor', layer_name='tint').outputs['Color']
    cells = g.voronoi(p, 6.0)
    clumps = g.noise(p, 1.3, detail=5)
    tone = g.math('MULTIPLY', g.map_range(cells.outputs['Distance'], 0.0, 0.6, 1.15, 0.65), g.map_range(clumps, 0.3, 0.7, 0.75, 1.15))
    color = g.mix(1.0, tint, g.combine(tone, tone, tone), blend='MULTIPLY')
    normal = g.bump(g.math('ADD', cells.outputs['Distance'], clumps), 1.0, 0.25)
    g.set(output.inputs['Surface'], hazed(g, principled(g, color, roughness=0.8, normal=normal, Specular_IOR_Level=0.2)))
    return material


def paint_material(hex_color, metallic, seed):
    material, g, output = new_material('paint-%d' % seed)
    base = srgb_to_linear(hex_color)
    p = world_position(g)
    color = _vary(g, base, p, large=0.02, small=0.0, seed=seed * 0.01)
    shader = principled(g, color, roughness=0.32 if metallic else 0.28, metallic=0.55 if metallic else 0.0,
                        Coat_Weight=1.0, Coat_Roughness=0.04)
    g.set(output.inputs['Surface'], shader)
    return material


def plain_material(name, rgb, roughness=0.5, metallic=0.0, **extra):
    material, g, output = new_material(name)
    g.set(output.inputs['Surface'], principled(g, srgb_to_linear(rgb), roughness=roughness, metallic=metallic, **extra))
    return material


def weathered_material(name, rgb, roughness=0.7, metallic=0.0, bump=0.2, seed=0):
    material, g, output = new_material(name)
    p = world_position(g)
    color = _vary(g, srgb_to_linear(rgb), p, large=0.12, small=0.08, small_scale=12.0, seed=seed * 0.1)
    detail = g.noise(p, 30.0, detail=4, w=seed * 0.1 + 2)
    g.set(output.inputs['Surface'], principled(g, color, roughness=roughness, metallic=metallic, normal=g.bump(detail, bump, 0.01)))
    return material
