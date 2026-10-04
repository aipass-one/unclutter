import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  AIPASS_DECISIONS,
  AIPASS_MODEL,
  authorizationCode,
  authorizationRequest,
  createAiPassAuth,
  type AiPassSession,
  type AuthDependencies,
} from "../lib/aipass";
import { evaluate, evaluationCall, evaluationRequest } from "../lib/jev";
import { hasConnection, shouldAutoAnalyze, type Snapshot } from "../lib/model";
import { resolveProvider } from "../lib/providers";
import config from "../.aipass/config.json";

const callback = "https://test.chromiumapp.org/aipass";
const clientId = "public-test-client";
const fresh = (): AiPassSession => ({
  clientId,
  accessToken: "test-access",
  refreshToken: "test-refresh",
  expiresAt: Date.now() + 3_600_000,
});
const tokens = () =>
  Response.json({
    access_token: "rotated-access",
    refresh_token: "rotated-refresh",
    expires_in: 3600,
    token_type: "Bearer",
  });
function harness(overrides: Partial<AuthDependencies> = {}, initial: AiPassSession | null = null) {
  let stored: unknown = initial;
  const deps: AuthDependencies = {
    clientId,
    allowedRedirects: [callback],
    redirectUrl: () => callback,
    read: async () => stored,
    write: async (session) => {
      stored = session;
    },
    launch: async (url) =>
      `${callback}?code=test-code&state=${new URL(url).searchParams.get("state")}`,
    fetch: async () => tokens(),
    ...overrides,
  };
  return { auth: createAiPassAuth(deps), stored: () => stored };
}
const snapshot: Snapshot = {
  url: "https://example.com/private?secret=private",
  context: { key: "synthetic", kind: "article", label: "article", origin: "https://example.com" },
  candidates: [
    {
      id: "e0",
      selector: "div.ad-banner",
      tag: "div",
      signals: "advertisement",
      text: "Advertisement",
      position: "static",
      count: 1,
    },
  ],
};

test("Chrome identity is stable and the public callback matches the manifest key", () => {
  const id = createHash("sha256")
    .update(Buffer.from(config.chromiumPublicKey, "base64"))
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
  assert.equal(id, config.chromiumExtensionId);
  assert.deepEqual(config.redirectUris, [`https://${id}.chromiumapp.org/aipass`]);
  assert.ok(!JSON.stringify(config).includes("PRIVATE KEY"));
});

test("PKCE uses random independent state/verifier and an S256 challenge", async () => {
  const request = await authorizationRequest(clientId, callback);
  const params = new URL(request.url).searchParams;
  assert.equal(new URL(request.url).origin, "https://aipass.one");
  assert.equal(params.get("scope"), "api:access");
  assert.equal(params.get("redirect_uri"), callback);
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.equal(
    params.get("code_challenge"),
    createHash("sha256").update(request.verifier).digest("base64url"),
  );
  assert.equal(request.verifier.length, 43);
  assert.notEqual(request.state, request.verifier);
  assert.notEqual(request.state, (await authorizationRequest(clientId, callback)).state);
  assert.equal(params.has("code_verifier"), false);
});

test("callbacks reject missing, mismatched, duplicated, and denied authorization", () => {
  assert.equal(authorizationCode(`${callback}?state=expected&code=ok`, callback, "expected"), "ok");
  for (const url of [
    undefined,
    `${callback}?state=bad&code=ok`,
    `${callback}?state=expected&state=expected&code=ok`,
    `${callback}?state=expected&code=a&code=b`,
    `${callback}?state=expected&error=access_denied`,
    `${callback}?state=expected`,
    `${callback}/wrong?state=expected&code=ok`,
    `https://attacker.example/aipass?state=expected&code=ok`,
    `${callback}?state=expected&code=ok#token=bad`,
  ])
    assert.throws(() => authorizationCode(url, callback, "expected"));
});

test("login exchanges camel-case PKCE fields; status exposes no credentials", async () => {
  let calls = 0;
  let verifier = "";
  const h = harness({
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, "https://aipass.one/oauth2/token");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.grantType, "authorization_code");
      assert.equal(body.code, "test-code");
      assert.equal(body.redirectUri, callback);
      assert.equal(body.clientId, clientId);
      verifier = body.codeVerifier;
      assert.equal(body.clientSecret, undefined);
      assert.equal(init?.redirect, "error");
      return tokens();
    },
  });
  const one = h.auth.connect();
  assert.equal(h.auth.connect(), one);
  await one;
  assert.equal(calls, 1);
  assert.equal(verifier.length, 43);
  assert.deepEqual(await h.auth.status(), { connected: true, signingIn: false, error: null });
  assert.equal(await h.auth.accessToken(), "rotated-access");
  assert.equal(calls, 1);
});

test("unregistered browser callbacks and unconfigured builds fail before opening login", async () => {
  for (const overrides of [
    { redirectUrl: () => "https://wrong.chromiumapp.org/aipass" },
    { clientId: "" },
  ]) {
    const h = harness({
      ...overrides,
      launch: async () => {
        assert.fail("Must not launch");
      },
    });
    await assert.rejects(h.auth.connect());
    assert.equal(h.stored(), null);
  }
});

test("cancelled login persists understandable status without logging raw browser errors", async () => {
  const h = harness({
    launch: async () => {
      throw new Error("private-browser-error");
    },
  });
  await assert.rejects(h.auth.connect(), /cancelled/);
  const status = await h.auth.status();
  assert.equal(status.connected, false);
  assert.equal(status.signingIn, false);
  assert.ok(!JSON.stringify(status).includes("private-browser-error"));
});

test("expired sessions rotate once across concurrent callers and survive reopening", async () => {
  let calls = 0;
  const h = harness(
    {
      fetch: async (_url, init) => {
        calls++;
        assert.deepEqual(JSON.parse(String(init?.body)), {
          grantType: "refresh_token",
          refreshToken: "test-refresh",
          clientId,
        });
        return tokens();
      },
    },
    { ...fresh(), expiresAt: 0 },
  );
  assert.deepEqual(
    await Promise.all([h.auth.accessToken(), h.auth.accessToken(), h.auth.accessToken()]),
    Array(3).fill("rotated-access"),
  );
  assert.equal(calls, 1);
  assert.equal((h.stored() as AiPassSession).refreshToken, "rotated-refresh");
  const reopened = harness(
    {
      fetch: async () => {
        assert.fail("Still valid");
      },
    },
    h.stored() as AiPassSession,
  );
  assert.equal(await reopened.auth.accessToken(), "rotated-access");
});

test("invalid refresh grant removes dead tokens but temporary failure keeps recoverable session", async () => {
  for (const status of [400, 503]) {
    const h = harness(
      {
        fetch: async () =>
          Response.json(
            { error: status === 400 ? "invalid_grant" : "server_error", private: "must-not-leak" },
            { status },
          ),
      },
      { ...fresh(), expiresAt: 0 },
    );
    await assert.rejects(
      h.auth.accessToken(),
      (error: Error) => !error.message.includes("must-not-leak"),
    );
    assert.equal((await h.auth.status()).connected, status === 503);
  }
});

test("disconnect revokes both tokens and clears local session even on network failure", async () => {
  const revoked: string[] = [];
  const h = harness(
    {
      fetch: async (url, init) => {
        assert.equal(url, "https://aipass.one/oauth2/revoke");
        revoked.push(new URLSearchParams(String(init?.body)).get("token")!);
        throw new Error("offline");
      },
    },
    fresh(),
  );
  await assert.rejects(h.auth.disconnect(), /Disconnected on this device/);
  assert.deepEqual(revoked.sort(), ["test-access", "test-refresh"]);
  assert.equal(h.stored(), null);
});

test("disconnect during refresh cannot resurrect tokens and revokes the rotated pair", async () => {
  let resolve!: (value: Response) => void;
  let started!: () => void;
  const requestStarted = new Promise<void>((r) => {
    started = r;
  });
  const response = new Promise<Response>((r) => {
    resolve = r;
  });
  const revoked: string[] = [];
  const h = harness(
    {
      fetch: async (url, init) => {
        if (String(url).endsWith("/token")) {
          started();
          return response;
        }
        revoked.push(new URLSearchParams(String(init?.body)).get("token")!);
        return new Response(null, { status: 200 });
      },
    },
    { ...fresh(), expiresAt: 0 },
  );
  const pending = h.auth.accessToken();
  await requestStarted;
  await h.auth.disconnect();
  resolve(tokens());
  await assert.rejects(pending, /connection changed/);
  assert.equal(h.stored(), null);
  assert.ok(revoked.includes("rotated-access"));
  assert.ok(revoked.includes("rotated-refresh"));
});

test("disconnect while login is open prevents token exchange", async () => {
  let resolve!: (callback: string) => void;
  let launched!: (url: string) => void;
  const started = new Promise<string>((r) => {
    launched = r;
  });
  const h = harness({
    launch: async (url) => {
      launched(url);
      return new Promise<string>((r) => {
        resolve = r;
      });
    },
    fetch: async () => {
      assert.fail("Cancelled login must not exchange");
    },
  });
  const login = h.auth.connect();
  const url = await started;
  await h.auth.disconnect();
  resolve(`${callback}?state=${new URL(url).searchParams.get("state")}&code=test`);
  await assert.rejects(login, /cancelled/);
  assert.equal(h.stored(), null);
});

test("existing provider defaults and automatic opt-in are preserved", () => {
  assert.equal(resolveProvider(undefined), "vercel");
  assert.equal(resolveProvider("aipass"), "aipass");
  assert.equal(resolveProvider("typesafe"), "typesafe");
  const settings = {
    provider: "aipass" as const,
    apiKey: "unrelated-provider-key",
    enabled: true,
    mode: "manual" as const,
    aipassConnected: false,
  };
  assert.equal(hasConnection(settings), false);
  assert.equal(shouldAutoAnalyze({ ...settings, aipassConnected: true }, null, false), false);
  assert.equal(
    shouldAutoAnalyze({ ...settings, mode: "auto", aipassConnected: true }, null, false),
    true,
  );
  assert.equal(
    shouldAutoAnalyze({ ...settings, mode: "auto", aipassConnected: true }, null, true),
    false,
  );
});

test("AI Pass sends Jev's native decision schema with OAuth client binding, without page URLs or Gateway headers", () => {
  const call = evaluationCall(snapshot, "test-oauth-token", "aipass", clientId);
  assert.equal(call.url, AIPASS_DECISIONS);
  assert.deepEqual(call.init.headers, {
    Authorization: "Bearer test-oauth-token",
    "Content-Type": "application/json",
    "X-AIPass-OAuth-Client-Id": clientId,
  });
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    ...evaluationRequest(snapshot),
    model: AIPASS_MODEL,
  });
  assert.equal(call.init.redirect, "error");
  assert.ok(!String(call.init.body).includes("private"));
});

test("AI Pass analysis discovers Jev and sends exactly one paid request, including on errors", async (t) => {
  let status = 200;
  const fetch = t.mock.method(globalThis, "fetch", async (url: unknown) =>
    String(url).includes("/v1/models")
      ? Response.json({ data: [{ id: AIPASS_MODEL, type: "decision", methods: ["decisions"] }] })
      : status === 200
        ? Response.json({
            answers: {
              e0: { type: "choice", choice: "ad", confidence: 0.99, probabilities: { ad: 0.99 } },
            },
            usage: { input_tokens: 100, output_tokens: 0 },
          })
        : new Response("private upstream data", { status }),
  );
  assert.deepEqual(await evaluate(snapshot, "test-oauth-token", "aipass", clientId), [
    { selector: "div.ad-banner", category: "ad", enabled: true },
  ]);
  for (status of [401, 402, 403, 429, 500])
    await assert.rejects(
      evaluate(snapshot, "test-oauth-token", "aipass", clientId),
      (error: Error) =>
        error.message.includes(`HTTP ${status}`) && !error.message.includes("private upstream"),
    );
  assert.equal(
    fetch.mock.calls.filter((call) => String(call.arguments[0]) === AIPASS_DECISIONS).length,
    6,
  );
});

test("missing Jev fails before any paid request; a new published Jev version is discovered", async (t) => {
  let models = [{ id: "other-decider", type: "decision", methods: ["decisions"] }];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("/v1/models")) return Response.json({ data: models });
    calls++;
    assert.equal(JSON.parse(String(init?.body)).model, "jev-next");
    return Response.json({ answers: { e0: { type: "choice", choice: "keep" } } });
  });
  await assert.rejects(
    evaluate(snapshot, "test-oauth-token", "aipass", clientId),
    /not currently available/,
  );
  assert.equal(calls, 0);
  models = [{ id: "jev-next", type: "decision", methods: ["decisions"] }];
  assert.deepEqual(await evaluate(snapshot, "test-oauth-token", "aipass", clientId), []);
  assert.equal(calls, 1);
});
