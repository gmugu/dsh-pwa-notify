/**
 * dsh-pwa-notify · Web Push sender (RFC 8291 + RFC 8292), zero dependencies.
 *
 * Why hand-rolled instead of the `web-push` npm package (dsh-zen-remote's
 * choice): this plugin installs via `link:` under the profile, where pnpm
 * does NOT install a linked package's own dependencies — pulling web-push
 * would require a second install graph inside the plugin directory. Node's
 * crypto module has every primitive the two RFCs need, and the RFC 8291
 * Appendix A known-answer vector pins the implementation exactly (see
 * test/webpush.test.mjs — any deviation in HKDF wiring, point encoding, or
 * GCM usage fails that test before it can fail on a real phone).
 *
 * Layout:
 *   - VAPID keypair (RFC 8292): generated once, persisted in
 *     $DSH_HOME/pwa-notify-state.json. Regenerating would silently orphan
 *     every existing subscription, hence the state file.
 *   - encryptPayload (RFC 8291 aes128gcm): ephemeral ECDH per message,
 *     HKDF-combined with the subscription's auth secret, AES-128-GCM body.
 *   - vapidAuthHeader: ES256 JWT in the `Authorization: vapid t=…, k=…`
 *     form (P-256 signature in IEEE-P1363 raw form).
 *   - createPushState: subscriptions + VAPID keys, persisted atomically;
 *     broadcast() fans out and prunes endpoints the push service reports
 *     gone (404/410).
 */

import {
  createCipheriv,
  createHmac,
  createPublicKey,
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  diffieHellman,
  randomBytes,
} from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// ---- base64url helpers -----------------------------------------------------

export function b64uEncode(buf) {
  return Buffer.from(buf).toString('base64url')
}

export function b64uDecode(s) {
  return Buffer.from(String(s), 'base64url')
}

// ---- EC P-256 key handling ---------------------------------------------------

/** Raw 65-octet uncompressed point (0x04 || x || y) -> KeyObject. */
export function publicFromRaw(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : b64uDecode(raw)
  if (buf.length !== 65 || buf[0] !== 0x04) throw new Error('expected 65-byte uncompressed P-256 point')
  return createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64uEncode(buf.subarray(1, 33)), y: b64uEncode(buf.subarray(33, 65)) },
    format: 'jwk',
  })
}

/** { pub: b64u-raw-point, d: b64u-scalar } -> private KeyObject. */
export function privateFromStored(stored) {
  const pub = b64uDecode(stored.publicKey)
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64uEncode(pub.subarray(1, 33)),
      y: b64uEncode(pub.subarray(33, 65)),
      d: stored.privateKey,
    },
    format: 'jwk',
  })
}

/** Generate one VAPID pair in the persisted { publicKey, privateKey } shape. */
export function generateVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const d = privateKey.export({ format: 'jwk' }).d
  return { publicKey: b64uEncode(Buffer.concat([Buffer.from([0x04]), b64uDecode(jwk.x), b64uDecode(jwk.y)])), privateKey: d }
}

// ---- RFC 8291: aes128gcm payload encryption -----------------------------------

/**
 * HKDF per the RFC's pseudocode (Extract + Expand in one step).
 * @param {Buffer} salt     HKDF salt (auth_secret for PRK_key, salt for PRK).
 * @param {Buffer} ikm      input keying material.
 * @param {Buffer} info     expand info.
 * @param {number} length   output octets.
 */
export function hkdf(salt, ikm, info, length) {
  const prk = createHmac('sha256', salt).update(ikm).digest()
  let t = Buffer.alloc(0)
  const blocks = []
  let counter = 1
  while (blocks.reduce((n, b) => n + b.length, 0) < length) {
    t = createHmac('sha256', prk).update(Buffer.concat([t, info, Buffer.from([counter])])).digest()
    blocks.push(t)
    counter += 1
  }
  return Buffer.concat(blocks).subarray(0, length)
}

/**
 * Encrypt one push payload for one subscription (RFC 8291 §3.1/§5).
 *
 * @param {object} sub        `{ p256dh, auth }` base64url keys of the subscription.
 * @param {Buffer} plaintext  UTF-8 JSON payload (single record, ≤ ~3900 bytes).
 * @param {object} [fixed]    deterministic inputs for the known-answer test:
 *                            `{ salt: Buffer, asKeys: { publicKey, privateKey } }`.
 * @returns {Buffer} salt(16) || rs(4) || idlen(1) || as_public(65) || ciphertext.
 */
export function encryptPayload(sub, plaintext, fixed = {}) {
  const uaPublicRaw = b64uDecode(sub.p256dh)
  const authSecret = b64uDecode(sub.auth)
  const salt = fixed.salt ?? randomBytes(16)
  const asKeys =
    fixed.asKeys ?? (() => {
      const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      const jwk = pair.publicKey.export({ format: 'jwk' })
      return {
        publicKey: Buffer.concat([Buffer.from([0x04]), b64uDecode(jwk.x), b64uDecode(jwk.y)]),
        privateKey: pair.privateKey,
      }
    })()

  const ecdhSecret = diffieHellman({ privateKey: asKeys.privateKey, publicKey: publicFromRaw(uaPublicRaw) })

  // Key combining: PRK_key = HKDF(auth_secret, ecdh_secret);
  // IKM = Expand(PRK_key, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info'), Buffer.alloc(1), uaPublicRaw, asKeys.publicKey])
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32)

  // Content keys: PRK = HKDF(salt, IKM); CEK = Expand(PRK, cek_info, 16); NONCE = Expand(PRK, nonce_info, 12)
  const cek = hkdf(salt, ikm, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), Buffer.alloc(1)]), 16)
  const nonce = hkdf(salt, ikm, Buffer.concat([Buffer.from('Content-Encoding: nonce'), Buffer.alloc(1)]), 12)

  // Single record: plaintext || padding delimiter 0x02 (no extra padding).
  const rs = 4096
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ])

  const header = Buffer.concat([salt, rs32(rs), Buffer.from([asKeys.publicKey.length]), asKeys.publicKey])
  return Buffer.concat([header, ciphertext])
}

// rs as 4-byte big-endian (kept separate so the shape reads like the RFC).
function rs32(rs) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(rs)
  return b
}

// ---- RFC 8292: VAPID Authorization header ------------------------------------

/** ES256 raw-signing helper: ECDSA P-256/SHA-256, signature as P1363 r||s.
 * Node spells the dsaEncoding 'ieee-p1363-format' upstream but several
 * builds (v22.x LTS line included) accept only 'ieee-p1363' — try both. */
function es256RawSign(signer, keyObject) {
  for (const encoding of ['ieee-p1363', 'ieee-p1363-format']) {
    try {
      return signer.sign({ key: keyObject, dsaEncoding: encoding })
    } catch (e) {
      if (encoding === 'ieee-p1363-format') throw e
    }
  }
}

/**
 * Build `Authorization: vapid t=<jwt>, k=<b64u pubkey>` for one endpoint.
 *
 * @param {object} vapid    `{ publicKey, privateKey }` (stored shape).
 * @param {string} endpoint subscription endpoint URL (aud = its origin).
 * @param {string} subject  contact `mailto:` or `https:` URL.
 * @param {number} [now]    epoch seconds (test determinism).
 */
export function vapidAuthHeader(vapid, endpoint, subject, now = Math.floor(Date.now() / 1000)) {
  const aud = new URL(endpoint).origin
  const header = b64uEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = b64uEncode(JSON.stringify({ aud, exp: now + 12 * 3600, sub: subject }))
  const signingInput = header + '.' + claims
  const signature = es256RawSign(createSign('SHA256').update(signingInput), privateFromStored(vapid))
  return { authorization: `vapid t=${signingInput}.${b64uEncode(signature)}, k=${vapid.publicKey}` }
}

// ---- push state (VAPID keys + subscriptions), persisted atomically ------------

/** Fresh per-instance state — arrays must NOT be shared between instances
 * (a shallow `{...default}` copy leaks one instance's subscriptions into the
 * next through the shared array reference). */
function freshState() {
  return { vapid: null, subscriptions: [] }
}

function readStateFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      return { vapid: parsed.vapid ?? null, subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [] }
    }
  } catch {
    /* missing or corrupt -> regenerate */
  }
  return freshState()
}

/**
 * Create the push-sending half. All mutations persist immediately.
 *
 * @param {object} opts `{ stateFile, subject, fetchImpl?, now? }`.
 */
export function createPushState(opts = {}) {
  const stateFile = opts.stateFile
  const subject = opts.subject || 'mailto:admin@localhost'
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('no fetch implementation available')

  const state = readStateFile(stateFile)
  if (!state.vapid || !state.vapid.publicKey || !state.vapid.privateKey) {
    state.vapid = generateVapidKeys()
  }
  if (!Array.isArray(state.subscriptions)) state.subscriptions = []

  const save = () => {
      try {
      mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 })
      const tmp = stateFile + '.tmp'
      writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
      renameSync(tmp, stateFile)
    } catch (error) {
      console.warn(`[dsh-pwa-notify] cannot persist push state: ${error && error.message}`)
    }
  }
  if (process.env.DSH_DEBUG_ADD) {
  }
  save() // first run writes the freshly generated VAPID key before any subscribe

  const keyObject = () => privateFromStored(state.vapid)

  return {
    /** VAPID public key, base64url raw point — what clients subscribe with. */
    vapidPublicKey() {
      return state.vapid.publicKey
    },

    subscriptions() {
      return state.subscriptions.map((s) => ({ ...s }))
    },

    /**
     * Add or refresh one subscription (keyed by endpoint). `meta` carries the
     * client-derived label (device/UA hint); a re-POST of a known endpoint
     * (the returning-visitor resync) refreshes label/updatedAt while keeping
     * firstSeenAt — that timestamp is what tells an active device from an
     * abandoned one in the management list.
     */
    addSubscription(sub, meta = {}) {
      const clean = {
        endpoint: String(sub.endpoint || ''),
        p256dh: String((sub.keys && sub.keys.p256dh) || ''),
        auth: String((sub.keys && sub.keys.auth) || ''),
      }
      if (!/^https?:\/\//.test(clean.endpoint) || !clean.p256dh || !clean.auth) {
        throw new Error('subscription needs endpoint, keys.p256dh and keys.auth')
      }
      const label = typeof meta.label === 'string' ? meta.label.slice(0, 60) : ''
      const now = Date.now()
      const i = state.subscriptions.findIndex((s) => s.endpoint === clean.endpoint)
      if (i >= 0) {
        state.subscriptions[i] = {
          ...clean,
          label: label !== '' ? label : state.subscriptions[i].label || '',
          firstSeenAt: state.subscriptions[i].firstSeenAt ?? now,
          updatedAt: now,
        }
      } else {
        state.subscriptions.push({ ...clean, label, firstSeenAt: now, updatedAt: now })
      }
      save()
      return state.subscriptions.length
    },

    /**
     * Management view of the subscriptions: NEVER the crypto material —
     * only identity/routing hints the settings card renders.
     */
    listDevices() {
      return state.subscriptions.map((sub, i) => {
        let host = ''
        try {
          host = new URL(sub.endpoint).host
        } catch {
          host = ''
        }
        return {
          id: i,
          endpoint: sub.endpoint,
          host,
          label: sub.label || '未知设备',
          firstSeenAt: sub.firstSeenAt ?? null,
          updatedAt: sub.updatedAt ?? null,
        }
      })
    },

    removeSubscription(endpoint) {
      const before = state.subscriptions.length
      state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== endpoint)
      if (state.subscriptions.length !== before) save()
      return before - state.subscriptions.length
    },

    /**
     * Send one payload to one subscription. Resolves with the HTTP status.
     * Network errors resolve 0 (never reject — broadcast is best-effort).
     */
    async sendTo(sub, payload, { ttl = 900, urgency = 'normal' } = {}) {
      try {
        const body = encryptPayload(sub, Buffer.from(JSON.stringify(payload)))
        const { authorization } = vapidAuthHeader(state.vapid, sub.endpoint, subject)
        // No manual Content-Length: undici derives it from the body and
        // rejects a hand-set one ("invalid content-length header").
        const res = await doFetch(sub.endpoint, {
          method: 'POST',
          headers: {
            TTL: String(ttl),
            Urgency: urgency,
            'Content-Type': 'application/octet-stream',
            'Content-Encoding': 'aes128gcm',
            Authorization: authorization,
          },
          body,
        })
        return res.status
      } catch {
        return 0
      }
    },

    /**
     * Fan out one notification. Endpoints the push service reports gone
     * (404/410) are pruned. Resolves with `{ sent, failed, pruned }`.
     */
    async broadcast(payload, { ttl, urgency } = {}) {
      let sent = 0
      let failed = 0
      const pruned = []
      await Promise.all(
        state.subscriptions.map(async (sub) => {
          const status = await this.sendTo(sub, payload, { ttl, urgency })
          if (status >= 200 && status < 300) sent += 1
          else if (status === 404 || status === 410) {
            if (this.removeSubscription(sub.endpoint)) pruned.push(sub.endpoint)
          } else failed += 1
        }),
      )
      return { sent, failed, pruned }
    },

    /** Exposed for tests: the private KeyObject behind the stored VAPID pair. */
    _vapidPrivate() {
      return keyObject()
    },
  }
}
