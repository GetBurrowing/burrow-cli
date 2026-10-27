/**
 * Wire crypto for the remote terminal, protocol v1.
 *
 * X25519 ECDH, then HKDF-SHA256 (salt = session id, info = a direction label)
 * into two AES-256-GCM keys. AES-GCM because WebCrypto has no ChaCha20.
 *
 * WHAT THIS PROTECTS. The keys are ephemeral and unauthenticated: they keep a
 * PASSIVE relay (its logs, its database dumps, an operator reading traffic)
 * from reading the stream. They do not stop a relay that actively swaps the
 * `hello` keys for its own. A fingerprint check is a follow-up.
 *
 * A frame is `counter (8 bytes, big-endian) || ciphertext || tag`. The nonce is
 * `direction id (4 bytes) || counter (8 bytes)`. A receiver rejects any counter
 * that is not strictly greater than the last one it accepted.
 *
 * The plaintext of every frame is `kind (1 byte) || body`: kind 0 is raw
 * terminal bytes, kind 1 is a JSON control record.
 */
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from "node:crypto";

export const INFO_CLI_TO_BROWSER = "burrow-terminal v1 cli->browser";
export const INFO_BROWSER_TO_CLI = "burrow-terminal v1 browser->cli";
export const DIR_CLI_TO_BROWSER = 1;
export const DIR_BROWSER_TO_CLI = 2;
export const KIND_DATA = 0;
export const KIND_CONTROL = 1;

const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export interface KeyPair {
  /** 32 raw bytes. */
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const pub = publicKey.export({ format: "der", type: "spki" });
  const priv = privateKey.export({ format: "der", type: "pkcs8" });
  return { publicKey: new Uint8Array(pub.subarray(pub.length - 32)), privateKey: new Uint8Array(priv.subarray(priv.length - 32)) };
}

/** The raw public key for a raw private key (used by the vector file). */
export function publicKeyOf(privateKey: Uint8Array): Uint8Array {
  const k = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, privateKey]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(k).export({ format: "der", type: "spki" });
  return new Uint8Array(spki.subarray(spki.length - 32));
}

export interface SessionKeys {
  /** Seals what the CLI sends. */
  send: Uint8Array;
  /** Opens what the browser sends. */
  recv: Uint8Array;
}

export function deriveKeys(role: "cli" | "browser", ownPrivate: Uint8Array, peerPublic: Uint8Array, sessionId: string): SessionKeys {
  if (peerPublic.length !== 32) throw new Error("peer public key must be 32 bytes");
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, ownPrivate]), format: "der", type: "pkcs8" });
  const pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, peerPublic]), format: "der", type: "spki" });
  const shared = diffieHellman({ privateKey: priv, publicKey: pub });
  const derive = (info: string) => new Uint8Array(hkdfSync("sha256", shared, Buffer.from(sessionId, "utf8"), Buffer.from(info, "utf8"), 32));
  const c2b = derive(INFO_CLI_TO_BROWSER);
  const b2c = derive(INFO_BROWSER_TO_CLI);
  return role === "cli" ? { send: c2b, recv: b2c } : { send: b2c, recv: c2b };
}

export function nonceFor(direction: number, counter: bigint): Buffer {
  const n = Buffer.alloc(12);
  n.writeUInt32BE(direction, 0);
  n.writeBigUInt64BE(counter, 4);
  return n;
}

/** Seal `plaintext` as frame number `counter`. */
export function sealFrame(key: Uint8Array, direction: number, counter: bigint, plaintext: Uint8Array): Uint8Array {
  const c = createCipheriv("aes-256-gcm", key, nonceFor(direction, counter));
  const body = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(8);
  head.writeBigUInt64BE(counter, 0);
  return new Uint8Array(Buffer.concat([head, body]));
}

/** Open a frame. Throws on a short frame or a failed tag. Counter policy is the caller's ({@link Receiver}). */
export function openFrame(key: Uint8Array, direction: number, frame: Uint8Array): { counter: bigint; plaintext: Uint8Array } {
  if (frame.length < 8 + 16) throw new Error("frame too short");
  const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.length);
  const counter = buf.readBigUInt64BE(0);
  const d = createDecipheriv("aes-256-gcm", key, nonceFor(direction, counter));
  d.setAuthTag(buf.subarray(buf.length - 16));
  const plaintext = Buffer.concat([d.update(buf.subarray(8, buf.length - 16)), d.final()]);
  return { counter, plaintext: new Uint8Array(plaintext) };
}

/** Seals a stream of records with a rising counter. */
export class Sender {
  private next = 0n;
  constructor(private readonly key: Uint8Array, private readonly direction: number) {}
  seal(kind: number, body: Uint8Array): Uint8Array {
    const plain = new Uint8Array(1 + body.length);
    plain[0] = kind;
    plain.set(body, 1);
    const frame = sealFrame(this.key, this.direction, this.next, plain);
    this.next += 1n;
    return frame;
  }
}

/** Opens a stream of records and rejects any counter that does not rise. */
export class Receiver {
  private last = -1n;
  constructor(private readonly key: Uint8Array, private readonly direction: number) {}
  /** Null when the frame is replayed, reordered, truncated or forged. */
  open(frame: Uint8Array): { kind: number; body: Uint8Array } | null {
    if (frame.length < 8) return null;
    const counter = Buffer.from(frame.buffer, frame.byteOffset, frame.length).readBigUInt64BE(0);
    if (counter <= this.last) return null;
    let opened: { counter: bigint; plaintext: Uint8Array };
    try {
      opened = openFrame(this.key, this.direction, frame);
    } catch {
      return null;
    }
    // Only an authentic frame advances the counter, so a forgery cannot
    // lock out the real stream by claiming a huge one.
    this.last = counter;
    if (opened.plaintext.length < 1) return null;
    return { kind: opened.plaintext[0] ?? 0, body: opened.plaintext.subarray(1) };
  }
}

export const toB64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
export const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));
