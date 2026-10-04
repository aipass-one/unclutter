import { z } from "zod";
import config from "../.aipass/config.json";

export const AIPASS_ORIGIN = "https://aipass.one";
export const AIPASS_DECISIONS = `${AIPASS_ORIGIN}/oauth2/v1/decisions`;
export const AIPASS_MODEL = "jev-1.13";
export const AIPASS_CLIENT_ID = config.clientId;
export const AIPASS_SESSION_KEY = "aipassSession";

export async function discoverAiPassJev(): Promise<string> {
  const response = await fetch(`${AIPASS_ORIGIN}/v1/models?type=decision&method=decisions`, {
    signal: AbortSignal.timeout(10_000),
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok)
    throw new Error("AI Pass model discovery is unavailable. Please try again later.");
  const catalog = z
    .object({
      data: z.array(
        z.object({
          id: z.string(),
          type: z.string(),
          methods: z.array(z.string()),
        }),
      ),
    })
    .safeParse(await response.json());
  if (!catalog.success) throw new Error("AI Pass returned an invalid model catalog.");
  const candidates = catalog.data.data.filter(
    (model) =>
      model.type === "decision" &&
      model.methods.includes("decisions") &&
      /^jev(?:-|$)/i.test(model.id),
  );
  const model = candidates.find((model) => model.id === AIPASS_MODEL) ?? candidates[0];
  if (!model)
    throw new Error("Jev is not currently available through AI Pass. Your saved rules still work.");
  return model.id;
}

const sessionSchema = z.object({
  clientId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().finite(),
});
export type AiPassSession = z.infer<typeof sessionSchema>;
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive(),
});
export type AuthDependencies = {
  read: () => Promise<unknown>;
  write: (session: AiPassSession | null) => Promise<void>;
  redirectUrl: () => string;
  launch: (url: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
  clientId?: string;
  allowedRedirects?: string[];
  now?: () => number;
};

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function authorizationRequest(clientId: string, redirectUri: string) {
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const url = new URL(`${AIPASS_ORIGIN}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "api:access",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return { url: url.href, state, verifier };
}

export function authorizationCode(
  callback: string | undefined,
  redirectUri: string,
  state: string,
): string {
  if (!callback) throw new Error("AI Pass sign-in was cancelled. Try again when you are ready.");
  const url = new URL(callback);
  const expected = new URL(redirectUri);
  if (
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.hash ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== state
  )
    throw new Error("AI Pass sign-in could not be verified. Please try again.");
  if (url.searchParams.has("error"))
    throw new Error("AI Pass access was not granted. You can try signing in again.");
  const codes = url.searchParams.getAll("code");
  if (codes.length !== 1 || !codes[0])
    throw new Error("AI Pass did not return an authorization code.");
  return codes[0];
}

class TokenError extends Error {
  constructor(
    readonly invalidGrant: boolean,
    message: string,
  ) {
    super(message);
  }
}

// This manager lives only in the extension background. Tokens never cross the
// popup/content-script message boundary. Storage writes and refreshes serialize.
export function createAiPassAuth(deps: AuthDependencies) {
  const clientId = deps.clientId ?? AIPASS_CLIENT_ID;
  const fetcher = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let generation = 0;
  let writes: Promise<void> = Promise.resolve();
  let login: Promise<void> | null = null;
  let refreshing: Promise<string> | null = null;
  let error: string | null = null;

  const read = async () => {
    const parsed = sessionSchema.safeParse(await deps.read());
    return parsed.success && parsed.data.clientId === clientId ? parsed.data : null;
  };
  const write = (epoch: number, session: AiPassSession | null) => {
    const operation = writes.then(async () => {
      if (epoch !== generation) throw new Error("AI Pass connection changed. Please try again.");
      await deps.write(session);
    });
    writes = operation.catch(() => undefined);
    return operation;
  };
  const token = async (body: object): Promise<AiPassSession> => {
    let response: Response;
    try {
      response = await fetcher(`${AIPASS_ORIGIN}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, clientId }),
        signal: AbortSignal.timeout(20_000),
        credentials: "omit",
        redirect: "error",
      });
    } catch {
      throw new Error("Could not reach AI Pass. Check your connection and try again.");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const invalid =
        body?.error === "invalid_grant" ||
        body?.error === "invalid_client" ||
        response.status === 401;
      throw new TokenError(
        invalid,
        invalid
          ? "Your AI Pass session expired. Sign in again."
          : `AI Pass sign-in is unavailable (HTTP ${response.status}). Please try again later.`,
      );
    }
    const parsed = tokenSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success)
      throw new Error("AI Pass returned an invalid sign-in response. Please try again.");
    return {
      clientId,
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresAt: now() + parsed.data.expires_in * 1000,
    };
  };
  const revoke = async (session: AiPassSession) => {
    const results = await Promise.allSettled(
      [session.refreshToken, session.accessToken].map(async (value) => {
        const response = await fetcher(`${AIPASS_ORIGIN}/oauth2/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: value, client_id: clientId }),
          signal: AbortSignal.timeout(10_000),
          credentials: "omit",
          redirect: "error",
        });
        if (!response.ok) throw new Error("Revocation failed");
      }),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new Error(
        "Disconnected on this device. AI Pass could not confirm revocation; remove this app from your AI Pass connected apps.",
      );
  };
  const save = async (epoch: number, session: AiPassSession) => {
    try {
      await write(epoch, session);
    } catch (cause) {
      await revoke(session).catch(() => undefined);
      throw cause;
    }
  };

  return {
    revision: () => generation,
    async status() {
      const session = await read();
      return { connected: !!session, signingIn: !!login, error };
    },
    connect(): Promise<void> {
      if (login) return login;
      const epoch = ++generation;
      error = null;
      login = (async () => {
        if (!clientId)
          throw new Error(
            "This build has not been configured for AI Pass. Install the latest release.",
          );
        const redirectUri = deps.redirectUrl();
        if (!(deps.allowedRedirects ?? config.redirectUris).includes(redirectUri))
          throw new Error(
            "AI Pass login requires the official Chrome, Edge, or Brave build. This browser callback is not registered.",
          );
        const request = await authorizationRequest(clientId, redirectUri);
        let callback: string | undefined;
        try {
          callback = await deps.launch(request.url);
        } catch {
          throw new Error("AI Pass sign-in was cancelled or could not open. Please try again.");
        }
        const code = authorizationCode(callback, redirectUri, request.state);
        if (epoch !== generation) throw new Error("AI Pass sign-in was cancelled.");
        const session = await token({
          grantType: "authorization_code",
          code,
          codeVerifier: request.verifier,
          redirectUri,
        });
        await save(epoch, session);
      })()
        .catch((cause: unknown) => {
          error = cause instanceof Error ? cause.message : "AI Pass sign-in failed.";
          throw new Error(error);
        })
        .finally(() => {
          login = null;
        });
      return login;
    },
    async accessToken(): Promise<string> {
      if (refreshing) return refreshing;
      const epoch = generation;
      // Set the single-flight promise before the first storage read.
      refreshing = (async () => {
        const session = await read();
        if (epoch !== generation) throw new Error("AI Pass connection changed. Please try again.");
        if (!session) throw new Error("Sign in with AI Pass first.");
        if (session.expiresAt > now() + 60_000) return session.accessToken;
        try {
          const next = await token({
            grantType: "refresh_token",
            refreshToken: session.refreshToken,
          });
          await save(epoch, next);
          return next.accessToken;
        } catch (cause) {
          if (cause instanceof TokenError && cause.invalidGrant) await write(epoch, null);
          throw cause;
        }
      })().finally(() => {
        refreshing = null;
      });
      return refreshing;
    },
    async disconnect() {
      const epoch = ++generation;
      error = null;
      await writes;
      const session = await read();
      await write(epoch, null);
      if (session) await revoke(session);
    },
  };
}
