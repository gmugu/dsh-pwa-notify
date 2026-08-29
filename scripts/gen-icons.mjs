#!/usr/bin/env node
/**
 * dsh-pwa-notify · dependency-free PWA icon generator.
 *
 * Writes pwa/icons/icon-192.png, icon-512.png, icon-maskable-512.png with
 * nothing but node:zlib + node:fs: a hand-rolled PNG encoder (IHDR/IDAT/IEND
 * with a CRC32 table) plus a per-pixel bell glyph rendered with 3×3
 * supersampling. Run after changing the drawing: `npm run icons`.
 *
 * Design: dark vertical-gradient rounded tile (the DSH dark chrome) with a
 * light bell. The maskable variant fills the whole square and shrinks the
 * bell into the 80% safe zone so launcher masks never clip it.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'pwa', 'icons')

// ---- PNG encoder -----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length)
  return out
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** Encode one RGBA buffer (width*height*4, row-major) as a PNG. */
function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter type 0 (None) per scanline
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- drawing ---------------------------------------------------------------

const BG_TOP = [0x26, 0x2c, 0x3a]
const BG_BOT = [0x0f, 0x11, 0x15]
const BELL = [0xe8, 0xea, 0xef]

const lerp = (a, b, t) => a + (b - a) * t

/** Rounded-square tile coverage; radius 0 = full-bleed square (maskable). */
function bgInside(u, v, radius) {
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - radius), 0)
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - radius), 0)
  return dx * dx + dy * dy <= radius * radius
}

function circleInside(x, y, cx, cy, r) {
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

function roundedRectInside(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

/**
 * Bell glyph in unit coords (y down): top nub, dome, flaring skirt, lip bar,
 * clapper. Everything a bell reads as, out of four primitives.
 */
function bellInside(x, y) {
  if (circleInside(x, y, 0.5, 0.218, 0.03)) return true // nub
  if (circleInside(x, y, 0.5, 0.708, 0.048)) return true // clapper
  if (roundedRectInside(x, y, 0.232, 0.6, 0.768, 0.648, 0.024)) return true // lip
  if (y >= 0.25 && y <= 0.615) {
    let hw
    if (y <= 0.38) {
      // dome: upper half of a circle r=0.13 centered at (0.5, 0.38)
      const dy = y - 0.38
      const r2 = 0.13 * 0.13 - dy * dy
      hw = r2 <= 0 ? 0 : Math.sqrt(r2)
    } else {
      // skirt: flare from 0.13 to 0.262 half-width
      const t = (y - 0.38) / 0.235
      hw = 0.13 + 0.132 * Math.pow(t, 1.7)
    }
    if (Math.abs(x - 0.5) <= hw) return true
  }
  return false
}

/** Render one tile. `contentScale` < 1 shrinks the bell toward the center. */
function render(size, { radius, contentScale }) {
  const rgba = Buffer.alloc(size * size * 4)
  const SS = 3
  const inv = 1 / contentScale
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let inside = 0
      let r = 0
      let g = 0
      let b = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (px + (sx + 0.5) / SS) / size
          const v = (py + (sy + 0.5) / SS) / size
          if (!bgInside(u, v, radius)) continue
          inside++
          let cr = lerp(BG_TOP[0], BG_BOT[0], v)
          let cg = lerp(BG_TOP[1], BG_BOT[1], v)
          let cb = lerp(BG_TOP[2], BG_BOT[2], v)
          const bu = 0.5 + (u - 0.5) * inv
          const bv = 0.5 + (v - 0.5) * inv
          if (bellInside(bu, bv)) {
            cr = BELL[0]
            cg = BELL[1]
            cb = BELL[2]
          }
          r += cr
          g += cg
          b += cb
        }
      }
      if (inside === 0) continue
      const idx = (py * size + px) * 4
      rgba[idx] = Math.round(r / inside)
      rgba[idx + 1] = Math.round(g / inside)
      rgba[idx + 2] = Math.round(b / inside)
      rgba[idx + 3] = Math.round((inside / (SS * SS)) * 255)
    }
  }
  return encodePng(size, size, rgba)
}

// ---- emit ------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true })

const targets = [
  { file: 'icon-192.png', size: 192, radius: 0.18, contentScale: 1 },
  { file: 'icon-512.png', size: 512, radius: 0.18, contentScale: 1 },
  // Maskable: full-bleed background + bell shrunk into the 80% safe zone.
  { file: 'icon-maskable-512.png', size: 512, radius: 0, contentScale: 0.76 },
]

for (const t of targets) {
  const png = render(t.size, t)
  writeFileSync(join(OUT_DIR, t.file), png)
  console.log(`[gen-icons] ${t.file} — ${t.size}×${t.size}, ${png.length} bytes`)
}
