import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

export const DEFAULT_CONFIG = Object.freeze({
  agnes: {
    baseURL: "https://api.agnes-ai.cn/v1",
    apiKey: "",
    model: "agnes-3.0-flash",
    maxTokens: 8192,
    temperature: 0.2,
    thinking: true,
    chatTemplateKwargs: {}
  },
  agent: {
    maxTurns: 18,
    postActionWaitMs: 600,
    coordinateMode: "millifraction",
    imageInputFormat: "data_url",
    publicBaseUrl: "",
    saveCaptures: true,
    captureDir: "./captures",
    imageMaxEdge: 0,
    observationFrame: false,
    pointTargetGuard: false,
    maxScreenshotsInContext: 2,
    waitForStable: true,
    maxPostActionWaitMs: 3000,
    inputDispatch: "foreground",
    foregroundGuard: true,
    focusBeforeInput: true,
    inputChunkDelayMs: 12,
    browserBackend: "off",
    cdpHost: "127.0.0.1",
    cdpPort: 9222,
    memoryEnabled: true,
    memoryMaxItems: 3,
    memoryFile: "./memory.jsonl",
    traceEnabled: true,
    traceFile: "./traces.jsonl",
    sessionFile: "./sessions.jsonl",
    sessionHistoryLimit: 20,
    persistent: {
      defaultIntervalMs: 5000,
      minIntervalMs: 3000,
      intervalJitterMs: 1500,
      maxDurationMs: 7200000,
      maxActions: 200,
      maxSendsPerHour: 60,
      maxContextMessages: 40,
      captureOnIdle: true
    }
  },
  server: {
    host: "127.0.0.1",
    port: 3737
  }
});

export function defaultConfigPath() {
  return fileURLToPath(new URL("./standalone.config.json", import.meta.url));
}

export async function loadConfig(configPath = defaultConfigPath()) {
  await ensureConfigFile(configPath);
  const raw = await readJson(configPath);
  return applyEnvOverrides(normalizeConfig(raw, configPath), configPath);
}

export async function updateConfig(patch, configPath = defaultConfigPath()) {
  await ensureConfigFile(configPath);
  // Merge from the file, not from loadConfig(): environment overrides must never be persisted.
  const current = normalizeConfig(await readJson(configPath), configPath);
  const next = normalizeConfig(deepMerge(current, patch), configPath);
  await writeJson(configPath, next);
  return applyEnvOverrides(next, configPath);
}

export function sanitizeConfig(config) {
  const key = config.agnes.apiKey;
  return {
    ...config,
    agnes: {
      ...config.agnes,
      apiKey: "",
      hasApiKey: key.trim() !== "",
      apiKeyMasked: maskSecret(key)
    }
  };
}

export function resolveCaptureDir(config, configPath = defaultConfigPath()) {
  const configured = config.agent.captureDir;
  if (isAbsolute(configured)) return configured;
  return resolve(dirname(configPath), configured);
}

export function resolveMemoryFile(config, configPath = defaultConfigPath()) {
  const configured = config.agent.memoryFile;
  if (isAbsolute(configured)) return configured;
  return resolve(dirname(configPath), configured);
}

export function resolveTraceFile(config, configPath = defaultConfigPath()) {
  const configured = config.agent.traceFile;
  if (isAbsolute(configured)) return configured;
  return resolve(dirname(configPath), configured);
}

export function resolveSessionFile(config, configPath = defaultConfigPath()) {
  const configured = config.agent.sessionFile;
  if (isAbsolute(configured)) return configured;
  return resolve(dirname(configPath), configured);
}

async function ensureConfigFile(configPath) {
  try {
    await readFile(configPath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) throw error;
    await mkdir(dirname(configPath), { recursive: true });
    await writeJson(configPath, DEFAULT_CONFIG);
  }
}

async function readJson(path) {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeConfig(value, configPath) {
  const input = isPlainObject(value) ? value : {};
  const agnesInput = isPlainObject(input.agnes) ? input.agnes : {};
  const agentInput = isPlainObject(input.agent) ? input.agent : {};
  const persistentInput = isPlainObject(agentInput.persistent) ? agentInput.persistent : {};
  const serverInput = isPlainObject(input.server) ? input.server : {};
  const normalized = {
    agnes: {
      baseURL: normalizeUrl(agnesInput.baseURL, DEFAULT_CONFIG.agnes.baseURL),
      apiKey: normalizeString(agnesInput.apiKey, DEFAULT_CONFIG.agnes.apiKey),
      model: normalizeString(agnesInput.model, DEFAULT_CONFIG.agnes.model),
      maxTokens: normalizeInteger(agnesInput.maxTokens, DEFAULT_CONFIG.agnes.maxTokens, 128, 65536),
      temperature: normalizeNumber(agnesInput.temperature, DEFAULT_CONFIG.agnes.temperature, 0, 2),
      thinking: normalizeBoolean(agnesInput.thinking, DEFAULT_CONFIG.agnes.thinking),
      chatTemplateKwargs: isPlainObject(agnesInput.chatTemplateKwargs) ? agnesInput.chatTemplateKwargs : {}
    },
    agent: {
      maxTurns: normalizeInteger(agentInput.maxTurns, DEFAULT_CONFIG.agent.maxTurns, 1, 100),
      postActionWaitMs: normalizeInteger(agentInput.postActionWaitMs, DEFAULT_CONFIG.agent.postActionWaitMs, 0, 60000),
      coordinateMode: normalizeEnum(agentInput.coordinateMode, ["millifraction"], DEFAULT_CONFIG.agent.coordinateMode),
      imageInputFormat: normalizeEnum(agentInput.imageInputFormat, ["data_url", "url"], DEFAULT_CONFIG.agent.imageInputFormat),
      publicBaseUrl: normalizeOptionalUrl(agentInput.publicBaseUrl, DEFAULT_CONFIG.agent.publicBaseUrl),
      saveCaptures: normalizeBoolean(agentInput.saveCaptures, DEFAULT_CONFIG.agent.saveCaptures),
      captureDir: normalizeNonEmptyPath(agentInput.captureDir, DEFAULT_CONFIG.agent.captureDir),
      imageMaxEdge: normalizeInteger(agentInput.imageMaxEdge, DEFAULT_CONFIG.agent.imageMaxEdge, 0, 8192),
      observationFrame: normalizeBoolean(agentInput.observationFrame, DEFAULT_CONFIG.agent.observationFrame),
      pointTargetGuard: normalizeBoolean(agentInput.pointTargetGuard, DEFAULT_CONFIG.agent.pointTargetGuard),
      maxScreenshotsInContext: normalizeInteger(agentInput.maxScreenshotsInContext, DEFAULT_CONFIG.agent.maxScreenshotsInContext, 0, 20),
      waitForStable: normalizeBoolean(agentInput.waitForStable, DEFAULT_CONFIG.agent.waitForStable),
      maxPostActionWaitMs: normalizeInteger(agentInput.maxPostActionWaitMs, DEFAULT_CONFIG.agent.maxPostActionWaitMs, 0, 30000),
      inputDispatch: normalizeEnum(agentInput.inputDispatch, ["foreground", "background"], DEFAULT_CONFIG.agent.inputDispatch),
      foregroundGuard: normalizeBoolean(agentInput.foregroundGuard, DEFAULT_CONFIG.agent.foregroundGuard),
      focusBeforeInput: normalizeBoolean(agentInput.focusBeforeInput, DEFAULT_CONFIG.agent.focusBeforeInput),
      inputChunkDelayMs: normalizeInteger(agentInput.inputChunkDelayMs, DEFAULT_CONFIG.agent.inputChunkDelayMs, 0, 500),
      browserBackend: normalizeEnum(agentInput.browserBackend, ["off", "cdp"], DEFAULT_CONFIG.agent.browserBackend),
      cdpHost: normalizeString(agentInput.cdpHost, DEFAULT_CONFIG.agent.cdpHost),
      cdpPort: normalizeInteger(agentInput.cdpPort, DEFAULT_CONFIG.agent.cdpPort, 1, 65535),
      memoryEnabled: normalizeBoolean(agentInput.memoryEnabled, DEFAULT_CONFIG.agent.memoryEnabled),
      memoryMaxItems: normalizeInteger(agentInput.memoryMaxItems, DEFAULT_CONFIG.agent.memoryMaxItems, 1, 10),
      memoryFile: normalizeNonEmptyPath(agentInput.memoryFile, DEFAULT_CONFIG.agent.memoryFile),
      traceEnabled: normalizeBoolean(agentInput.traceEnabled, DEFAULT_CONFIG.agent.traceEnabled),
      traceFile: normalizeNonEmptyPath(agentInput.traceFile, DEFAULT_CONFIG.agent.traceFile),
      sessionFile: normalizeNonEmptyPath(agentInput.sessionFile, DEFAULT_CONFIG.agent.sessionFile),
      sessionHistoryLimit: normalizeInteger(agentInput.sessionHistoryLimit, DEFAULT_CONFIG.agent.sessionHistoryLimit, 1, 100),
      persistent: {
        defaultIntervalMs: normalizeInteger(persistentInput.defaultIntervalMs, DEFAULT_CONFIG.agent.persistent.defaultIntervalMs, 1000, 600000),
        minIntervalMs: normalizeInteger(persistentInput.minIntervalMs, DEFAULT_CONFIG.agent.persistent.minIntervalMs, 500, 600000),
        intervalJitterMs: normalizeInteger(persistentInput.intervalJitterMs, DEFAULT_CONFIG.agent.persistent.intervalJitterMs, 0, 60000),
        maxDurationMs: normalizeInteger(persistentInput.maxDurationMs, DEFAULT_CONFIG.agent.persistent.maxDurationMs, 60000, 86400000),
        maxActions: normalizeInteger(persistentInput.maxActions, DEFAULT_CONFIG.agent.persistent.maxActions, 1, 10000),
        maxSendsPerHour: normalizeInteger(persistentInput.maxSendsPerHour, DEFAULT_CONFIG.agent.persistent.maxSendsPerHour, 1, 10000),
        maxContextMessages: normalizeInteger(persistentInput.maxContextMessages, DEFAULT_CONFIG.agent.persistent.maxContextMessages, 8, 200),
        captureOnIdle: normalizeBoolean(persistentInput.captureOnIdle, DEFAULT_CONFIG.agent.persistent.captureOnIdle)
      }
    },
    server: {
      host: normalizeString(serverInput.host, DEFAULT_CONFIG.server.host),
      port: normalizeInteger(serverInput.port, DEFAULT_CONFIG.server.port, 1, 65535)
    }
  };
  normalized.agent.captureDir = resolveCaptureDir(normalized, configPath);
  normalized.agent.memoryFile = resolveMemoryFile(normalized, configPath);
  normalized.agent.traceFile = resolveTraceFile(normalized, configPath);
  normalized.agent.sessionFile = resolveSessionFile(normalized, configPath);
  return normalized;
}

function applyEnvOverrides(config, configPath) {
  const next = deepMerge(config, {
    agnes: {
      apiKey: process.env.AGNES_API_KEY,
      baseURL: process.env.AGNES_BASE_URL,
      model: process.env.AGNES_MODEL
    },
    server: {
      host: process.env.DSH_ORB_STANDALONE_HOST,
      port: process.env.DSH_ORB_STANDALONE_PORT === undefined ? undefined : Number(process.env.DSH_ORB_STANDALONE_PORT)
    }
  });
  return normalizeConfig(next, configPath);
}

function deepMerge(base, patch) {
  if (!isPlainObject(base)) return patch;
  if (!isPlainObject(patch)) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = merged[key];
    merged[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return merged;
}

function normalizeString(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function normalizeNonEmptyPath(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function normalizeUrl(value, fallback) {
  const candidate = normalizeString(value, fallback).replace(/\/+$/, "");
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return candidate;
  } catch {}
  return fallback;
}

function normalizeOptionalUrl(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const candidate = value.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return candidate;
  } catch {}
  return fallback;
}

function normalizeInteger(value, fallback, min, max) {
  const next = Number(value);
  if (!Number.isInteger(next) || next < min || next > max) return fallback;
  return next;
}

function normalizeNumber(value, fallback, min, max) {
  const next = Number(value);
  if (!Number.isFinite(next) || next < min || next > max) return fallback;
  return next;
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeEnum(value, allowed, fallback) {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function maskSecret(value) {
  const secret = typeof value === "string" ? value.trim() : "";
  if (secret === "") return "";
  if (secret.length <= 8) return "*".repeat(secret.length);
  return `${secret.slice(0, 4)}${"*".repeat(Math.max(4, secret.length - 8))}${secret.slice(-4)}`;
}

export function projectRoot() {
  return rootDir;
}
