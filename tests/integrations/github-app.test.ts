import { describe, expect, it } from "vitest";
import { createPublicKey, createVerify, generateKeyPairSync } from "crypto";

/**
 * The App's own credential and the webhook's signature — the two pieces of the GitHub
 * adapter that are pure cryptography, tested against Node's verifier rather than
 * against themselves. The RSA key is generated in the test, so no key material lives
 * in the repository.
 */

import { appJwtClaims, decodeJwtClaims, JWT_TTL_SECONDS, signAppJwt } from "../../server/integrations/github/jwt";
import { decodePrivateKey, githubAppEnv, isGithubAppConfigured, missingGithubEnv, normaliseRepo } from "../../server/integrations/github/config";
import { githubSignature, verifyGithubRequest } from "../../server/integrations/github/verify";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const NOW = Date.parse("2026-09-20T12:00:00.000Z");

describe("signAppJwt", () => {
  it("is a three-part RS256 JWT whose signature verifies with the public key", () => {
    const token = signAppJwt({ appId: "123456", privateKey: pem }, NOW);
    const [header, claims, signature] = token.split(".");
    expect(token.split(".")).toHaveLength(3);
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("does not verify once a single character of the claims is changed", () => {
    const token = signAppJwt({ appId: "123456", privateKey: pem }, NOW);
    const [header, claims, signature] = token.split(".");
    const tampered = Buffer.from(JSON.stringify({ ...appJwtClaims("999999", NOW) })).toString("base64url");
    expect(tampered).not.toBe(claims);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${tampered}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(false);
  });

  it("issues the App id, backdates iat for clock skew and stays inside GitHub's ten minutes", () => {
    const claims = decodeJwtClaims(signAppJwt({ appId: "123456", privateKey: pem }, NOW));
    expect(claims).not.toBeNull();
    const seconds = Math.floor(NOW / 1000);
    expect(claims!.iss).toBe("123456");
    expect(claims!.iat).toBeLessThan(seconds);
    expect(claims!.exp - claims!.iat).toBeLessThanOrEqual(600);
    expect(claims!.exp).toBe(seconds + JWT_TTL_SECONDS);
  });

  it("refuses to sign without an app id or a usable key", () => {
    expect(() => signAppJwt({ appId: "", privateKey: pem })).toThrow(/GITHUB_APP_ID/);
    expect(() => signAppJwt({ appId: "1", privateKey: "" })).toThrow(/GITHUB_APP_PRIVATE_KEY/);
    expect(() => signAppJwt({ appId: "1", privateKey: "not a pem" })).toThrow();
  });
});

describe("decodePrivateKey", () => {
  it("accepts a base64 blob, a raw PEM and a PEM with escaped newlines", () => {
    expect(decodePrivateKey(Buffer.from(pem).toString("base64"))).toBe(pem);
    expect(decodePrivateKey(pem)).toBe(pem);
    expect(decodePrivateKey(pem.replace(/\n/g, "\\n"))).toBe(pem);
    // A decoded blob that is not a key is not a key.
    expect(decodePrivateKey(Buffer.from("hello").toString("base64"))).toBe("");
    expect(decodePrivateKey("")).toBe("");
  });

  it("produces a key Node will actually load", () => {
    const decoded = decodePrivateKey(Buffer.from(pem).toString("base64"));
    expect(() => createPublicKey(decoded)).not.toThrow();
  });
});

describe("githubAppEnv", () => {
  it("names exactly what is missing, and is only configured when nothing is", () => {
    const saved = { ...process.env };
    try {
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      delete process.env.GITHUB_APP_SLUG;
      delete process.env.GITHUB_WEBHOOK_SECRET;
      expect(missingGithubEnv()).toEqual(["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_SLUG", "GITHUB_WEBHOOK_SECRET"]);
      expect(isGithubAppConfigured()).toBe(false);

      process.env.GITHUB_APP_ID = "123456";
      process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from(pem).toString("base64");
      process.env.GITHUB_APP_SLUG = "ptd-sync";
      process.env.GITHUB_WEBHOOK_SECRET = "whsec";
      expect(missingGithubEnv()).toEqual([]);
      expect(isGithubAppConfigured()).toBe(true);
      expect(githubAppEnv().privateKey).toBe(pem);
    } finally {
      process.env = saved;
    }
  });
});

describe("normaliseRepo", () => {
  it("takes owner/name, a URL or a .git suffix and lower-cases the result", () => {
    expect(normaliseRepo("danimoya/PTD")).toBe("danimoya/ptd");
    expect(normaliseRepo("https://github.com/danimoya/PTD")).toBe("danimoya/ptd");
    expect(normaliseRepo("https://github.com/danimoya/ptd.git")).toBe("danimoya/ptd");
    expect(normaliseRepo(" danimoya/ptd/ ")).toBe("danimoya/ptd");
  });

  it("refuses anything that is not one repository", () => {
    for (const bad of ["", "ptd", "danimoya", "danimoya/ptd/extra", "dani moya/ptd", "danimoya/ptd?x=1"]) {
      expect(normaliseRepo(bad), bad).toBeNull();
    }
  });
});

describe("verifyGithubRequest", () => {
  const BODY = JSON.stringify({ action: "opened", issue: { number: 12 } });

  it("is sha256=<hex HMAC of the exact body>", () => {
    expect(githubSignature("whsec", BODY)).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyGithubRequest({ rawBody: BODY, signature: githubSignature("whsec", BODY), secrets: ["whsec"] })).toEqual({ ok: true });
  });

  it("rejects a body changed after signing, a wrong secret and a missing header", () => {
    const signature = githubSignature("whsec", BODY);
    expect(verifyGithubRequest({ rawBody: `${BODY} `, signature, secrets: ["whsec"] })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyGithubRequest({ rawBody: BODY, signature, secrets: ["other"] })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyGithubRequest({ rawBody: BODY, signature: null, secrets: ["whsec"] })).toEqual({ ok: false, reason: "missing_signature" });
    expect(verifyGithubRequest({ rawBody: BODY, signature: "sha1=deadbeef", secrets: ["whsec"] })).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("says no_secret when the server has none, rather than pretending it is a bad signature", () => {
    expect(verifyGithubRequest({ rawBody: BODY, signature: githubSignature("x", BODY), secrets: [undefined, ""] })).toEqual({
      ok: false,
      reason: "no_secret",
    });
  });

  it("accepts a per-install secret alongside the deployment-wide one", () => {
    const signature = githubSignature("per-install", BODY);
    expect(verifyGithubRequest({ rawBody: BODY, signature, secrets: ["deployment-wide", "per-install"] })).toEqual({ ok: true });
  });

  it("accepts an upper-case hex signature (the header is hex, and hex has no case)", () => {
    const signature = githubSignature("whsec", BODY).toUpperCase().replace("SHA256=", "sha256=");
    expect(verifyGithubRequest({ rawBody: BODY, signature, secrets: ["whsec"] })).toEqual({ ok: true });
  });
});
