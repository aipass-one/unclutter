import { browser } from "wxt/browser";
import { ANALYSIS_VERSION, unwrap, type PageState, type Reply } from "../../lib/model";
import {
  providerLabel,
  providerKeyLabel,
  resolveProvider,
  type Provider,
} from "../../lib/providers";
import "./style.css";

const get = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element: ${id}`);
  return element as T;
};
const analyze = get<HTMLButtonElement>("analyze");
const toggle = get<HTMLButtonElement>("toggle");
const global = get<HTMLInputElement>("global");
const mode = get<HTMLSelectElement>("analysis-mode");
const provider = get<HTMLSelectElement>("provider");
const errorBox = get("error");
let tabId: number | undefined;
let hasKey = false;
let connected = false;
let aipass = { connected: false, signingIn: false, error: null as string | null };
let working = false;
let savedProvider: Provider = "vercel";
let current: (PageState & { busy: boolean; error: string | null }) | null = null;
let poll: ReturnType<typeof setTimeout> | undefined;

async function request<T>(message: object): Promise<T> {
  return unwrap((await browser.runtime.sendMessage(message)) as Reply<T>);
}
function error(error: unknown) {
  errorBox.textContent =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unexpected error.";
  errorBox.hidden = false;
}
function render() {
  const busy = working || current?.busy;
  analyze.disabled = !current || !connected || !global.checked || !!busy;
  analyze.textContent = busy ? "Analyzing…" : current?.profile ? "Re-analyze" : "Analyze page";
  toggle.hidden = !current?.profile;
  toggle.disabled = !!busy || !global.checked;
  toggle.textContent = current?.profile?.enabled ? "Pause" : "Resume";
  const selectedProvider = resolveProvider(provider.value);
  provider.disabled = working || aipass.signingIn;
  const usesAiPass = selectedProvider === "aipass";
  get("key-form").hidden = usesAiPass;
  get("aipass-connection").hidden = !usesAiPass;
  const login = get<HTMLButtonElement>("aipass-login");
  login.hidden = aipass.connected;
  login.disabled = working || aipass.signingIn;
  login.textContent = aipass.signingIn
    ? "Finish sign-in in the AI Pass window…"
    : "Sign in with AI Pass";
  get("aipass-status").textContent =
    aipass.error ??
    (aipass.connected
      ? "Connected to AI Pass"
      : "Sign in securely in the AI Pass window. Then reopen Unclutter to analyze a page.");
  get("aipass-logout").hidden = !aipass.connected && !aipass.signingIn;
  get<HTMLButtonElement>("aipass-logout").disabled = working;
  get<HTMLInputElement>("api-key").placeholder = `Paste ${providerKeyLabel(selectedProvider)} key`;
  get("key-status").textContent = usesAiPass
    ? aipass.connected
      ? "AI Pass · Connected"
      : aipass.signingIn
        ? "Signing in…"
        : "Sign in with AI Pass"
    : hasKey
      ? `${providerKeyLabel(selectedProvider)} · Key saved`
      : "API key required";
  get("disclosure").textContent =
    `Analyze sends up to 60 element descriptions to ${usesAiPass ? "AI Pass and TypeSafe AI (Jev)" : providerLabel(selectedProvider)}. Main article text and form values are excluded; snippets may still contain personal data. ${usesAiPass ? "New analyses use your AI Pass balance." : "API charges apply."}`;
  get("auto-disclosure").textContent =
    `On page visit automatically sends element snippets to ${usesAiPass ? "AI Pass and TypeSafe AI (Jev)" : providerLabel(selectedProvider)} for new templates. Snippets may contain personal data. ${usesAiPass ? "Each new analysis uses your AI Pass balance." : "API charges apply."} Cached templates are reused.`;
  get("remove-key").hidden = !hasKey;
  get("disclosure").hidden = !current || mode.value === "auto";
  get("auto-disclosure").hidden = mode.value !== "auto";
  get("mode-hint").textContent =
    mode.value === "auto"
      ? "On page visit · Cached templates reused"
      : "Manual analysis · Cached rules apply automatically";
  if (!current) return;
  const { profile, context, hiddenCount } = current;
  get("host").textContent = new URL(context.origin).hostname;
  get("template").textContent = context.label;
  get("hidden").textContent = String(hiddenCount);
  get("saved").textContent = profile
    ? `Saved ${new Date(profile.analyzedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
    : "";
  const status = get("status");
  const paused = !global.checked || profile?.enabled === false;
  status.textContent = busy
    ? "Analyzing"
    : paused
      ? "Paused"
      : profile
        ? profile.analysisVersion < ANALYSIS_VERSION
          ? "Update available"
          : "Saved template"
        : "Not analyzed";
  status.className = `badge ${busy ? "busy" : profile && !paused ? "active" : ""}`;
  get("rules-section").hidden = !profile;
  get("rule-count").textContent =
    `${profile?.rules.filter((rule) => rule.enabled).length ?? 0} rules`;
  const rules = get("rules");
  rules.replaceChildren();
  if (profile && !profile.rules.length) {
    const empty = document.createElement("p");
    empty.className = "disclosure";
    empty.textContent = profile.candidateCount
      ? "No clearly removable elements found."
      : "No safely targetable elements found.";
    rules.append(empty);
  }
  for (const rule of profile?.rules ?? []) {
    const label = document.createElement("label");
    label.className = "rule";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = rule.enabled;
    checkbox.disabled = !!busy;
    checkbox.setAttribute("aria-label", `Hide ${rule.selector}`);
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = rule.category;
    const selector = document.createElement("code");
    selector.textContent = rule.selector;
    info.append(title, selector);
    label.append(checkbox, info);
    rules.append(label);
    checkbox.addEventListener(
      "change",
      () => void act({ type: "rule", tabId, selector: rule.selector, enabled: checkbox.checked }),
    );
  }
}
async function load() {
  const config = await request<{
    enabled: boolean;
    hasKey: boolean;
    connected: boolean;
    aipass: typeof aipass;
    mode: "manual" | "auto";
    provider: Provider;
  }>({
    type: "settings",
  });
  hasKey = config.hasKey;
  connected = config.connected;
  aipass = config.aipass;
  global.checked = config.enabled;
  mode.value = config.mode;
  savedProvider = resolveProvider(config.provider);
  provider.value = savedProvider;
  if (tabId !== undefined) {
    try {
      current = await request({ type: "status", tabId });
      if (current?.error) error(current.error);
    } catch (err) {
      current = null;
      get("status").textContent = "Unavailable";
      error(err);
    }
  }
  render();
  clearTimeout(poll);
  if (
    aipass.signingIn ||
    current?.busy ||
    (current &&
      !current.error &&
      config.mode === "auto" &&
      config.enabled &&
      connected &&
      current.profile?.enabled !== false &&
      (!current.profile || current.profile.analysisVersion < ANALYSIS_VERSION))
  )
    poll = setTimeout(() => void load().catch(error), 900);
}
async function act(message: object) {
  if (working) return;
  working = true;
  errorBox.hidden = true;
  get("notice").hidden = true;
  render();
  try {
    await request(message);
    await load();
  } catch (err) {
    await load().catch(() => undefined);
    provider.value = savedProvider;
    error(err);
  } finally {
    working = false;
    render();
  }
}

analyze.addEventListener("click", () => void act({ type: "analyze", tabId }));
toggle.addEventListener(
  "click",
  () => void act({ type: "toggle", tabId, enabled: !current?.profile?.enabled }),
);
global.addEventListener("change", () => void act({ type: "global", enabled: global.checked }));
mode.addEventListener("change", () => void act({ type: "mode", mode: mode.value }));
provider.addEventListener(
  "change",
  () => void act({ type: "provider", provider: resolveProvider(provider.value) }),
);
get("forget").addEventListener("click", () => void act({ type: "forget", tabId }));
get("remove-key").addEventListener("click", () => void act({ type: "removeKey" }));
get("aipass-login").addEventListener("click", () => void act({ type: "aipassLogin" }));
get("aipass-logout").addEventListener("click", () => void act({ type: "aipassLogout" }));
get("key-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = get<HTMLInputElement>("api-key");
  const key = input.value.trim();
  if (!key) {
    error(new Error(`Enter a ${providerKeyLabel(resolveProvider(provider.value))} API key.`));
    return;
  }
  void (async () => {
    await act({ type: "saveKey", key, provider: resolveProvider(provider.value) });
    input.value = "";
    if (errorBox.hidden) {
      get<HTMLDetailsElement>("connection").open = false;
      get("notice").textContent = "API key saved. Analyze a page to verify access.";
      get("notice").hidden = false;
    }
  })();
});
void (async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  await load();
  get<HTMLDetailsElement>("connection").open = !connected;
})().catch(error);
