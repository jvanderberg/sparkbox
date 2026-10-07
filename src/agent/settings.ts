import { type ProviderId, providers } from "./providers/types.ts";

/**
 * Provider keys and preferences live only in this browser's localStorage.
 * They are never written into the sandbox, the project files or exports.
 */
const prefix = "sparkbox:";

function read(key: string) {
  try {
    return localStorage.getItem(prefix + key) ?? "";
  } catch {
    return "";
  }
}
function write(key: string, value: string) {
  try {
    if (value) localStorage.setItem(prefix + key, value);
    else localStorage.removeItem(prefix + key);
  } catch {
    // Private browsing or a full store: the value just does not persist.
  }
}

export const settings = {
  key(provider: ProviderId) {
    return read(`key:${provider}`);
  },
  setKey(provider: ProviderId, value: string) {
    write(`key:${provider}`, value.trim());
  },
  model(provider: ProviderId) {
    return read(`model:${provider}`) || providers[provider].defaultModel;
  },
  setModel(provider: ProviderId, value: string) {
    write(`model:${provider}`, value.trim());
  },
  provider(): ProviderId {
    const value = read("provider");
    return value in providers ? (value as ProviderId) : "sparkbox";
  },
  setProvider(value: ProviderId) {
    write("provider", value);
  },
  wispUrl() {
    return read("wisp");
  },
  setWispUrl(value: string) {
    write("wisp", value.trim());
  },
  previewOrigin() {
    return read("preview-origin");
  },
  setPreviewOrigin(value: string) {
    write("preview-origin", value.trim());
  },
  configuredProviders(): ProviderId[] {
    return (Object.keys(providers) as ProviderId[]).filter((provider) =>
      Boolean(this.key(provider)),
    );
  },
};
