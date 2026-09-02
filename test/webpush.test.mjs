/**
 * dsh-pwa-notify Web Push tests.
 *
 * The crown jewel is the RFC 8291 Appendix A known-answer vector: the RFC
 * publishes fixed keys, salt, plaintext and the exact expected ciphertext.
 * The hand-rolled encryption must reproduce it byte for byte — this is the
 * only way to know a hand-written HKDF/GCM wiring is right without shipping
 * to a real phone. Everything else (VAPID JWT, state file, subscribe route,
 * broadcast against a local push-service stub) builds on node primitives
 * only.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createVerify,
  createPublicKey,
  createPrivateKey,
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
} from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import {
  b64uDecode,
  encryptPayload,
  vapidAuthHeader,
  generateVapidKeys,
  createPushState,
  hkdf,
  publicFromRaw,
} from '../src/webpush.js'
import { handleSubscribe, handleUnsubscribe, handleVapid, handleDevices, handleDeviceRemove, BASE } from '../src/index.js'

// --- RFC 8291 Appendix A: known-answer vector --------------------------------

// Whitespace removed from the RFC's wrapped base64url lines.
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24', // "When I grow up, …"
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
}

test('RFC 8291 Appendix A: encryptPayload reproduces the expected bytes', () => {
  // Rebuild the fixed application-server key pair from the RFC's raw keys.
  const pub = b64uDecode(RFC.asPublic)
  const asKeys = {
    publicKey: pub,
    privateKey: createPrivateKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33, 65).toString('base64url'),
        d: RFC.asPrivate,
      },
      format: 'jwk',
    }),
  }
  const out = encryptPayload(
    { p256dh: RFC.uaPublic, auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    b64uDecode(RFC.plaintext),
    { salt: b64uDecode(RFC.salt), asKeys },
  )
  const expect = Buffer.concat([b64uDecode(RFC.header), b64uDecode(RFC.ciphertext)])
  assert.deepEqual(out, expect, 'ciphertext must match RFC 8291 Appendix A byte for byte')
})

test('encryptPayload roundtrip: our own decrypt recovers the plaintext', () => {
  // Receiver-side decrypt per the same RFC (used ONLY as a test oracle).
  const ua = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const uaJwk = ua.publicKey.export({ format: 'jwk' })
  const uaPublic = Buffer.concat([Buffer.from([0x04]), b64uDecode(uaJwk.x), b64uDecode(uaJwk.y)])
  const auth = Buffer.from('0123456789abcdef')

  const body = encryptPayload(
    { p256dh: uaPublic.toString('base64url'), auth: auth.toString('base64url') },
    Buffer.from(JSON.stringify({ title: '等你授权', body: 'bash 需要授权才能继续', tag: 'dsh-approval-1' })),
  )

  // --- decrypt (receiver) ---
  // aes128gcm header: salt(16) || rs(4) || idlen(1) || as_public(65) || ciphertext
  const salt = body.subarray(0, 16)
  const idlen = body[20]
  const asPublic = body.subarray(21, 21 + idlen)
  const ciphertext = body.subarray(21 + idlen)
  const ecdhSecret = diffieHellman({ privateKey: ua.privateKey, publicKey: publicFromRaw(asPublic) })
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info'), Buffer.alloc(1), uaPublic, asPublic])
  const ikm = hkdf(auth, ecdhSecret, keyInfo, 32)
  const cek = hkdf(salt, ikm, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), Buffer.alloc(1)]), 16)
  const nonce = hkdf(salt, ikm, Buffer.concat([Buffer.from('Content-Encoding: nonce'), Buffer.alloc(1)]), 12)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  assert.equal(plaintext[plaintext.length - 1], 0x02, 'padding delimiter present')
  const parsed = JSON.parse(plaintext.subarray(0, plaintext.length - 1).toString('utf8'))
  assert.equal(parsed.title, '等你授权')
})

// --- VAPID auth header --------------------------------------------------------

test('vapidAuthHeader: JWT verifies against the VAPID public key; claims are right', () => {
  const vapid = generateVapidKeys()
  const endpoint = 'https://fcm.googleapis.com/fcm/send/some-endpoint'
  const { authorization } = vapidAuthHeader(vapid, endpoint, 'https://dsh.example.com', 1_000_000)

  const m = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(authorization)
  assert.ok(m, 'header shape: vapid t=<jwt>, k=<key>')
  assert.equal(m[4], vapid.publicKey)

  const claims = JSON.parse(b64uDecode(m[2]).toString('utf8'))
  assert.equal(claims.aud, 'https://fcm.googleapis.com')
  assert.equal(claims.sub, 'https://dsh.example.com')
  assert.equal(claims.exp, 1_000_000 + 12 * 3600)

  // Signature check with the raw public key (ES256 = P1363 r||s). Node
  // builds spell the dsaEncoding two ways; accept either.
  const pubRaw = b64uDecode(m[4])
  const pub = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: pubRaw.subarray(1, 33).toString('base64url'), y: pubRaw.subarray(33, 65).toString('base64url') },
    format: 'jwk',
  })
  const verify = createVerify('SHA256')
  verify.update(m[1] + '.' + m[2])
  let verified = false
  for (const encoding of ['ieee-p1363', 'ieee-p1363-format']) {
    try {
      if (verify.verify({ key: pub, dsaEncoding: encoding }, b64uDecode(m[3]))) verified = true
      break
    } catch {
      /* try the other spelling */
    }
  }
  assert.equal(verified, true)
})

// --- push state ---------------------------------------------------------------

test('createPushState: generates VAPID once, persists, reloads identical key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-notify-'))
  try {
    const file = join(dir, 'state.json')
    const a = createPushState({ stateFile: file })
    const b = createPushState({ stateFile: file })
    assert.equal(a.vapidPublicKey(), b.vapidPublicKey(), 'second load must reuse the persisted key')

    const n = a.addSubscription({ endpoint: 'https://push.example/x', keys: { p256dh: 'A', auth: 'B' } })
    assert.equal(n, 1)
    const c = createPushState({ stateFile: file })
    assert.equal(c.subscriptions().length, 1)
    assert.equal(c.removeSubscription('https://push.example/x'), 1)
    assert.equal(c.subscriptions().length, 0)

    assert.throws(() => a.addSubscription({ endpoint: 'notaurl', keys: {} }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- routes + broadcast against a local push-service stub ----------------------

function mockRes() {
  const state = { status: 0, headers: {}, body: null, ended: false }
  return {
    state,
    setHeader(k, v) {
      state.headers[k.toLowerCase()] = v
    },
    writeHead(code) {
      state.status = code
    },
    end(bytes) {
      state.ended = true
      state.body = bytes
    },
    destroy() {},
  }
}

function mockReq({ method = 'GET', url = '/', headers = {}, body = null }) {
  const listeners = {}
  const req = {
    method,
    url,
    headers,
    on(ev, cb) {
      ;(listeners[ev] ??= []).push(cb)
    },
    destroy() {},
  }
  if (body !== null) {
    queueMicrotask(() => {
      for (const cb of listeners.data ?? []) cb(Buffer.from(body))
      for (const cb of listeners.end ?? []) cb()
    })
  }
  return req
}

test('subscribe/vapid routes: same-origin enforced, subscription persisted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-notify-'))
  try {
    const push = createPushState({ stateFile: join(dir, 'state.json') })
    const sub = { endpoint: 'https://push.example/dev1', keys: { p256dh: 'A', auth: 'B' } }

    const res403 = mockRes()
    await handleSubscribe(push, mockReq({ method: 'POST', headers: { origin: 'http://evil', host: 'ok' }, body: '{}' }), res403)
    assert.equal(res403.state.status, 403)

    const resOk = mockRes()
    await handleSubscribe(
      push,
      mockReq({
        method: 'POST',
        url: `${BASE}/subscribe`,
        headers: { origin: 'http://ok:1', host: 'ok:1' },
        body: JSON.stringify({ subscription: sub }),
      }),
      resOk,
    )
    assert.equal(resOk.state.status, 200)
    assert.equal(push.subscriptions().length, 1)

    const resV = mockRes()
    handleVapid(push, mockReq({ url: `${BASE}/vapid` }), resV)
    assert.equal(resV.state.status, 200)
    assert.equal(JSON.parse(resV.state.body).publicKey, push.vapidPublicKey())

    const resOff = mockRes()
    await handleUnsubscribe(
      push,
      mockReq({
        method: 'POST',
        url: `${BASE}/unsubscribe`,
        headers: { origin: 'http://ok:1', host: 'ok:1' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }),
      resOff,
    )
    assert.equal(resOff.state.status, 200)
    assert.equal(push.subscriptions().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('device management: metadata merge, list sanitization, removal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-notify-'))
  try {
    const push = createPushState({ stateFile: join(dir, 'state.json') })
    const sub = { endpoint: 'https://web.push.apple.com/x1', keys: { p256dh: 'A', auth: 'B' } }

    await handleSubscribe(push, mockReq({
      method: 'POST', url: `${BASE}/subscribe`,
      headers: { origin: 'http://ok:1', host: 'ok:1' },
      body: JSON.stringify({ subscription: sub, device: { label: 'iPhone 18_2 · 主屏' } }),
    }), mockRes())

    const resList = mockRes()
    handleDevices(push, mockReq({ url: `${BASE}/devices` }), resList)
    assert.equal(resList.state.status, 200)
    const devices = JSON.parse(resList.state.body).devices
    assert.equal(devices.length, 1)
    assert.equal(devices[0].label, 'iPhone 18_2 · 主屏')
    assert.equal(devices[0].host, 'web.push.apple.com')
    // crypto material must NEVER appear in the management view
    const rawList = String(resList.state.body)
    assert.ok(!rawList.includes('"p256dh"') && !rawList.includes('"auth"'))

    // same endpoint re-POST (resync) refreshes updatedAt, keeps firstSeenAt
    await sleep(20)
    await handleSubscribe(push, mockReq({
      method: 'POST', url: `${BASE}/subscribe`,
      headers: { origin: 'http://ok:1', host: 'ok:1' },
      body: JSON.stringify({ subscription: sub, device: { label: 'iPhone 18_2 · 主屏' } }),
    }), mockRes())
    const resList2 = mockRes()
    handleDevices(push, mockReq({ url: `${BASE}/devices` }), resList2)
    const d2 = JSON.parse(resList2.state.body).devices[0]
    assert.equal(d2.firstSeenAt, devices[0].firstSeenAt)
    assert.ok(d2.updatedAt > devices[0].updatedAt)

    // removal route: same-origin enforced, then removes
    const res403 = mockRes()
    await handleDeviceRemove(push, mockReq({ method: 'POST', headers: { origin: 'http://evil', host: 'ok' }, body: '{}' }), res403)
    assert.equal(res403.state.status, 403)
    const resDel = mockRes()
    await handleDeviceRemove(push, mockReq({
      method: 'POST', url: `${BASE}/devices/remove`,
      headers: { origin: 'http://ok:1', host: 'ok:1' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }), resDel)
    assert.equal(resDel.state.status, 200)
    assert.equal(JSON.parse(resDel.state.body).removed, 1)
    assert.equal(push.subscriptions().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('broadcast: real HTTP to a local push stub, aes128gcm + VAPID on the wire, 410 prunes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-notify-'))
  const seen = []
  let reply = { status: 201, body: '{}' }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) })
      res.writeHead(reply.status)
      res.end(reply.body)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const push = createPushState({ stateFile: join(dir, 'state.json') })
    const port = server.address().port
    push.addSubscription({ endpoint: `http://127.0.0.1:${port}/push/gone`, keys: { p256dh: RFC.uaPublic, auth: 'BTBZMqHH6r4Tts7J_aSIgg' } })

    reply = { status: 201, body: '{}' }
    let result = await push.broadcast({ title: 'DSH 等你授权', body: 'bash …', tag: 'dsh-approval-1', url: '/' }, { ttl: 900, urgency: 'high' })
    assert.equal(result.sent, 1)
    assert.equal(seen.length, 1)
    const hit = seen[0]
    assert.equal(hit.headers['content-encoding'], 'aes128gcm')
    assert.equal(hit.headers.ttl, '900')
    assert.equal(hit.headers.urgency, 'high')
    assert.match(hit.headers.authorization, /^vapid t=/)
    // aes128gcm framing: 16-byte salt, rs=4096, keyid=65 — total ≥ 86 header bytes.
    assert.equal(hit.body.readUInt32BE(16), 4096)
    assert.equal(hit.body[20], 65)
    assert.equal(hit.body[21], 0x04)

    // Push service says gone: subscription must be pruned.
    reply = { status: 410, body: '{}' }
    result = await push.broadcast({ title: 'again' })
    assert.equal(result.sent, 0)
    assert.deepEqual(result.pruned, [`http://127.0.0.1:${port}/push/gone`])
    assert.equal(push.subscriptions().length, 0)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
