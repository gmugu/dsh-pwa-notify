#!/usr/bin/env node
/**
 * dsh-pwa-notify · PWA icon generator.
 *
 * Primary path: rasterize the DSH whale mark (vendored at pwa/icons/whale.svg
 * from @deepseek-ai/dsh-web-frontend's favicon) on the dark gradient tile,
 * entirely as one SVG string, using the HOST INSTALL'S sharp (absolute path —
 * dev-time only, never a package dependency; sharp's bundled libvips does the
 * SVG rasterization).
 *
 * Fallback path (host sharp unavailable): the original hand-drawn bell —
 * a hand-rolled PNG encoder (IHDR/IDAT/IEND + CRC32) and per-pixel SDF
 * drawing with 3×3 supersampling, zero dependencies. The committed PNGs are
 * whale icons; the bell exists so `npm run icons` never hard-fails.
 *
 * Maskable variant: full-bleed tile + whale shrunk into the 80% safe zone.
 * Run after changing the drawing: `npm run icons`.
 */
import { readFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'pwa', 'icons')

const BG_TOP = '#262c3a'
const BG_BOT = '#0f1115'
const MARK = '#e8eaef'

// ---- primary: sharp + whale SVG ---------------------------------------------

const SHARP_PATHS = [
  '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/sharp', // host dsh install (this deployment)
  'sharp', // resolvable from this project (e.g. after a dev-time install)
]

async function loadSharp() {
  for (const candidate of SHARP_PATHS) {
    try {
      const req = createRequire(import.meta.url)
      return req(candidate)
    } catch {
      /* try next */
    }
  }
  return null
}

/** The whale path data, extracted from the vendored SVG. */
async function whalePath() {
  const svg = await readFile(join(OUT_DIR, 'whale.svg'), 'utf8')
  const m = /d="([^"]+)"/.exec(svg)
  if (!m) throw new Error('whale.svg carries no path data')
  return m[1]
}

/** One icon as a single SVG: gradient rounded (or full-bleed) tile + whale. */
function tileSvg(size, { radiusRatio, whaleRatio, path }) {
  const whaleUnits = 50 // whale viewBox
  const scale = (size * whaleRatio) / whaleUnits
  const offset = (size - whaleUnits * scale) / 2
  const radius = Math.round(size * radiusRatio)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="${BG_TOP}"/><stop offset="1" stop-color="${BG_BOT}"/>
</linearGradient></defs>
<rect width="${size}" height="${size}" rx="${radius}" fill="url(#g)"/>
<g transform="translate(${offset} ${offset}) scale(${scale})">
<path fill="${MARK}" fill-rule="nonzero" d="${path}"/>
</g>
</svg>`
}

async function renderWhaleIcons() {
  const sharp = await loadSharp()
  if (sharp === null) {
    console.warn('[gen-icons] host sharp unavailable — falling back to the bell drawing')
    return false
  }
  const path = await whalePath()
  const targets = [
    { file: 'icon-192.png', size: 192, radiusRatio: 0.18, whaleRatio: 0.68 },
    { file: 'icon-512.png', size: 512, radiusRatio: 0.18, whaleRatio: 0.68 },
    // Maskable: full-bleed background + whale well inside the 80% safe zone.
    { file: 'icon-maskable-512.png', size: 512, radiusRatio: 0, whaleRatio: 0.5 },
    // apple-touch-icon: iOS home screen. FULL SQUARE (iOS rounds it itself —
    // baked-in rounded corners would show black gaps) and opaque.
    { file: 'icon-apple-180.png', size: 180, radiusRatio: 0, whaleRatio: 0.62 },
  ]
  for (const t of targets) {
    const png = await sharp(Buffer.from(tileSvg(t.size, { ...t, path }))).png({ compressionLevel: 9 }).toBuffer()
    writeFileSync(join(OUT_DIR, t.file), png)
    console.log(`[gen-icons] ${t.file} — whale ${t.size}×${t.size}, ${png.length} bytes`)
  }
  return true
}

// ---- fallback: hand-rolled bell (zero dependencies) ---------------------------

const BELL = [0xe8, 0xea, 0xef]
const lerp = (a, b, t) => a + (b - a) * t

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

function bellInside(x, y) {
  if (circleInside(x, y, 0.5, 0.218, 0.03)) return true
  if (circleInside(x, y, 0.5, 0.708, 0.048)) return true
  if (roundedRectInside(x, y, 0.232, 0.6, 0.768, 0.648, 0.024)) return true
  if (y >= 0.25 && y <= 0.615) {
    let hw
    if (y <= 0.38) {
      const dy = y - 0.38
      const r2 = 0.13 * 0.13 - dy * dy
      hw = r2 <= 0 ? 0 : Math.sqrt(r2)
    } else {
      const t = (y - 0.38) / 0.235
      hw = 0.13 + 0.132 * Math.pow(t, 1.7)
    }
    if (Math.abs(x - 0.5) <= hw) return true
  }
  return false
}

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

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function renderBell(size, { radius, contentScale }) {
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
          let cr = lerp(0x26, 0x0f, v)
          let cg = lerp(0x2c, 0x11, v)
          let cb = lerp(0x3a, 0x15, v)
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

function renderBellIcons() {
  const targets = [
    { file: 'icon-192.png', size: 192, radius: 0.18, contentScale: 1 },
    { file: 'icon-512.png', size: 512, radius: 0.18, contentScale: 1 },
    { file: 'icon-maskable-512.png', size: 512, radius: 0, contentScale: 0.76 },
    { file: 'icon-apple-180.png', size: 180, radius: 0, contentScale: 0.9 },
  ]
  for (const t of targets) {
    const png = renderBell(t.size, t)
    writeFileSync(join(OUT_DIR, t.file), png)
    console.log(`[gen-icons] ${t.file} — bell fallback ${t.size}×${t.size}, ${png.length} bytes`)
  }
}

// ---- emit ---------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true })
const done = await renderWhaleIcons()
if (!done) renderBellIcons()
