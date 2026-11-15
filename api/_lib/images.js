'use strict';

const crypto = require('node:crypto');
const sharp = require('sharp');

// Only plain photographs are accepted. Drawings and CAD files (PDF, DXF, DWG, STEP, IGES, STL, ZIP, SVG) are rejected
// on purpose: they are customer property and must never go near the public site.
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function sniffType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

class ImageError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 422; }
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// Checks a stored original. Never trusts the declared type or the file name.
async function inspectOriginal(buf, declaredType) {
  const sniffed = sniffType(buf);
  if (!sniffed) throw new ImageError('not_a_photo', 'Only JPEG, PNG or WebP photographs are accepted. Drawings and CAD files are not allowed here.');
  if (declaredType && declaredType !== sniffed) throw new ImageError('type_mismatch', 'The file is not the type it says it is.');
  let meta;
  try {
    meta = await sharp(buf, { limitInputPixels: 80e6, failOn: 'error' }).metadata();
  } catch (e) {
    throw new ImageError('corrupt_image', 'That image could not be read. It may be damaged.');
  }
  if (!meta.width || !meta.height) throw new ImageError('corrupt_image', 'That image could not be read.');
  if (Math.min(meta.width, meta.height) < 200) throw new ImageError('too_small', 'That photo is too small (under 200 pixels). Use the original from the camera.');
  return { contentType: sniffed, width: meta.width, height: meta.height, sha256: sha256(buf) };
}

// Public copies: orientation applied, all metadata (EXIF, GPS, camera, XMP) dropped, resized, re-encoded as JPEG.
async function makePublicCopies(buf) {
  const base = sharp(buf, { limitInputPixels: 80e6, failOn: 'error' }).rotate().flatten({ background: '#ffffff' });
  const large = await base.clone().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  const thumb = await base.clone().resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return {
    large: { buffer: large.data, width: large.info.width, height: large.info.height },
    thumb: { buffer: thumb.data, width: thumb.info.width, height: thumb.info.height },
  };
}

// Small private preview for the dashboard (still metadata-free).
async function makePreview(buf) {
  return sharp(buf, { limitInputPixels: 80e6 }).rotate().resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
}

module.exports = { ALLOWED_TYPES, EXT, sniffType, inspectOriginal, makePublicCopies, makePreview, ImageError, sha256 };
