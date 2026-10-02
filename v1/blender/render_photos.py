# Evidence3D v1, module B: renders the photographs planned by
# v1/lib/evidence/photos.mjs. Run as
#   Blender --background --factory-startup --python-exit-code 1 --python render_photos.py -- <spec.json>
# The spec carries everything (object GLB, materials, site, light, occluders,
# cameras, post-processing parameters, output paths) in MODEL space; this script
# only executes it and reports timings to spec['result'].
import json
import math
import os
import sys
import time

import bpy
import numpy as np

# The helper modules sit next to this script; importing them must not leave a
# __pycache__ in the repository.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from e3d_common import Graph, camera_matrix, mesh_object, smooth_by_angle, to_blender  # noqa: E402
import e3d_materials as mats  # noqa: E402
import e3d_post as post  # noqa: E402
import e3d_props as props  # noqa: E402

FAR = 4000.0


def log(*parts):
    print('[e3d-photos]', *parts, flush=True)


def collection(name):
    c = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(c)
    return c


# ---------------------------------------------------------------------------
# Object

def import_object(spec, target):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=spec['glb'])
    imported = [o for o in bpy.data.objects if o not in before]
    parts = {p['id']: p for p in spec['parts']}
    cache, missing = {}, []
    for obj in imported:
        for c in list(obj.users_collection):
            c.objects.unlink(obj)
        target.objects.link(obj)
        if obj.type != 'MESH':
            continue
        part = parts.get(obj.name) or parts.get(obj.name.rsplit('.', 1)[0])
        key = part['material'] if part else None
        if key is None and obj.data.materials:
            key = obj.data.materials[0].name.rsplit('.', 1)[0]
        if key not in spec['materials']:
            missing.append(obj.name)
            continue
        if key not in cache:
            cache[key] = mats.building_material(key, spec['materials'][key], spec['render_seed'] + len(cache))
        obj.data.materials.clear()
        obj.data.materials.append(cache[key])
        smooth_by_angle(obj, 35)
    if missing:
        log('warning: no material for', missing)
    return [o for o in imported if o.type == 'MESH']


# ---------------------------------------------------------------------------
# Site

def cuts(low, high, centre):
    """Grid lines between low and high: 5 m apart near the object, growing
    geometrically with distance. Cycles intersects in float32, and kilometre
    triangles near the camera show stair-step shading and seams."""
    lines, step, offset = {low, high}, 5.0, 0.0
    while offset < max(high - centre, centre - low):
        for value in (centre + offset, centre - offset):
            if low < value < high:
                lines.add(value)
        offset += step
        if offset > 40:
            step *= 1.35
    return sorted(lines)


def quad(name, rect, height, material, target, centre=(0.0, 0.0)):
    x0, x1, z0, z1 = rect
    xs, zs = cuts(x0, x1, centre[0]), cuts(z0, z1, centre[1])
    vertices = [(x, height, z) for z in zs for x in xs]
    n = len(xs)
    faces = [[j * n + i, j * n + i + 1, (j + 1) * n + i + 1, (j + 1) * n + i] for j in range(len(zs) - 1) for i in range(n - 1)]
    return mesh_object(name, vertices, faces, target, material=material)


def slab(name, rect, top, bottom, material, target, centre=(0.0, 0.0)):
    """A long raised strip (sidewalk): top and kerb faces cut along x."""
    x0, x1, z0, z1 = rect
    xs = cuts(x0, x1, centre[0])
    vertices, faces = [], []
    for x in xs:
        vertices += [(x, bottom, z0), (x, top, z0), (x, top, z1), (x, bottom, z1)]
    for i in range(len(xs) - 1):
        a, b = 4 * i, 4 * (i + 1)
        faces += [[a + 1, b + 1, b + 2, a + 2], [a, b, b + 1, a + 1], [a + 3, a + 2, b + 2, b + 3], [a, a + 3, b + 3, b]]
    last = 4 * (len(xs) - 1)
    faces += [[0, 1, 2, 3], [last + 3, last + 2, last + 1, last]]
    return mesh_object(name, vertices, faces, target, material=material)


def build_site(spec, target):
    site, seed = spec['site'], spec['render_seed']
    materials = {}

    def material(kind):
        if kind not in materials:
            materials[kind] = mats.ground_material(kind, seed + len(materials), road=road if kind == 'asphalt-road' else None)
        return materials[kind]

    road = {'z0': site['road']['z0'], 'z1': site['road']['z1'], 'centre_line': site['road']['centreLine']}
    centre = (spec['centre'][0], spec['centre'][2])
    # The base ground sits a few millimetres below y = 0 so the object's floor
    # faces at y = 0 never share a plane with it.
    quad('ground', (-FAR, FAR, -FAR, FAR), -0.004, material(site['ground']), target, centre)
    quad('road', (-FAR, FAR, road['z0'], road['z1']), 0.0, material('asphalt-road'), target, centre)
    kerb = site['kerb']
    for k, (z0, z1) in enumerate(site['sidewalks']):
        slab('sidewalk-%d' % k, (-FAR, FAR, z0, z1), kerb, -0.2, material('concrete'), target, centre)
    # Overlapping patches get distinct heights so no two share a plane.
    heights = {'plaza': 0.002, 'apron': 0.004, 'path': 0.006, 'driveway': 0.009}
    for k, patch in enumerate(site['patches']):
        role = 'plaza' if patch.get('plaza') else 'apron' if patch.get('apron') else (
            'driveway' if site.get('driveway') and patch['rect'] == site['driveway']['rect'] else 'path')
        quad('patch-%d' % k, patch['rect'], heights[role], material(patch['material']), target)


def build_world(spec):
    light = spec['light']
    scene = bpy.context.scene
    world = bpy.data.worlds.new('sky')
    scene.world = world
    g = Graph(world.node_tree)
    for node in list(g.nodes):
        g.nodes.remove(node)
    output = g.node('ShaderNodeOutputWorld')
    elevation = math.radians(light['sun_elevation_deg'])
    azimuth = math.radians(light['sun_azimuth_deg'])
    sky_props = dict(sky_type='MULTIPLE_SCATTERING', sun_disc=False, sun_elevation=elevation, sun_rotation=math.pi - azimuth,
                     air_density=1.0, aerosol_density=light['aerosol'], ozone_density=1.0, altitude=0.0)
    direction = g.node('ShaderNodeTexCoord').outputs['Generated']
    sky = g.node('ShaderNodeTexSky', **sky_props)
    g.set(sky.inputs['Vector'], direction)
    # Cloud brightness follows the sky's own brightness at a fixed direction
    # away from the sun, so clouds stay plausible for any sun elevation.
    reference = g.node('ShaderNodeTexSky', **sky_props)
    g.set(reference.inputs['Vector'], to_blender((math.sin(azimuth + math.pi) * 0.85, 0.5, math.cos(azimuth + math.pi) * 0.85)))
    reference_luma = g.node('ShaderNodeRGBToBW', inputs={'Color': reference.outputs['Color']}).outputs[0]
    dx, dy, dz = g.separate(direction)
    lift = g.math('ADD', g.math('MAXIMUM', dz, 0.0), 0.06)
    plane = g.combine(g.math('DIVIDE', dx, lift), g.math('DIVIDE', dy, lift), 0.0)
    cover = light['cloud_cover']
    billow = g.noise(plane, 0.9, detail=7, roughness=0.6, w=light['cloud_seed'], distortion=0.25)
    threshold = 0.62 - 0.26 * cover
    density = g.map_range(billow, threshold, threshold + 0.07 + 0.05 * cover, 0.0, 1.0, interpolation='SMOOTHSTEP')
    density = g.math('MULTIPLY', density, g.map_range(dz, 0.0, 0.14, 0.0, 1.0, interpolation='SMOOTHSTEP'))
    shading = g.noise(plane, 2.4, detail=4, w=light['cloud_seed'] + 9)
    overcast = light['weather'] == 'overcast'
    # Under overcast the cloud deck is the light source, so it must stay
    # brighter than any surface it lights; it is brightest towards the zenith
    # (CIE overcast sky: about three times the horizon).
    gain = g.map_range(dz, 0.0, 1.0, 1.3, 3.2) if overcast else 2.4
    tone = g.math('MULTIPLY', g.math('MULTIPLY', reference_luma, gain), g.map_range(shading, 0.3, 0.7, 0.82 if overcast else 0.75, 1.08))
    cloud = g.mix(1.0, g.combine(tone, tone, tone), (1.0, 0.985, 0.96), blend='MULTIPLY')
    color = g.mix(density, sky.outputs['Color'], cloud)
    background = g.node('ShaderNodeBackground', inputs={'Color': color, 'Strength': 1.0})
    g.set(output.inputs['Surface'], background.outputs[0])
    return background


def measure_sky(background):
    """Horizontal irradiance of the sky alone, from a small equirectangular
    render, so the sun-to-sky ratio and exposure mean the same for every sky."""
    scene = bpy.context.scene
    hidden = {o: o.hide_render for o in scene.objects}
    for o in scene.objects:
        o.hide_render = True
    data = bpy.data.cameras.new('pano')
    data.type = 'PANO'
    try:
        data.panorama_type = 'EQUIRECTANGULAR'
    except Exception:
        data.cycles.panorama_type = 'EQUIRECTANGULAR'
    cam = bpy.data.objects.new('pano', data)
    scene.collection.objects.link(cam)
    cam.rotation_euler = (math.pi / 2, 0, 0)
    previous = (scene.camera, scene.render.engine, scene.render.resolution_x, scene.render.resolution_y, scene.render.filepath)
    scene.camera = cam
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    scene.render.resolution_x, scene.render.resolution_y = 128, 64
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'OPEN_EXR'
    path = os.path.join(WORK, 'sky.exr')
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    pixels = post.read_image(path)[..., :3]
    rows = pixels.shape[0]
    luminance = pixels @ post.LUMA
    elevation = (rows / 2 - (np.arange(rows) + 0.5)) * math.pi / rows
    upper = elevation > 0
    weight = np.sin(elevation) * np.cos(elevation) * (math.pi / rows) * (2 * math.pi / pixels.shape[1])
    irradiance = float((luminance[upper] * weight[upper, None]).sum())
    horizon = pixels[rows // 2 - 3:rows // 2].reshape(-1, 3).mean(axis=0) / max(irradiance, 1e-6)
    scene.camera, scene.render.engine, scene.render.resolution_x, scene.render.resolution_y, scene.render.filepath = previous
    bpy.data.objects.remove(cam)
    for o, h in hidden.items():
        o.hide_render = h
    background.inputs['Strength'].default_value = 1.0 / max(irradiance, 1e-6)
    return irradiance, [float(c) for c in horizon]


def build_sun(spec):
    light = spec['light']
    elevation = math.radians(light['sun_elevation_deg'])
    azimuth = math.radians(light['sun_azimuth_deg'])
    data = bpy.data.lights.new('sun', 'SUN')
    # Normal irradiance relative to the (normalised, = 1) horizontal sky irradiance.
    data.energy = light['sun_to_sky']
    data.angle = math.radians(light['sun_angle_deg'])
    t = min(max((light['sun_elevation_deg'] - 15) / 45, 0), 1)
    data.color = (1.0, 0.9 + 0.08 * t, 0.78 + 0.17 * t) if light['weather'] != 'overcast' else (1.0, 1.0, 1.0)
    sun = bpy.data.objects.new('sun', data)
    bpy.context.scene.collection.objects.link(sun)
    towards = to_blender((math.sin(azimuth) * math.cos(elevation), math.sin(elevation), math.cos(azimuth) * math.cos(elevation)))
    sun.rotation_mode = 'QUATERNION'
    sun.rotation_quaternion = towards.to_track_quat('Z', 'Y')
    return sun


# ---------------------------------------------------------------------------
# Rendering

def use_engine(spec, quality):
    scene = bpy.context.scene
    engine = spec.get('engine', 'cycles')
    info = {'engine': engine, 'device': 'CPU'}
    if engine == 'eevee':
        scene.render.engine = 'BLENDER_EEVEE'
        scene.eevee.taa_render_samples = 64 if quality == 'final' else 16
        scene.eevee.use_raytracing = True
        scene.eevee.use_shadows = True
        info['device'] = 'GPU'
        return info
    scene.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        gpus = [d for d in prefs.devices if d.type == 'METAL']
        for d in prefs.devices:
            d.use = d.type == 'METAL'
        if gpus and not spec.get('force_cpu'):
            scene.cycles.device = 'GPU'
            info['device'] = gpus[0].name
    except Exception as error:  # no Metal: fall back to CPU, report it
        info['device_error'] = str(error)
    if info['device'] == 'CPU':
        scene.cycles.device = 'CPU'
    c = scene.cycles
    c.use_adaptive_sampling = True
    c.adaptive_threshold = 0.015 if quality == 'final' else 0.06
    c.use_denoising = True
    c.denoiser = 'OPENIMAGEDENOISE'
    try:
        c.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
        c.denoising_prefilter = 'ACCURATE'
        c.denoising_use_gpu = info['device'] != 'CPU'
    except Exception:
        pass
    c.max_bounces = 8
    c.diffuse_bounces = 3
    c.glossy_bounces = 3
    c.transmission_bounces = 4
    c.transparent_max_bounces = 32
    c.caustics_reflective = False
    c.caustics_refractive = False
    c.blur_glossy = 1.0
    c.sample_clamp_indirect = 8.0
    c.seed = spec['render_seed'] % 100000
    return info


def set_camera(cam, camera_json, width, height):
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1.0
    data = cam.data
    data.type = 'PERSP'
    data.lens_unit = 'MILLIMETERS'
    data.sensor_fit = 'HORIZONTAL'
    data.sensor_width = 36.0
    # fx (pixels) = lens / sensor_width * width; the kernel camera has fx = fy and
    # the principal point at the image centre, which is Blender's default.
    data.lens = camera_json['fx'] * 36.0 / width
    data.shift_x = data.shift_y = 0.0
    data.clip_start = camera_json.get('near', 0.05)
    data.clip_end = 20000.0
    cam.matrix_world = camera_matrix(camera_json)


def render_to(path, file_format='PNG', depth='16', mode='RGB'):
    scene = bpy.context.scene
    settings = scene.render.image_settings
    settings.file_format = file_format
    settings.color_mode = mode
    if file_format == 'PNG':
        settings.color_depth = depth
        settings.compression = 15
    else:
        settings.color_depth = '16'
        settings.exr_codec = 'ZIP'
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def meter(shot, spec):
    """A small, fast render to set exposure like a camera's meter: the
    scene-linear log-average luminance over the object's box hits a key value."""
    scene = bpy.context.scene
    c = scene.cycles if scene.render.engine == 'CYCLES' else None
    saved = (c.samples, c.use_denoising) if c else None
    if c:
        c.samples, c.use_denoising = 8, False
    scene.render.resolution_percentage = 12
    path = os.path.join(WORK, shot['id'] + '-meter.exr')
    render_to(path, 'OPEN_EXR')
    scene.render.resolution_percentage = 100
    if c:
        c.samples, c.use_denoising = saved
    linear = post.read_image(path)[..., :3]
    return post.log_average_luminance(linear, shot.get('meter_box'))


def render_masks(shot, spec, groups):
    """Object-only and occluder-only coverage masks with the same camera:
    Workbench, flat white, no anti-aliasing, alpha = coverage."""
    scene = bpy.context.scene
    saved = {o: o.hide_render for o in scene.objects}
    previous = (scene.render.engine, scene.render.film_transparent, scene.view_settings.view_transform, scene.view_settings.look, scene.view_settings.exposure)
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.film_transparent = True
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0.0
    shading = scene.display.shading
    shading.light = 'FLAT'
    shading.color_type = 'SINGLE'
    shading.single_color = (1.0, 1.0, 1.0)
    shading.show_shadows = False
    shading.show_cavity = False
    shading.show_object_outline = False
    shading.show_specular_highlight = False
    scene.display.render_aa = 'OFF'
    files = {}
    for name, members in groups.items():
        keep = set(members)
        for o in scene.objects:
            o.hide_render = o not in keep and o.type == 'MESH' or o.type == 'LIGHT'
        path = os.path.join(spec['masks']['dir'], '%s.%s.png' % (shot['id'], name))
        render_to(path, 'PNG', depth='8', mode='RGBA')
        files[name] = path
    for o, h in saved.items():
        o.hide_render = h
    (scene.render.engine, scene.render.film_transparent, scene.view_settings.view_transform,
     scene.view_settings.look, scene.view_settings.exposure) = previous
    return files


def main():
    global WORK
    started = time.time()
    spec = json.load(open(sys.argv[sys.argv.index('--') + 1]))
    WORK = spec['work_dir']
    quality = spec.get('quality', 'final')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    # No render metadata may leak into the evidence files (lens, camera, paths).
    for attribute in dir(scene.render):
        if attribute.startswith('use_stamp'):
            try:
                setattr(scene.render, attribute, False)
            except Exception:
                pass
    object_collection, occluder_collection = collection('object'), collection('occluders')
    site_collection, backdrop_collection = collection('site'), collection('backdrop')
    objects = import_object(spec, object_collection)
    build_site(spec, site_collection)
    occluder_objects = []
    for occ in spec['occluders']:
        occluder_objects += props.build_occluder(occ, occluder_collection, quality, spec['light'].get('foliage_autumn', 0))
    props.backdrop(spec['backdrop'], backdrop_collection, quality, spec['render_seed'])
    background = build_world(spec)
    sky_irradiance, horizon = measure_sky(background)
    mats.set_haze(horizon, {'clear': 3500.0, 'hazy': 1100.0, 'overcast': 1500.0}[spec['light']['weather']])
    build_sun(spec)
    info = use_engine(spec, quality)
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - Medium High Contrast'
    scene.render.film_transparent = False
    scene.render.use_persistent_data = True
    cam = bpy.data.objects.new('camera', bpy.data.cameras.new('camera'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    setup_seconds = time.time() - started
    log('scene ready in %.1fs (%s on %s), sky irradiance %.3f' % (setup_seconds, info['engine'], info['device'], sky_irradiance))
    results = []
    for shot in spec['shots']:
        t0 = time.time()
        set_camera(cam, shot['camera'], shot['width'], shot['height'])
        if scene.render.engine == 'CYCLES':
            scene.cycles.samples = shot['samples']
        scene.view_settings.exposure = 0.0
        key = meter(shot, spec)
        exposure = math.log2(spec['exposure_key'] / max(key, 1e-6)) + shot['post']['exposure_ev']
        scene.view_settings.exposure = exposure
        beauty = os.path.join(WORK, shot['id'] + '.png')
        t1 = time.time()
        render_to(beauty, 'PNG', depth='16', mode='RGB')
        t2 = time.time()
        developed = post.develop(post.read_image(beauty)[..., :3], shot['post'])
        os.makedirs(os.path.dirname(shot['file']), exist_ok=True)
        post.write_jpeg(shot['file'], developed, shot['post']['jpeg_quality'])
        t3 = time.time()
        masks = render_masks(shot, spec, {'object': objects, 'occluders': occluder_objects}) if spec.get('masks') else None
        t4 = time.time()
        results.append({'id': shot['id'], 'file': shot['file'], 'seconds': round(t4 - t0, 2), 'render_seconds': round(t2 - t1, 2),
                        'meter_seconds': round(t1 - t0, 2), 'post_seconds': round(t3 - t2, 2), 'mask_seconds': round(t4 - t3, 2),
                        'exposure_ev': round(exposure, 3), 'meter_key': key, 'samples': shot['samples'], 'masks': masks})
        log('%s: %.1fs (render %.1fs)' % (shot['id'], t4 - t0, t2 - t1))
    result = {'ok': True, 'engine': info, 'blender': bpy.app.version_string, 'setup_seconds': round(setup_seconds, 2),
              'total_seconds': round(time.time() - started, 2), 'sky_irradiance': sky_irradiance, 'horizon': horizon,
              'object_meshes': len(objects), 'occluder_meshes': len(occluder_objects), 'shots': results}
    with open(spec['result'], 'w') as handle:
        json.dump(result, handle, indent=1)


WORK = None
if __name__ == '__main__':
    main()
