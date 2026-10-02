# Preview tool

`preview.mjs` renders your `.glb` from fixed viewpoints and writes PNG images,
so you can look at what you built and compare it with the evidence you were
given. It does not score anything and knows nothing about the answer: it only
draws your own file.

```sh
node tools/preview.mjs output/model.glb --out output/preview
```

Then open the PNGs in `output/preview/` and look at them.

## What it prints

- triangle, primitive, mesh, node and material counts;
- the bounding box (`min`, `max`), the extent along X, Y and Z in metres, and the centre;
- one line per image with its size and, for orthographic views, the metres per
  pixel (so you can measure on the picture) and the grid spacing;
- notes about likely frame or unit mistakes (model below or floating above the
  ground, model thousands of metres across, ...).

It also writes `preview.json` with the same numbers and the camera of each view.

## Views

| View | Camera |
| --- | --- |
| `front` | orthographic, looking at the front (from +Z towards -Z) |
| `rear` | orthographic, looking at the back (from -Z towards +Z) |
| `left` | orthographic, from the viewer's left (-X side), front on the right of the image |
| `right` | orthographic, from the viewer's right (+X side), front on the left of the image |
| `top` | orthographic plan from above, front at the bottom of the image |
| `iso` | perspective three-quarter view from front-right, above |
| `iso-rear` | perspective three-quarter view from rear-left, above |

All standard views are framed on your model's bounding box. Orthographic views
compare directly with elevation and plan drawings; the faint grid behind the
model is aligned to the model axes: thin lines at the grid step, darker lines
at the larger step (the tool prints both for each view, e.g. "grid 0.5 m (bold
every 1 m)"), and reddish lines for the axes through the origin. In
perspective views the grid lies on the ground plane y = 0. The grid is drawn
only behind the model, never over it.

## Options

```text
--views front,left,right,rear,top,iso,iso-rear   which views (default: all)
--size 1024                                      longest image side in pixels
--clay                                           ignore colours; neutral clay for checking shape
--camera x,y,z --target x,y,z [--fov 50] [--name custom]
                                                 an extra perspective view from any point
--no-grid                                        plain background
--aa 2                                           supersampling (1 = fastest)
--max-triangles N                                also check your task's triangle budget
```

With `--camera` and no `--views`, only the custom view is rendered. Example: a
pedestrian's view of the front-left corner, 25 m away:

```sh
node tools/preview.mjs output/model.glb --out output/preview --camera -15,1.6,20 --target 0,3,0 --fov 45 --name street-left
```

## Frame convention (reminder)

- Units are **metres**. **+Y is up**; the ground is the plane **y = 0**.
- The object's **front faces +Z**. **+X is to the right** of a viewer who stands
  in front of the object and looks at it; "left" and "right" always mean that
  viewer's left (-X) and right (+X).
- Where the origin is differs between objects: your `task.json` (`frame.origin`)
  states it. The reddish grid lines show where your model's axes are.

## Shading

Flat Lambert shading with a light over the viewer's shoulder, so faces facing
different ways have different brightness; soft dark lines mark silhouettes,
depth steps and creases. Colours are your materials' base colours; textures,
vertex colours, transparency and lighting extensions are not drawn. Triangles
are drawn from both sides, so flipped normals do not show here.

## Errors

If the file is not a valid submission GLB the tool prints the reason and exits
with status 1 (2 for bad command-line options). The checks follow the
submission rules: binary glTF 2.0, one embedded buffer, plain triangle lists
with FLOAT positions, no Draco/meshopt compression, no animation, skins or
morph targets, exactly one scene. A file that fails here will fail at
submission; passing here does not check your task's budget unless you pass
`--max-triangles`.
