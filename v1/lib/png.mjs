import { deflateSync, inflateSync, crc32 } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const COLOR_TYPE = { 1: 0, 3: 2, 4: 6 };

function chunk(type, data) {
  const head = Buffer.alloc(8), tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}

// 8-bit PNG from a tightly packed pixel array. channels: 1 grey, 3 RGB, 4 RGBA.
export function encodePNG(width, height, pixels, channels = 3) {
  if (!(channels in COLOR_TYPE)) throw new Error('PNG channels must be 1, 3 or 4');
  if (pixels.length !== width * height * channels) throw new Error('PNG pixel buffer has the wrong size');
  const stride = width * channels, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = COLOR_TYPE[channels];
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// Decodes 8-bit, non-interlaced grey / grey+alpha / RGB / RGBA PNGs, which covers
// what this repository writes and what Blender writes for 8-bit output.
export function decodePNG(bytes) {
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file');
  let offset = 8, width = 0, height = 0, channels = 0;
  const data = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0) throw new Error('Only 8-bit non-interlaced PNG is supported');
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[body[9]];
      if (!channels) throw new Error('Unsupported PNG colour type');
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data)), stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], row = y * stride, source = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const above = y ? pixels[row - stride + x] : 0;
      const corner = y && x >= channels ? pixels[row - stride + x - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = above;
      else if (filter === 3) predicted = (left + above) >> 1;
      else if (filter === 4) {
        const p = left + above - corner, pa = Math.abs(p - left), pb = Math.abs(p - above), pc = Math.abs(p - corner);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? above : corner;
      } else if (filter !== 0) throw new Error('Invalid PNG filter');
      pixels[row + x] = (raw[source + x] + predicted) & 255;
    }
  }
  return { width, height, channels, pixels };
}
