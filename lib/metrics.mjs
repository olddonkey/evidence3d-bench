const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
export function intervalMeasurements(bounds, measurements) {
  return measurements.map(item => {
    const axis = ['x','y','z'].indexOf(item.axis), value = bounds.max[axis]-bounds.min[axis];
    const [low,high] = item.accepted_interval_m, distance = Math.max(low-value,0,value-high);
    return { id:item.id,kind:item.kind,axis:item.axis,measured_m:value,accepted_interval_m:item.accepted_interval_m,
      distance_to_interval_m:distance,tolerance_m:item.tolerance_m,source_ids:item.source_ids,
      pass:distance<=item.tolerance_m };
  });
}
export function dimensionMetrics(actual, expected, tolerance, centerTolerance) {
  return ['x', 'y', 'z'].map((axis, i) => {
    const reference = expected.max[i] - expected.min[i], measured = actual.max[i] - actual.min[i];
    const absolute = Math.abs(measured - reference), center = Math.abs((actual.max[i] + actual.min[i] - expected.max[i] - expected.min[i]) / 2);
    return { axis, reference_m: reference, measured_m: measured, absolute_error_m: absolute,
      relative_error: absolute / reference, center_error_m: center,
      dimension_pass: absolute <= tolerance, position_pass: center <= centerTolerance };
  });
}

export function makeViews(bounds, resolution = 192) {
  const origin = bounds.min.map((n, i) => (n + bounds.max[i]) / 2);
  const bases = [
    { id: 'front', right: [1,0,0], up: [0,1,0] },
    { id: 'right', right: [0,0,-1], up: [0,1,0] },
    { id: 'top', right: [1,0,0], up: [0,0,-1] },
    { id: 'oblique-a', right: [Math.SQRT1_2,0,-Math.SQRT1_2], up: [-1/Math.sqrt(6),2/Math.sqrt(6),-1/Math.sqrt(6)] },
    { id: 'oblique-b', right: [Math.SQRT1_2,0,Math.SQRT1_2], up: [1/Math.sqrt(6),2/Math.sqrt(6),-1/Math.sqrt(6)] }
  ];
  const corners = [];
  for (let n = 0; n < 8; n++) corners.push([0,1,2].map(i => bounds[(n >> i) & 1 ? 'max' : 'min'][i] - origin[i]));
  return bases.map(view => {
    const us = corners.map(c => dot(c, view.right)), vs = corners.map(c => dot(c, view.up));
    const margin = Math.max(Math.max(...us)-Math.min(...us), Math.max(...vs)-Math.min(...vs)) * 0.15;
    return { ...view, origin, resolution, extent: [Math.min(...us)-margin, Math.max(...us)+margin, Math.min(...vs)-margin, Math.max(...vs)+margin] };
  });
}

export function rasterize(coordinates, view) {
  const n = view.resolution, pixels = new Uint8Array(n*n), [minU,maxU,minV,maxV] = view.extent;
  const u = new Float64Array(3), v = new Float64Array(3);
  let outsideVertices = 0;
  for (let i = 0; i < coordinates.length; i += 9) {
    for (let j = 0; j < 3; j++) {
      const at = i + j*3, x = coordinates[at]-view.origin[0], y = coordinates[at+1]-view.origin[1], z = coordinates[at+2]-view.origin[2];
      u[j] = ((x*view.right[0]+y*view.right[1]+z*view.right[2])-minU)/(maxU-minU)*n;
      v[j] = (maxV-(x*view.up[0]+y*view.up[1]+z*view.up[2]))/(maxV-minV)*n;
      if (u[j] < 0 || u[j] > n || v[j] < 0 || v[j] > n) outsideVertices++;
    }
    const denominator = (v[1]-v[2])*(u[0]-u[2]) + (u[2]-u[1])*(v[0]-v[2]);
    if (Math.abs(denominator) < 1e-12) continue;
    const x0 = Math.max(0, Math.ceil(Math.min(...u)-0.5)), x1 = Math.min(n-1, Math.floor(Math.max(...u)-0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(...v)-0.5)), y1 = Math.min(n-1, Math.floor(Math.max(...v)-0.5));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x+0.5, py = y+0.5;
      const a = ((v[1]-v[2])*(px-u[2]) + (u[2]-u[1])*(py-v[2])) / denominator;
      const b = ((v[2]-v[0])*(px-u[2]) + (u[0]-u[2])*(py-v[2])) / denominator;
      if (a >= -1e-9 && b >= -1e-9 && a+b <= 1+1e-9) pixels[y*n+x] = 1;
    }
  }
  return { pixels, outside_vertices: outsideVertices };
}

export function maskMetrics(prediction, reference) {
  if (prediction.length !== reference.length) throw new Error('Mask sizes differ');
  let intersection = 0, predicted = 0, expected = 0;
  for (let i = 0; i < prediction.length; i++) {
    predicted += prediction[i] ? 1 : 0; expected += reference[i] ? 1 : 0;
    if (prediction[i] && reference[i]) intersection++;
  }
  if (!expected) throw new Error('Empty reference mask is not scoreable');
  return { iou: intersection / (predicted + expected - intersection),
    precision: predicted ? intersection / predicted : 0, recall: intersection / expected,
    intersection_pixels: intersection, prediction_pixels: predicted, reference_pixels: expected };
}

export function overlaySVG(prediction, reference, n) {
  const colors = ['#101c2b', '#ed9875', '#8fa8c3', '#4bc8ad'];
  const spans = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n;) {
      const status = (prediction[y*n+x] ? 1 : 0) + (reference[y*n+x] ? 2 : 0);
      let end = x+1;
      while (end < n && ((prediction[y*n+end] ? 1 : 0)+(reference[y*n+end] ? 2 : 0)) === status) end++;
      if (status) spans.push('<path fill="' + colors[status] + '" d="M' + x + ' ' + y + 'h' + (end-x) + 'v1H' + x + 'z"/>');
      x = end;
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="' + colors[0] + '"/>' + spans.join('') + '</svg>';
}
