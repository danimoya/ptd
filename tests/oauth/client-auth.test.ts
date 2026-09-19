import { beforeAll, describe, expect, it } from "vitest";

// token.ts pulls in the drizzle client, which insists on a DATABASE_URL at
// import time. postgres-js connects lazily, so a dummy URL is enough to reach
// the pure client-authentication parsing below.
process.env.DATABASE_URL ||= "postgres://ptd:ptd@127.0.0.1:1/ptd";

type ParseClientAuth = typeof import("../../server/oauth/token")["parseClientAuth"];
let parseClientAuth: ParseClientAuth;

beforeAll(async () => {
  ({ parseClientAuth } = await import("../../server/oauth/token"));
});

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

describe("parseClientAuth", () => {
  it("reads client_secret_basic", () => {
    expect(parseClientAuth(basic("ptdc_abc", "sh h"), {})).toEqual({ clientId: "ptdc_abc", clientSecret: "sh h", via: "basic" });
  });

  it("form-decodes both halves, per RFC 6749 §2.3.1", () => {
    const header = `Basic ${Buffer.from("ptdc_a%2Bb:s%3Fcret+x").toString("base64")}`;
    expect(parseClientAuth(header, {})).toEqual({ clientId: "ptdc_a+b", clientSecret: "s?cret x", via: "basic" });
  });

  it("reads client_secret_post from the body", () => {
    expect(parseClientAuth(undefined, { client_id: "ptdc_abc", client_secret: "s3cret" }))
      .toEqual({ clientId: "ptdc_abc", clientSecret: "s3cret", via: "post" });
  });

  it("reports a public client naming itself with no secret", () => {
    expect(parseClientAuth(undefined, { client_id: "ptdc_abc" })).toEqual({ clientId: "ptdc_abc", clientSecret: undefined, via: "none" });
  });

  it("ignores a bearer header and a malformed basic header", () => {
    expect(parseClientAuth("Bearer ptd_deadbeef", { client_id: "ptdc_abc" }).via).toBe("none");
    expect(parseClientAuth(`Basic ${Buffer.from("nocolon").toString("base64")}`, {}).clientId).toBeUndefined();
  });
});
