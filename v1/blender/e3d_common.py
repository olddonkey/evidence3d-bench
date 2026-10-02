# Shared helpers for the Evidence3D photo renderer (module B).
#
# Everything the Node planner sends is in MODEL space: metres, +Y up, front
# facing +Z. Blender is Z-up. The glTF importer maps model (x, y, z) to Blender
# (x, -z, y); every conversion in this package goes through to_blender() so the
# props, cameras and the imported object all agree.
import math

import bmesh
import bpy
from mathutils import Matrix, Vector


def to_blender(p):
    return Vector((p[0], -p[2], p[1]))


def yaw_matrix(position, yaw):
    """Model-space placement: rotation about model +Y by yaw (DESIGN section 3)
    is rotation about Blender +Z by the same angle, then a translation."""
    return Matrix.Translation(to_blender(position)) @ Matrix.Rotation(yaw, 4, 'Z')


def camera_matrix(camera):
    """Kernel camera (right, up, forward in model space) -> Blender world matrix.
    A Blender camera looks down its local -Z with local +Y up, so the columns
    are right, up and -forward."""
    right, up, forward = (to_blender(camera[k]) for k in ('right', 'up', 'forward'))
    rotation = Matrix((right, up, -forward)).transposed()
    return Matrix.Translation(to_blender(camera['position'])) @ rotation.to_4x4()


# ---------------------------------------------------------------------------
# Node graphs

class Graph:
    """Small builder for shader node trees; sockets are passed around directly."""

    def __init__(self, tree):
        self.tree = tree
        self.nodes = tree.nodes
        self.links = tree.links

    def node(self, kind, inputs=None, **props):
        node = self.nodes.new(kind)
        for key, value in props.items():
            setattr(node, key, value)
        for key, value in (inputs or {}).items():
            self.set(node.inputs[key], value)
        return node

    def set(self, socket, value):
        if hasattr(value, 'is_output') or hasattr(value, 'links'):
            self.links.new(value, socket)
        elif isinstance(value, (tuple, list)):
            socket.default_value = tuple(value) + ((1.0,) if len(value) == 3 and len(socket.default_value) == 4 else ())
        else:
            socket.default_value = value

    def math(self, operation, a, b=0.0, clamp=False):
        node = self.node('ShaderNodeMath', operation=operation, use_clamp=clamp)
        self.set(node.inputs[0], a)
        self.set(node.inputs[1], b)
        return node.outputs[0]

    def vmath(self, operation, a, b=(0, 0, 0), factor=None):
        node = self.node('ShaderNodeVectorMath', operation=operation)
        self.set(node.inputs[0], a)
        self.set(node.inputs[1], b)
        if factor is not None:
            node.inputs['Scale'].default_value = factor
        return node.outputs['Value' if operation in ('LENGTH', 'DOT_PRODUCT', 'DISTANCE') else 'Vector']

    @staticmethod
    def socket(sockets, identifier):
        # The Mix node has several sockets per name (one per data type); only
        # identifiers are unique.
        return next(s for s in sockets if s.identifier == identifier)

    def mix(self, factor, a, b, blend='MIX'):
        node = self.node('ShaderNodeMix', data_type='RGBA', blend_type=blend)
        self.set(self.socket(node.inputs, 'Factor_Float'), factor)
        self.set(self.socket(node.inputs, 'A_Color'), a)
        self.set(self.socket(node.inputs, 'B_Color'), b)
        return self.socket(node.outputs, 'Result_Color')

    def mixf(self, factor, a, b):
        node = self.node('ShaderNodeMix', data_type='FLOAT')
        self.set(self.socket(node.inputs, 'Factor_Float'), factor)
        self.set(self.socket(node.inputs, 'A_Float'), a)
        self.set(self.socket(node.inputs, 'B_Float'), b)
        return self.socket(node.outputs, 'Result_Float')

    def map_range(self, value, from_min, from_max, to_min=0.0, to_max=1.0, interpolation='LINEAR'):
        node = self.node('ShaderNodeMapRange', interpolation_type=interpolation, clamp=True)
        for name, v in (('Value', value), ('From Min', from_min), ('From Max', from_max), ('To Min', to_min), ('To Max', to_max)):
            self.set(node.inputs[name], v)
        return node.outputs['Result']

    def noise(self, vector, scale, detail=4.0, roughness=0.55, w=None, distortion=0.0):
        node = self.node('ShaderNodeTexNoise', noise_dimensions='4D' if w is not None else '3D')
        self.set(node.inputs['Vector'], vector)
        node.inputs['Scale'].default_value = scale
        node.inputs['Detail'].default_value = detail
        node.inputs['Roughness'].default_value = roughness
        node.inputs['Distortion'].default_value = distortion
        if w is not None:
            node.inputs['W'].default_value = w
        return node.outputs['Factor']

    def voronoi(self, vector, scale, feature='F1', randomness=1.0, dimensions='3D'):
        node = self.node('ShaderNodeTexVoronoi', feature=feature, voronoi_dimensions=dimensions)
        self.set(node.inputs['Vector'], vector)
        node.inputs['Scale'].default_value = scale
        node.inputs['Randomness'].default_value = randomness
        return node

    def separate(self, vector):
        node = self.node('ShaderNodeSeparateXYZ')
        self.set(node.inputs[0], vector)
        return node.outputs

    def combine(self, x, y, z):
        node = self.node('ShaderNodeCombineXYZ')
        for i, v in enumerate((x, y, z)):
            self.set(node.inputs[i], v)
        return node.outputs[0]

    def bump(self, height, strength, distance=0.02, normal=None):
        node = self.node('ShaderNodeBump', inputs={'Strength': strength, 'Distance': distance, 'Height': height})
        if normal is not None:
            self.set(node.inputs['Normal'], normal)
        return node.outputs['Normal']

    def hsv(self, color, hue=0.5, saturation=1.0, value=1.0):
        node = self.node('ShaderNodeHueSaturation', inputs={'Hue': hue, 'Saturation': saturation, 'Value': value, 'Fac': 1.0, 'Color': color})
        return node.outputs['Color']


def new_material(name):
    material = bpy.data.materials.new(name)
    try:
        material.use_nodes = True
    except Exception:
        pass
    graph = Graph(material.node_tree)
    for node in list(graph.nodes):
        graph.nodes.remove(node)
    output = graph.node('ShaderNodeOutputMaterial')
    return material, graph, output


def principled(graph, base, roughness=0.5, metallic=0.0, normal=None, **extra):
    node = graph.node('ShaderNodeBsdfPrincipled')
    graph.set(node.inputs['Base Color'], base)
    graph.set(node.inputs['Roughness'], roughness)
    graph.set(node.inputs['Metallic'], metallic)
    if normal is not None:
        graph.set(node.inputs['Normal'], normal)
    for key, value in extra.items():
        graph.set(node.inputs[key.replace('_', ' ')], value)
    return node.outputs[0]


def world_position(graph):
    """Shading point in Blender world space, for textures that must not stretch
    across parts of different sizes (the imported GLB has no UVs)."""
    return graph.node('ShaderNodeNewGeometry').outputs['Position']


def srgb_to_linear(hex_or_rgb):
    if isinstance(hex_or_rgb, str):
        h = hex_or_rgb.lstrip('#')
        rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    else:
        rgb = list(hex_or_rgb)
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb)


def scale_color(rgb, k):
    return tuple(min(1.0, max(0.0, c * k)) for c in rgb)


# ---------------------------------------------------------------------------
# Meshes

def mesh_object(name, vertices, faces, collection, material=None, uvs=None, colors=None, smooth=False, model_space=True):
    """Builds an object from model-space vertices (converted to Blender) and
    polygon index lists. uvs / colors are per face-corner lists in face order."""
    mesh = bpy.data.meshes.new(name)
    verts = [to_blender(v) if model_space else Vector(v) for v in vertices]
    mesh.from_pydata(verts, [], faces)
    if uvs is not None:
        layer = mesh.uv_layers.new(name='UVMap')
        for i, uv in enumerate(uvs):
            layer.data[i].uv = uv
    if colors is not None:
        attribute = mesh.color_attributes.new(name='tint', type='FLOAT_COLOR', domain='CORNER')
        for i, c in enumerate(colors):
            attribute.data[i].color = (c[0], c[1], c[2], 1.0)
    mesh.validate(clean_customdata=False)
    mesh.update()
    for polygon in mesh.polygons:
        polygon.use_smooth = smooth
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    if material is not None:
        if isinstance(material, (list, tuple)):
            for m in material:
                mesh.materials.append(m)
        else:
            mesh.materials.append(material)
    return obj


class MeshBuilder:
    """Accumulates model-space geometry, one material slot index per face."""

    def __init__(self):
        self.vertices, self.faces, self.slots, self.uvs = [], [], [], []

    def add(self, vertices, faces, slot=0, uvs=None):
        base = len(self.vertices)
        self.vertices.extend(vertices)
        for i, face in enumerate(faces):
            self.faces.append([base + j for j in face])
            self.slots.append(slot)
            self.uvs.extend(uvs[i] if uvs else [(0.0, 0.0)] * len(face))

    def box(self, centre, size, slot=0, transform=None):
        cx, cy, cz = centre
        hx, hy, hz = (s / 2 for s in size)
        corners = [(cx + sx * hx, cy + sy * hy, cz + sz * hz) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
        if transform:
            corners = [transform(c) for c in corners]
        faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]
        self.add(corners, faces, slot)

    def tube(self, start, end, radius_start, radius_end, segments=10, slot=0, caps=True):
        """Tapered round rod between two model-space points."""
        a, b = Vector(start), Vector(end)
        axis = (b - a)
        length = axis.length
        if length < 1e-6:
            return
        axis.normalize()
        helper = Vector((1, 0, 0)) if abs(axis.x) < 0.9 else Vector((0, 0, 1))
        u = axis.cross(helper).normalized()
        v = axis.cross(u).normalized()
        ring = []
        for end_point, radius in ((a, radius_start), (b, radius_end)):
            for k in range(segments):
                angle = 2 * math.pi * k / segments
                p = end_point + (u * math.cos(angle) + v * math.sin(angle)) * radius
                ring.append(tuple(p))
        faces = [[k, (k + 1) % segments, segments + (k + 1) % segments, segments + k] for k in range(segments)]
        if caps:
            faces.append(list(reversed(range(segments))))
            faces.append([segments + k for k in range(segments)])
        self.add(ring, faces, slot)

    def prism(self, profile, z0, z1, slot=0, transform=None, edge_slots=None):
        """A side profile [(x, y)] extruded across local z (vehicle bodies).
        edge_slots optionally gives a material slot per profile edge."""
        n = len(profile)
        vertices = [(x, y, z0) for x, y in profile] + [(x, y, z1) for x, y in profile]
        if transform:
            vertices = [transform(p) for p in vertices]
        self.add(vertices, [list(reversed(range(n))), [n + k for k in range(n)]], slot)
        base = len(self.vertices) - 2 * n
        for k in range(n):
            self.faces.append([base + k, base + (k + 1) % n, base + n + (k + 1) % n, base + n + k])
            self.slots.append(edge_slots[k] if edge_slots else slot)
            self.uvs.extend([(0.0, 0.0)] * 4)

    def build(self, name, collection, materials, smooth=False):
        obj = mesh_object(name, self.vertices, self.faces, collection, material=list(materials), uvs=self.uvs, smooth=smooth)
        for polygon, slot in zip(obj.data.polygons, self.slots):
            polygon.material_index = slot
        return obj


def bevel(obj, width, segments=2, angle_deg=40):
    modifier = obj.modifiers.new('bevel', 'BEVEL')
    modifier.width = width
    modifier.segments = segments
    modifier.limit_method = 'ANGLE'
    modifier.angle_limit = math.radians(angle_deg)
    modifier.harden_normals = False
    return modifier


def smooth_by_angle(obj, angle_deg=35):
    """Smooth shading on curved parts, sharp on box edges (the GLB carries no normals)."""
    mesh = obj.data
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    try:
        mesh.set_sharp_from_angle(angle=math.radians(angle_deg))
    except AttributeError:
        bm = bmesh.new()
        bm.from_mesh(mesh)
        for edge in bm.edges:
            if len(edge.link_faces) == 2 and edge.calc_face_angle(0) > math.radians(angle_deg):
                edge.smooth = False
        bm.to_mesh(mesh)
        bm.free()
