# Camera pipeline imitation, applied to the display-referred (AgX) render:
# white balance, tone and saturation, vignetting, sharpening, sensor noise and
# JPEG. Aerial tiles are additionally resampled down and up, as map imagery is.
# All randomness comes from the per-image seed the Node planner chose.
import bpy
import numpy as np

LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def read_image(path):
    """Pixels of an 8/16-bit PNG or EXR as float32 HxWxC, top row first, no colour conversion."""
    image = bpy.data.images.load(path, check_existing=False)
    image.colorspace_settings.name = 'Non-Color'
    width, height = image.size
    data = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(data)
    bpy.data.images.remove(image)
    return data.reshape(height, width, 4)[::-1].copy()


def write_jpeg(path, rgb, quality):
    height, width, _ = rgb.shape
    image = bpy.data.images.new('e3d-out', width, height, alpha=False, float_buffer=False)
    rgba = np.ones((height, width, 4), dtype=np.float32)
    rgba[..., :3] = np.clip(rgb, 0.0, 1.0)[::-1]
    image.pixels.foreach_set(rgba.ravel())
    image.filepath_raw = path
    image.file_format = 'JPEG'
    image.save(filepath=path, quality=int(quality))
    bpy.data.images.remove(image)


def _to_linear(a):
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


def _to_display(a):
    a = np.clip(a, 0.0, None)
    return np.where(a <= 0.0031308, a * 12.92, 1.055 * np.power(a, 1 / 2.4) - 0.055)


def _gaussian(a, sigma):
    radius = max(1, int(round(sigma * 3)))
    x = np.arange(-radius, radius + 1, dtype=np.float32)
    kernel = np.exp(-0.5 * (x / sigma) ** 2)
    kernel /= kernel.sum()
    out = a
    for axis in (0, 1):
        padded = np.pad(out, [(radius, radius) if i == axis else (0, 0) for i in range(out.ndim)], mode='edge')
        acc = np.zeros_like(out)
        for k, weight in enumerate(kernel):
            index = [slice(None)] * out.ndim
            index[axis] = slice(k, k + out.shape[axis])
            acc += weight * padded[tuple(index)]
        out = acc
    return out


def _resample(a, factor):
    """Box-filter down by an integer factor, then bilinear back up."""
    height, width, channels = a.shape
    small = a[:height - height % factor, :width - width % factor]
    small = small.reshape(height // factor, factor, width // factor, factor, channels).mean(axis=(1, 3))
    sh, sw = small.shape[:2]
    ys = np.clip((np.arange(height) + 0.5) / factor - 0.5, 0, sh - 1)
    xs = np.clip((np.arange(width) + 0.5) / factor - 0.5, 0, sw - 1)
    y0, x0 = np.floor(ys).astype(int), np.floor(xs).astype(int)
    y1, x1 = np.minimum(y0 + 1, sh - 1), np.minimum(x0 + 1, sw - 1)
    fy, fx = (ys - y0)[:, None, None], (xs - x0)[None, :, None]
    top = small[y0][:, x0] * (1 - fx) + small[y0][:, x1] * fx
    bottom = small[y1][:, x0] * (1 - fx) + small[y1][:, x1] * fx
    return top * (1 - fy) + bottom * fy


def develop(rgb, post):
    """rgb: display-referred float HxWx3. Returns the developed image (same space)."""
    rng = np.random.default_rng(int(post['seed']))
    a = rgb.astype(np.float32)
    height, width, _ = a.shape
    if post.get('downsample', 1) > 1.01:
        a = _resample(a, int(round(post['downsample'])))
    linear = _to_linear(a) * np.array(post['white_balance'], dtype=np.float32)
    # Vignetting is optical, so it acts on light, before the tone curve.
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    r2 = ((xx + 0.5 - width / 2) ** 2 + (yy + 0.5 - height / 2) ** 2) / ((width / 2) ** 2 + (height / 2) ** 2)
    linear *= (1 - post['vignette'] * r2 ** 1.5)[..., None]
    a = _to_display(linear)
    contrast = post['contrast']
    s_curve = a * a * (3 - 2 * a)
    a = np.clip(a + contrast * (s_curve - a) * 2, 0, 1)
    luma = (a @ LUMA)[..., None]
    a = luma + (a - luma) * post['saturation']
    if post.get('haze', 0) > 0:
        a = a * (1 - post['haze']) + post['haze'] * np.array([0.74, 0.77, 0.8], dtype=np.float32)
    a = a + post['sharpen'] * (a - _gaussian(a, 1.2))
    # Sensor noise: stronger in shadows, partly colour noise, slightly
    # correlated between neighbours as demosaicing makes it.
    luma = np.clip(a @ LUMA, 0, 1)[..., None]
    sigma = post['noise'] * (0.55 + 0.9 * (1 - luma))
    grain = rng.standard_normal((height, width, 1)).astype(np.float32)
    chroma = rng.standard_normal((height, width, 3)).astype(np.float32) * post['chroma_noise']
    noise = _gaussian(grain + chroma, 0.6) * 1.6
    a = a + noise * sigma
    return np.clip(a, 0, 1)


def log_average_luminance(linear_rgb, box=None):
    """Scene-linear key value over an optional [x0, y0, x1, y1] box in 0..1 image units (top-left origin)."""
    height, width, _ = linear_rgb.shape
    region = linear_rgb
    if box:
        x0, y0, x1, y1 = box
        region = linear_rgb[int(y0 * height):max(int(y1 * height), int(y0 * height) + 1),
                            int(x0 * width):max(int(x1 * width), int(x0 * width) + 1)]
    luminance = np.clip(region[..., :3] @ LUMA, 1e-5, None)
    return float(np.exp(np.mean(np.log(luminance))))
