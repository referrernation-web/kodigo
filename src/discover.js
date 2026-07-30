import { saveConfig } from "./config.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function fetchModels({ baseURL, apiKey }) {
  const headers = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  let res;
  try {
    res = await fetch(`${baseURL}/models`, { headers, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new Error(`Cannot reach ${baseURL}: ${e.message}`);
  }
  if (!res.ok) {
    const hint =
      res.status === 401
        ? " (key rejected — check that the key matches this endpoint's provider)"
        : res.status === 404
          ? " (no /models endpoint — the baseURL may be wrong; it should end in /v1)"
          : "";
    throw new Error(`/models returned ${res.status}${hint}`);
  }
  const json = await res.json();
  const models = (json.data || []).map((m) => m.id).filter(Boolean).sort();
  if (!models.length) throw new Error("Endpoint returned zero models");
  return models;
}

export async function discoverModels(config, { force = false } = {}) {
  const cache = config.modelsCache;
  const fresh =
    !force &&
    cache &&
    cache.baseURL === config.baseURL &&
    Date.now() - new Date(cache.fetchedAt).getTime() < CACHE_TTL_MS;
  if (fresh) return cache.models;
  const models = await fetchModels(config);
  saveConfig({ modelsCache: { baseURL: config.baseURL, models, fetchedAt: new Date().toISOString() } });
  config.modelsCache = { baseURL: config.baseURL, models, fetchedAt: new Date().toISOString() };
  return models;
}
