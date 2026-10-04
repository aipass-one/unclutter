# AI Pass integration

This AI Pass integration is maintained at [aipass-one/unclutter](https://github.com/aipass-one/unclutter), a fork of [Kitze's Unclutter](https://github.com/kitze/unclutter). The original MIT license and attribution are preserved.

## Install in Chrome, Edge, or Brave

1. Download the Chrome ZIP from [Releases](https://github.com/aipass-one/unclutter/releases/latest) and extract it into a folder you will keep.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted folder containing `manifest.json`.
3. Pin **Unclutter**, then refresh the website you want to clean up.
4. Open the extension, expand **Connection**, select **AI Pass**, and click **Sign in with AI Pass**. Finish signing in and granting app access in the AI Pass window.
5. Reopen the extension and click **Analyze page**. Saved cleanup rules apply on later visits without a new model call.

No Node, Bun, API key, or client-secret setup is needed for a configured release. This is a manual Developer mode installation, not a Chrome Web Store listing. Chrome will not automatically update it: replace the extracted files with a new release, click **Reload** on the extension card, and refresh website tabs. Keep the same public manifest key so the extension ID and local settings stay stable.

Analysis starts in **Manual** mode. **On page visit** is an explicit opt-in to paid analysis for new page templates. Cached rules continue working while signed out. Disconnecting leaves those rules and other providers' saved keys intact.

## Architecture

Manifest V3 does not permit remotely hosted JavaScript. The extension therefore uses the browser's native `identity.launchWebAuthFlow` with authorization-code PKCE (`S256`), rather than injecting the hosted AI Pass SDK. It requests only `api:access`.

- Authorization: `https://aipass.one/oauth2/authorize`
- Token exchange and rotation: `https://aipass.one/oauth2/token` (AI Pass camel-case JSON fields)
- Decisions: `https://aipass.one/oauth2/v1/decisions`, discovering a published Jev decision model from `/v1/models?type=decision&method=decisions` and using `X-AIPass-OAuth-Client-Id`
- Disconnect: revoke both refresh and access tokens at `/oauth2/revoke`; clear the local session even if remote revocation fails and show a recovery message.

State and the exact callback are validated before exchanging a code. Concurrent refreshes share one request and store the rotated pair atomically. Disconnect invalidates pending login/refresh work, so it cannot recreate a session. A failed or timed-out paid request is never automatically retried.

The popup receives connection status only. OAuth tokens are stored in local extension storage, not encrypted or synced; Chrome restricts this storage to trusted extension contexts. The background worker owns token exchange, refresh, revocation, and model calls. Neither content scripts nor websites receive credentials. A saved API key is bound to its original provider, including across AI Pass login and provider switching; an unknown provider cannot fall back to sending its key to Gateway. Closing the popup during login is expected: the background completes the flow, and reopening the popup reads the saved connection.

Analysis sends bounded candidate descriptions to AI Pass, which routes them to TypeSafe AI. It does not send the full URL, cookies, form values, or main article body. Snippets may still contain personal data. The original reversible hiding, protected-content checks, conservative answer validation, and offline template cache are retained. Hiding cookie dialogs is not rejecting cookies; hiding ads does not block network requests.

## Maintainers

`.aipass/config.json` contains public configuration only: the project fingerprint, public OAuth client ID, public Chrome manifest key, extension ID, and exact callback. The key is not a secret or an authentication credential. Never publish `.aipass/project-grant.json`: it is a protected setup-recovery record, ignored by Git and excluded from builds.

Register the exact callback from this file through the [AI Pass integration setup flow](https://aipass.one/skills/aipass-integration/SKILL.md), then retain the returned public `clientId`. Never embed a client secret, provider key, or operator token. A Chrome Web Store release will need the store-assigned public key and its exact callback approved on the same OAuth client before distribution.

The AI Pass callback in this release targets Chromium. Firefox builds retain the Vercel and TypeSafe providers; AI Pass login reports that its Firefox callback is not registered. A future Firefox release needs its own browser identity callback added to the same public client.

Checks: `bun install --frozen-lockfile`, `bun run check`, `bun run build`, `bun run build:firefox`. `bun run zip` produces the Chromium install ZIP. Unit tests cover PKCE, callback validation, refresh rotation, cancellation, disconnect races, provider migration, request binding, and fail-closed decision parsing. Live wallet-funded verification is a separate step from tests using synthetic responses.
