// HMAC + JWT primitives for the Wrily review dispatcher.
//
// Web Crypto only — no Node `crypto`, no npm runtime deps. Works in Workers
// and any modern runtime that exposes `crypto.subtle`.

export async function verifyWebhookSignature(
  secret: string,
  body: BufferSource,
  sigHeader: string,
): Promise<boolean> {
  if (!sigHeader.startsWith("sha256=")) return false;
  const expected = hexToBytes(sigHeader.slice("sha256=".length));
  if (!expected || expected.byteLength !== 32) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, expected, body);
}

export async function mintAppJwt(privateKeyPem: string, appId: string): Promise<string> {
  const key = await importAppPrivateKey(privateKeyPem);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  // GitHub allows up to 10-minute expiry. We use 9 minutes with 30s clock-skew
  // protection, matching the n8n implementation's claims.
  const payload = { iat: now - 30, exp: now + 540, iss: Number(appId) };
  const encoder = new TextEncoder();
  const signingInput =
    b64url(encoder.encode(JSON.stringify(header))) + "." + b64url(encoder.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(signingInput),
  );
  return signingInput + "." + b64url(new Uint8Array(sig));
}

async function importAppPrivateKey(pem: string): Promise<CryptoKey> {
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const isPkcs8 = pem.includes("BEGIN PRIVATE KEY") && !isPkcs1;
  if (!isPkcs1 && !isPkcs8) {
    throw new Error("unrecognized PEM format — expected PKCS#1 or PKCS#8 RSA private key");
  }
  const der = pemBodyToBytes(pem);
  const pkcs8 = isPkcs1 ? wrapPkcs1AsPkcs8(der) : der;
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// PKCS#1 → PKCS#8 wrapper. PKCS#8 prepends:
//   SEQUENCE { INTEGER 0, AlgorithmIdentifier(rsaEncryption, NULL), OCTET STRING { <pkcs1> } }
// The AlgorithmIdentifier for rsaEncryption is a fixed 15-byte sequence.
function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const algIdentifier = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const octetHeader = derLengthHeader(0x04, pkcs1.byteLength);
  const innerLength = version.byteLength + algIdentifier.byteLength + octetHeader.byteLength + pkcs1.byteLength;
  const outerHeader = derLengthHeader(0x30, innerLength);
  const out = new Uint8Array(outerHeader.byteLength + innerLength);
  let off = 0;
  out.set(outerHeader, off); off += outerHeader.byteLength;
  out.set(version, off); off += version.byteLength;
  out.set(algIdentifier, off); off += algIdentifier.byteLength;
  out.set(octetHeader, off); off += octetHeader.byteLength;
  out.set(pkcs1, off);
  return out;
}

function derLengthHeader(tag: number, length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([tag, length]);
  if (length < 0x100) return new Uint8Array([tag, 0x81, length]);
  if (length < 0x10000) return new Uint8Array([tag, 0x82, (length >> 8) & 0xff, length & 0xff]);
  throw new Error("DER length too large for RSA private key wrapper");
}

function pemBodyToBytes(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = hexNibble(hex.charCodeAt(i * 2));
    const lo = hexNibble(hex.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

function hexNibble(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return -1;
}

function b64url(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]!);
  return btoa(str).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
