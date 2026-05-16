import { describe, expect, it } from "vitest";
import { mintAppJwt, verifyWebhookSignature } from "../src/crypto.js";
import { TEST_PKCS1_PEM, TEST_PKCS8_PEM, importTestPublicKey } from "./fixtures.js";

describe("verifyWebhookSignature", () => {
  const secret = "test-webhook-secret-do-not-use-in-prod";
  const body = new TextEncoder().encode(JSON.stringify({ action: "opened", number: 42 }));

  async function signBody(secretValue: string, payload: Uint8Array): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secretValue),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, payload);
    return "sha256=" + Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  it("returns true for a valid sha256 signature over the raw body", async () => {
    const header = await signBody(secret, body);
    expect(await verifyWebhookSignature(secret, body, header)).toBe(true);
  });

  it("returns false when the signature is for a different body", async () => {
    const header = await signBody(secret, new TextEncoder().encode("different"));
    expect(await verifyWebhookSignature(secret, body, header)).toBe(false);
  });

  it("returns false when the secret is wrong", async () => {
    const header = await signBody("wrong-secret", body);
    expect(await verifyWebhookSignature(secret, body, header)).toBe(false);
  });

  it("returns false for a missing or unsupported signature header", async () => {
    expect(await verifyWebhookSignature(secret, body, "")).toBe(false);
    expect(await verifyWebhookSignature(secret, body, "sha1=deadbeef")).toBe(false);
    expect(await verifyWebhookSignature(secret, body, "sha256=not-hex")).toBe(false);
  });

  it("returns false when the signature length doesn't match", async () => {
    expect(await verifyWebhookSignature(secret, body, "sha256=ab")).toBe(false);
  });
});

describe("mintAppJwt", () => {
  const appId = "1234567";

  async function verifyJwt(jwt: string, publicKey: CryptoKey): Promise<{ header: any; payload: any }> {
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
    const data = new TextEncoder().encode(headerB64 + "." + payloadB64);
    const sig = b64urlToBytes(sigB64);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, sig, data);
    expect(ok).toBe(true);
    return {
      header: JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64))),
      payload: JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64))),
    };
  }

  it("produces a JWT verifiable with the matching public key (PKCS#1 input)", async () => {
    const jwt = await mintAppJwt(TEST_PKCS1_PEM, appId);
    const { header, payload } = await verifyJwt(jwt, await importTestPublicKey());
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe(Number(appId));
    const now = Math.floor(Date.now() / 1000);
    expect(payload.iat).toBeLessThanOrEqual(now);
    expect(payload.exp).toBeGreaterThan(now);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
  });

  it("produces a JWT verifiable with the matching public key (PKCS#8 input)", async () => {
    const jwt = await mintAppJwt(TEST_PKCS8_PEM, appId);
    const { payload } = await verifyJwt(jwt, await importTestPublicKey());
    expect(payload.iss).toBe(Number(appId));
  });

  it("rejects an unrecognized PEM format", async () => {
    await expect(mintAppJwt("-----BEGIN GARBAGE-----\nABCD\n-----END GARBAGE-----\n", appId))
      .rejects.toThrow(/PEM/i);
  });
});

function b64urlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
