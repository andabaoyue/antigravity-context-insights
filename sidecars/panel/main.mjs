import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DATA_DIR = join(os.homedir(), '.gemini', 'antigravity');
const CONVS_DIR = join(APP_DATA_DIR, 'conversations');
const DB_PATH = join(APP_DATA_DIR, 'conversation_summaries.db');
const PRICING_CACHE_PATH = join(APP_DATA_DIR, 'plugin_data', 'context-insights', 'pricing_cache.json');
const PRICING_SYNC_TTL_MS = 24 * 3600 * 1000;
const PRICING_SYNC_OFFLINE = process.env.CONTEXT_INSIGHTS_OFFLINE === '1' || process.env.CONTEXT_INSIGHTS_OFFLINE === 'true';
const LITELLM_PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const OPENROUTER_PRICING_URL = 'https://openrouter.ai/api/v1/models';
export const USD_CNY_RATE = Number(process.env.USD_CNY_RATE) || 7.12;

const readLocal = (name) => readFileSync(join(HERE, name), 'utf8');

const convDbCache = new Map();
let summaryDbCache = { stamp: null, meta: {} };

// Fallback mapping when gen_metadata lacks a bot->model entry (~0.16% of rows)
export const ENUM_MODEL_FALLBACK = {
  342:  'gpt-oss-120b-medium',
  1035: 'claude-sonnet-4-6',
  1318: 'gemini-3.8-flash-n',
  1322: 'gemini-3.8-flash-tiered',
  1401: 'claude-opus-5-5-medium',
  1402: 'claude-opus-5-5-high',
  1417: 'gemini-4-argon-trial',
  1418: 'gemini-4-argon-trial',
  1525: 'gemini-4-hydrogen',
  1528: 'gemini-4-hydrogen',
  1530: 'gemini-4-hydrogen-tiered-high',
  1532: 'gemini-4-neon',
  1535: 'gemini-4-neon',
  1668: 'gemini-pro-orchestrator-g1-pro',
  1669: 'gemini-flash-worker-agy',
};

const FLASH_38_INTRO_END_MS = Date.UTC(2027, 0, 1, 0, 0, 0); // 2027-01-01T00:00:00Z
const FLASH_38_PRICE_INTRO = { in: 0.75, out: 3.75, cache: 0.075, estimated: false };
const FLASH_38_PRICE_STD = { in: 1.50, out: 7.50, cache: 0.15, estimated: false };
const FLASH_38_PRICE = {
  ...FLASH_38_PRICE_INTRO,
  schedule: [
    { beforeMs: FLASH_38_INTRO_END_MS, price: FLASH_38_PRICE_INTRO },
    { beforeMs: Infinity, price: FLASH_38_PRICE_STD },
  ],
};

// Official Gemini 4 flat-rate pricing across full 1M context window (95% implicit caching discount; no >200K surcharge)
const GEMINI_4_HYDROGEN_PRICE = { in: 1.50, out: 7.50, cache: 0.075, estimated: false };
const GEMINI_4_NEON_PRICE = { in: 3.00, out: 15.00, cache: 0.15, estimated: false };

const GEMINI_4_ARGON_INTRO_END_MS = Date.UTC(2026, 11, 1, 0, 0, 0); // 2026-12-01T00:00:00Z
const GEMINI_4_ARGON_CARBON_INTRO = { in: 2.00, out: 10.00, cache: 0.10, estimated: false };
const GEMINI_4_ARGON_CARBON_STD = { in: 4.00, out: 20.00, cache: 0.20, estimated: false };
const GEMINI_4_ARGON_CARBON_PRICE = {
  ...GEMINI_4_ARGON_CARBON_INTRO,
  schedule: [
    { beforeMs: GEMINI_4_ARGON_INTRO_END_MS, price: GEMINI_4_ARGON_CARBON_INTRO },
    { beforeMs: Infinity, price: GEMINI_4_ARGON_CARBON_STD },
  ],
};

// Legacy Gemini 3.1 Pro tiered pricing (fallback for legacy `pro` model IDs)
const GEMINI_31_PRO_PRICE = {
  in: 2.00,
  out: 12.00,
  cache: 0.20,
  longContext: { threshold: 200000, in: 4.00, out: 18.00, cache: 0.40 },
  estimated: false,
};

const CLAUDE_SONNET_46_PRICE = {
  in: 3.00,
  out: 15.00,
  cache: 0.30,
  longContext: { threshold: 200000, in: 6.00, out: 22.50, cache: 0.60 },
  estimated: false,
};
const CLAUDE_OPUS_55_PRICE = {
  in: 4.00,
  out: 20.00,
  cache: 0.20,
  longContext: { threshold: 200000, in: 8.00, out: 30.00, cache: 0.40 },
  estimated: false,
};
const GPT_OSS_120B_PRICE = { in: 0.75, out: 3.00, cache: 0.075, estimated: true };

// Map Antigravity internal model variants to canonical LiteLLM/OpenRouter model IDs
export const MODEL_CANONICAL_ALIAS = {
  'gemini-3.8-flash-n':             'gemini-3.8-flash',
  'gemini-3.8-flash-q':             'gemini-3.8-flash',
  'gemini-3.8-flash-exp-a':         'gemini-3.8-flash',
  'gemini-3.8-flash-tiered':        'gemini-3.8-flash',
  'gemini-flash-worker-agy':        'gemini-3.8-flash',
  'gemini-4-hydrogen-tiered-high':  'gemini-4-hydrogen',
  'gemini-4-argon-trial':           'gemini-4-argon',
  'gemini-pro-orchestrator-g1-pro': 'gemini-4-argon',
  'claude-opus-5-5-medium':         'claude-opus-5-5',
  'claude-opus-5-5-high':           'claude-opus-5-5',
  'gpt-oss-120b-medium':            'gpt-oss-120b',
};

function resolveScheduledPrice(entry, stepTimeMs = Date.now()) {
  if (!entry) return null;
  if (!entry.schedule) return entry;
  const ts = stepTimeMs > 0 ? stepTimeMs : Date.now();
  for (const tier of entry.schedule) {
    if (ts < tier.beforeMs) return tier.price;
  }
  return entry.schedule[entry.schedule.length - 1].price;
}

// Pricing table (USD per 1M tokens).
// Unpriced / truly unknown models return null rather than inventing a rate.
export const MODEL_PRICING_TABLE = {
  'gemini-3.8-flash':               FLASH_38_PRICE,
  'gemini-3.8-flash-n':             FLASH_38_PRICE,
  'gemini-3.8-flash-q':             FLASH_38_PRICE,
  'gemini-3.8-flash-exp-a':         FLASH_38_PRICE,
  'gemini-3.8-flash-tiered':        FLASH_38_PRICE,
  'gemini-flash-worker-agy':        FLASH_38_PRICE,
  'gemini-4-hydrogen':              GEMINI_4_HYDROGEN_PRICE,
  'gemini-4-hydrogen-tiered-high':  GEMINI_4_HYDROGEN_PRICE,
  'gemini-4-neon':                  GEMINI_4_NEON_PRICE,
  'gemini-4-argon':                 GEMINI_4_ARGON_CARBON_PRICE,
  'gemini-4-argon-trial':           GEMINI_4_ARGON_CARBON_PRICE,
  'gemini-4-carbon':                GEMINI_4_ARGON_CARBON_PRICE,
  'gemini-pro-orchestrator-g1-pro': GEMINI_4_ARGON_CARBON_PRICE,
  'claude-sonnet-4-6':              CLAUDE_SONNET_46_PRICE,
  'claude-opus-5-5-medium':         CLAUDE_OPUS_55_PRICE,
  'claude-opus-5-5-high':           CLAUDE_OPUS_55_PRICE,
  'gpt-oss-120b-medium':            GPT_OSS_120B_PRICE,
};

// ---------------------------------------------------------------------------
// Lightweight 24h Live Pricing Sync (LiteLLM primary + OpenRouter fallback)
// ---------------------------------------------------------------------------
let livePricingState = {
  source: 'builtin',
  updatedAt: 0,
  models: {},
  lastError: null,
};
let pricingSyncInFlight = null;

function roundRate(per1M) {
  return Math.round(per1M * 10000) / 10000;
}

function loadPricingCache() {
  if (!existsSync(PRICING_CACHE_PATH)) return;
  try {
    const parsed = JSON.parse(readFileSync(PRICING_CACHE_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.models && typeof parsed.models === 'object') {
      livePricingState = {
        source: parsed.source || 'cache',
        updatedAt: Number(parsed.updatedAt) || 0,
        models: parsed.models,
        lastError: null,
      };
    }
  } catch {}
}

loadPricingCache();

function parseLiteLlmCatalog(rawJson) {
  if (!rawJson || typeof rawJson !== 'object') return {};
  const skipPattern = /(tts|live|image|embedding|batch|flex|priority|audio|robotics|veo|imagen|-fast$)/i;
  const models = {};
  const priority = {};

  for (const [key, val] of Object.entries(rawJson)) {
    if (!val || typeof val !== 'object') continue;
    let slug = null;
    let rank = 0;
    const mGemPrefix = key.match(/^gemini\/(gemini-[a-z0-9._-]+)$/);
    const mGemBare = key.match(/^(gemini-[a-z0-9._-]+)$/);
    const mClaude = key.match(/^(claude-[a-z0-9._-]+)$/);
    const mOpenAi = key.match(/^(gpt-[a-z0-9._-]+|o[134](?:-[a-z0-9._-]+)?)$/);

    if (mGemPrefix) {
      slug = mGemPrefix[1];
      rank = 2;
    } else if (mGemBare) {
      slug = mGemBare[1];
      rank = 1;
    } else if (mClaude) {
      slug = mClaude[1];
      rank = 2;
    } else if (mOpenAi) {
      slug = mOpenAi[1];
      rank = 1;
    }
    if (!slug || skipPattern.test(slug)) continue;

    const rawIn = Number(val.input_cost_per_token);
    const rawOut = Number(val.output_cost_per_token);
    if (!(rawIn > 0) || !(rawOut > 0)) continue;

    const inRate = roundRate(rawIn * 1e6);
    const outRate = roundRate(rawOut * 1e6);
    const rawCache = Number(val.cache_read_input_token_cost);
    const cacheRate = rawCache >= 0 && Number.isFinite(rawCache)
      ? roundRate(rawCache * 1e6)
      : roundRate(inRate * 0.1);

    const entry = { in: inRate, out: outRate, cache: cacheRate, estimated: false };
    const rawIn200 = Number(val.input_cost_per_token_above_200k_tokens);
    const rawOut200 = Number(val.output_cost_per_token_above_200k_tokens);
    if (rawIn200 > 0 && rawOut200 > 0) {
      const rawCache200 = Number(val.cache_read_input_token_cost_above_200k_tokens);
      const in200 = roundRate(rawIn200 * 1e6);
      entry.longContext = {
        threshold: 200000,
        in: in200,
        out: roundRate(rawOut200 * 1e6),
        cache: rawCache200 >= 0 && Number.isFinite(rawCache200)
          ? roundRate(rawCache200 * 1e6)
          : roundRate(in200 * 0.1),
      };
    }

    if (!priority[slug] || rank >= priority[slug]) {
      models[slug] = entry;
      priority[slug] = rank;
    }
  }
  return models;
}

function parseOpenRouterCatalog(rawJson) {
  const list = rawJson?.data;
  if (!Array.isArray(list)) return {};
  const models = {};
  for (const item of list) {
    if (!item || typeof item.id !== 'string' || !item.pricing) continue;
    const match = item.id.match(/^(google|anthropic|openai)\/([a-z0-9._-]+)$/);
    if (!match) continue;
    const slug = match[2];
    const rawIn = Number(item.pricing.prompt);
    const rawOut = Number(item.pricing.completion);
    if (!(rawIn > 0) || !(rawOut > 0)) continue;

    const inRate = roundRate(rawIn * 1e6);
    const outRate = roundRate(rawOut * 1e6);
    const rawCache = Number(item.pricing.input_cache_read);
    const cacheRate = rawCache >= 0 && Number.isFinite(rawCache)
      ? roundRate(rawCache * 1e6)
      : roundRate(inRate * 0.1);

    const entry = { in: inRate, out: outRate, cache: cacheRate, estimated: false };
    models[slug] = entry;
    if (slug.startsWith('claude-') && slug.includes('.')) {
      models[slug.replace(/\./g, '-')] = entry;
    }
  }
  return models;
}

export function getPricingSyncStatus() {
  return {
    source: livePricingState.source,
    updatedAt: livePricingState.updatedAt,
    modelCount: Object.keys(livePricingState.models || {}).length,
    syncing: Boolean(pricingSyncInFlight),
    offline: PRICING_SYNC_OFFLINE,
    lastError: livePricingState.lastError,
  };
}

export async function syncLivePricing({ force = false } = {}) {
  if (PRICING_SYNC_OFFLINE) return livePricingState;
  const now = Date.now();
  if (!force && livePricingState.updatedAt > 0 && (now - livePricingState.updatedAt) < PRICING_SYNC_TTL_MS) {
    return livePricingState;
  }
  if (pricingSyncInFlight) return pricingSyncInFlight;

  pricingSyncInFlight = (async () => {
    const errors = [];
    const feeds = [
      { name: 'litellm', url: LITELLM_PRICING_URL, parse: parseLiteLlmCatalog },
      { name: 'openrouter', url: OPENROUTER_PRICING_URL, parse: parseOpenRouterCatalog },
    ];

    for (const feed of feeds) {
      try {
        const res = await fetch(feed.url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const models = feed.parse(json);
        const count = Object.keys(models).length;
        if (count < 5) throw new Error(`Too few models parsed (${count})`);

        const nextState = {
          source: feed.name,
          updatedAt: Date.now(),
          models,
          lastError: null,
        };
        livePricingState = nextState;
        try {
          mkdirSync(dirname(PRICING_CACHE_PATH), { recursive: true });
          writeFileSync(PRICING_CACHE_PATH, JSON.stringify({
            source: nextState.source,
            updatedAt: nextState.updatedAt,
            models: nextState.models,
          }));
        } catch {}
        return livePricingState;
      } catch (err) {
        errors.push(`${feed.name}: ${err.message}`);
      }
    }

    livePricingState = {
      ...livePricingState,
      lastError: errors.join('; '),
    };
    return livePricingState;
  })().finally(() => {
    pricingSyncInFlight = null;
  });

  return pricingSyncInFlight;
}

function lookupLivePricing(model) {
  const models = livePricingState.models;
  if (!models) return null;
  if (models[model]) return { ...models[model], source: livePricingState.source };

  const aliased = MODEL_CANONICAL_ALIAS[model];
  if (aliased && models[aliased]) return { ...models[aliased], source: livePricingState.source };

  const stripped = model.replace(/-(medium|high|low|xhigh|trial|tiered)$/i, '');
  if (stripped !== model && models[stripped]) {
    return { ...models[stripped], source: livePricingState.source };
  }
  return null;
}

function getBuiltinScheduledEntry(model) {
  if (!model || model === 'unknown') return null;
  if (MODEL_PRICING_TABLE[model]) return MODEL_PRICING_TABLE[model];

  const m = model.toLowerCase();
  if (m.includes('opus')) return CLAUDE_OPUS_55_PRICE;
  if (m.includes('claude')) return CLAUDE_SONNET_46_PRICE;
  if (m.includes('hydrogen')) return GEMINI_4_HYDROGEN_PRICE;
  if (m.includes('neon')) return GEMINI_4_NEON_PRICE;
  if (m.includes('argon') || m.includes('carbon') || m.includes('orchestrator')) {
    return GEMINI_4_ARGON_CARBON_PRICE;
  }
  if (m.includes('flash')) return FLASH_38_PRICE;
  if (m.includes('pro')) return GEMINI_31_PRO_PRICE;
  if (m.includes('gpt-oss')) return GPT_OSS_120B_PRICE;
  return null;
}

function getHistoricalPromoPrice(model, stepTimeMs) {
  if (!stepTimeMs || stepTimeMs <= 0) return null;
  const entry = getBuiltinScheduledEntry(model);
  if (!entry || !entry.schedule) return null;
  for (const tier of entry.schedule) {
    if (Number.isFinite(tier.beforeMs) && stepTimeMs < tier.beforeMs) {
      return { ...tier.price, source: 'builtin-promo' };
    }
  }
  return null;
}

export function getModelPricing(model, stepTimeMs = Date.now()) {
  if (!model || model === 'unknown') return null;

  // 1. Protect historical pre-cutoff promo steps from retroactive rate jumps
  const promo = getHistoricalPromoPrice(model, stepTimeMs);
  if (promo) return promo;

  // 2. Live synced catalog (LiteLLM / OpenRouter)
  const live = lookupLivePricing(model);
  if (live) return live;

  // 3. Offline built-in official schedule fallback
  const entry = getBuiltinScheduledEntry(model);
  if (!entry) return null;
  const resolved = resolveScheduledPrice(entry, stepTimeMs);
  return resolved ? { ...resolved, source: 'builtin' } : null;
}

// ---------------------------------------------------------------------------
// Fast Wire-Format Protobuf Decoder for Antigravity SQLite Blobs
// ---------------------------------------------------------------------------
function decodeProto(buf, offset = 0, end = buf.length) {
  const fields = [];
  while (offset < end) {
    let tag = 0;
    let shift = 0;
    while (offset < end) {
      const b = buf[offset++];
      tag |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const fieldNo = tag >> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      let val = 0n;
      let s = 0n;
      while (offset < end) {
        const b = buf[offset++];
        val |= BigInt(b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7n;
      }
      fields.push({ fieldNo, wireType, val: Number(val) });
    } else if (wireType === 2) {
      let len = 0;
      let s = 0;
      while (offset < end) {
        const b = buf[offset++];
        len |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      if (len < 0 || offset + len > end) break;
      const sub = buf.subarray(offset, offset + len);
      offset += len;
      fields.push({ fieldNo, wireType, len, sub });
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      break;
    }
  }
  return fields;
}

function getProtoTimestampMs(field) {
  if (!field || field.wireType !== 2) return 0;
  const sub = decodeProto(field.sub);
  const sec = sub.find((x) => x.fieldNo === 1)?.val || 0;
  const nano = sub.find((x) => x.fieldNo === 2)?.val || 0;
  return sec * 1000 + Math.round(nano / 1e6);
}

function toLocalDateStr(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toLocalHourKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  return `${y}-${m}-${day}T${hh}`;
}

// NOTE (verified on 42,393 / 42,393 records with field #10, 100% zero exceptions):
// outTok MUST be the raw usage field #3 (total output), which already includes
// reasoning/thinking tokens (field #9), and field #10 (visible text) === field #3 - field #9.
// Passing (#3 + #9) here double-bills every reasoning token. Do NOT alter this.
export function calcStepCostDetail(model, inTok, outTok, cacheTok, stepTimeMs = Date.now()) {
  const p = getModelPricing(model, stepTimeMs);
  if (!p) return null;
  const promptCtx = inTok + cacheTok;
  const isLongContext = Boolean(p.longContext && promptCtx > p.longContext.threshold);
  const rates = isLongContext ? p.longContext : p;
  const baseCostUsd = (inTok * p.in + outTok * p.out + cacheTok * p.cache) / 1e6;
  const costUsd = isLongContext
    ? (inTok * rates.in + outTok * rates.out + cacheTok * rates.cache) / 1e6
    : baseCostUsd;
  return {
    costUsd,
    baseCostUsd,
    extraUsd: Math.max(0, costUsd - baseCostUsd),
    isLongContext,
    estimated: Boolean(p.estimated),
    pricing: p,
  };
}

export function calcStepCostUsd(model, inTok, outTok, cacheTok, stepTimeMs = Date.now()) {
  return calcStepCostDetail(model, inTok, outTok, cacheTok, stepTimeMs)?.costUsd ?? null;
}

// Tool calls that orchestrate subagents/tasks rather than directly reading/editing/running work
export const DISPATCH_TOOLS = new Set([
  'manage_task',
  'invoke_subagent',
  'define_subagent',
  'manage_subagents',
  'send_message',
  'swarm',
  'run_workflow',
  'schedule',
]);

// ---------------------------------------------------------------------------
// Helper: Load conversation metadata (titles + subagent hierarchy) from conversation_summaries.db
// ---------------------------------------------------------------------------
function getDbMetadata() {
  if (!existsSync(DB_PATH)) return {};
  try {
    const st = statSync(DB_PATH);
    const walPath = `${DB_PATH}-wal`;
    const walSt = existsSync(walPath) ? statSync(walPath) : null;
    const stamp = `${st.mtimeMs}:${st.size}:${walSt ? walSt.mtimeMs : 0}:${walSt ? walSt.size : 0}`;
    if (summaryDbCache.stamp === stamp) {
      return summaryDbCache.meta;
    }

    const meta = {};
    let db = null;
    try {
      db = new DatabaseSync(DB_PATH, { readOnly: true });
      try { db.exec('PRAGMA busy_timeout = 250'); } catch {}
      const rows = db.prepare(
        'SELECT conversation_id, title, step_count, last_modified_time, agent_name, parent_conversation_id, nesting_depth, workspace_uris FROM conversation_summaries'
      ).all();
      for (const r of rows) {
        meta[r.conversation_id] = {
          title: r.title || '',
          stepCount: r.step_count || 0,
          modified: r.last_modified_time ? new Date(r.last_modified_time).getTime() : 0,
          agentName: r.agent_name || '',
          parentId: r.parent_conversation_id || '',
          nestingDepth: r.nesting_depth || 0,
          workspaceUris: r.workspace_uris || '',
        };
      }
      summaryDbCache = { stamp, meta };
    } finally {
      try { db?.close(); } catch {}
    }
    return meta;
  } catch (err) {
    console.error('Error querying SQLite metadata:', err.message);
    return summaryDbCache.meta || {};
  }
}

function resolveHierarchy(cid, dbMeta) {
  const meta = dbMeta[cid] || {};
  const parentId = meta.parentId || null;
  const isSubagent = Boolean(meta.agentName || parentId || meta.nestingDepth > 0);
  const visited = new Set([cid]);
  let curId = parentId;
  let rootId = cid;
  let resolvedDepth = 0;
  while (curId && !visited.has(curId)) {
    visited.add(curId);
    rootId = curId;
    resolvedDepth++;
    const pMeta = dbMeta[curId];
    if (!pMeta || !pMeta.parentId) break;
    curId = pMeta.parentId;
  }
  const parentMeta = parentId ? (dbMeta[parentId] || null) : null;
  const rootMeta = rootId !== cid ? (dbMeta[rootId] || null) : null;
  const parentTitle = parentId
    ? (parentMeta?.title || (parentMeta?.agentName ? `[${parentMeta.agentName}]` : parentId.slice(0, 8)))
    : null;
  const rootTitle = rootId !== cid
    ? (rootMeta?.title || (rootMeta?.agentName ? `[${rootMeta.agentName}]` : rootId.slice(0, 8)))
    : null;
  return {
    isSubagent,
    agentName: meta.agentName || (isSubagent ? 'subagent' : null),
    parentId,
    parentTitle,
    rootId: rootId !== cid ? rootId : null,
    rootTitle,
    nestingDepth: Math.max(meta.nestingDepth || 0, resolvedDepth),
  };
}

function downsampleContextSeries(rawPoints, peakCtx, maxLen = 60) {
  if (!rawPoints || rawPoints.length <= maxLen) return rawPoints || [];
  const mustKeep = new Set([0, rawPoints.length - 1]);
  let peakSaved = false;
  for (let i = 0; i < rawPoints.length; i++) {
    const pt = rawPoints[i];
    if (!peakSaved && peakCtx > 0 && pt.ctx === peakCtx) {
      mustKeep.add(i);
      peakSaved = true;
    }
    if (pt.isCompaction) {
      mustKeep.add(i);
      if (i > 0) mustKeep.add(i - 1);
    }
  }
  const remainingSlots = Math.max(0, maxLen - mustKeep.size);
  if (remainingSlots > 0) {
    const step = (rawPoints.length - 1) / (remainingSlots + 1);
    for (let k = 1; k <= remainingSlots; k++) {
      mustKeep.add(Math.min(rawPoints.length - 1, Math.round(k * step)));
    }
  }
  return [...mustKeep].sort((a, b) => a - b).map((idx) => rawPoints[idx]);
}

// ---------------------------------------------------------------------------
// Helper: Parse single conversation .db with WAL-aware cache
// ---------------------------------------------------------------------------
function parseConversationDbCached(cid, dbFilePath) {
  try {
    const st = statSync(dbFilePath);
    const walPath = `${dbFilePath}-wal`;
    const walSt = existsSync(walPath) ? statSync(walPath) : null;
    const stamp = `${st.mtimeMs}:${st.size}:${walSt ? walSt.mtimeMs : 0}:${walSt ? walSt.size : 0}`;

    const cached = convDbCache.get(cid);
    if (cached && cached.stamp === stamp) {
      return cached.records;
    }

    let db = null;
    const records = [];
    try {
      db = new DatabaseSync(dbFilePath, { readOnly: true });
      try { db.exec('PRAGMA busy_timeout = 250'); } catch {}

      // 1. Map bot-<uuid> -> modelName from gen_metadata
      const botToModel = new Map();
      try {
        const gmRows = db.prepare('SELECT idx, data FROM gen_metadata').all();
        for (const r of gmRows) {
          if (!r.data) continue;
          const top = decodeProto(Buffer.from(r.data));
          const f1 = top.find((x) => x.fieldNo === 1 && x.wireType === 2);
          if (!f1) continue;
          const sub1 = decodeProto(f1.sub);
          const f4 = sub1.find((x) => x.fieldNo === 4 && x.wireType === 2);
          const f19 = sub1.find((x) => x.fieldNo === 19 && x.wireType === 2);
          const modelName = f19 ? f19.sub.toString('utf8').trim() : '';
          if (f4 && modelName && modelName !== 'unknown') {
            const u = decodeProto(f4.sub);
            const bot = u.find((x) => x.fieldNo === 7 && x.wireType === 2)?.sub.toString('utf8');
            if (bot) botToModel.set(bot, modelName);
          }
        }
      } catch {}

      // 2. Parse all steps
      const stepRows = db.prepare('SELECT idx, step_type, metadata FROM steps ORDER BY idx ASC').all();
      for (const s of stepRows) {
        let t1 = 0;
        let t6 = 0;
        let t7 = 0;
        let inTok = 0;
        let outBase = 0;
        let reasTok = 0;
        let visTok = null;
        let cacheTok = 0;
        let model = null;
        let enumVal = 0;
        let fromGenMeta = false;
        let hasUsage = false;
        let toolName = null;

        if (s.metadata) {
          const f = decodeProto(Buffer.from(s.metadata));
          t1 = getProtoTimestampMs(f.find((x) => x.fieldNo === 1));
          t6 = getProtoTimestampMs(f.find((x) => x.fieldNo === 6));
          t7 = getProtoTimestampMs(f.find((x) => x.fieldNo === 7));

          if (s.step_type === 132) {
            const f4 = f.find((x) => x.fieldNo === 4 && x.wireType === 2);
            if (f4) {
              const sub4 = decodeProto(f4.sub);
              const fn2 = sub4.find((x) => x.fieldNo === 2 && x.wireType === 2);
              if (fn2) toolName = fn2.sub.toString('utf8');
            }
          }

          const f9 = f.find((x) => x.fieldNo === 9 && x.wireType === 2);
          if (f9) {
            hasUsage = true;
            const sub = decodeProto(f9.sub);
            enumVal = sub.find((x) => x.fieldNo === 1)?.val || 0;
            inTok = sub.find((x) => x.fieldNo === 2)?.val || 0;
            outBase = sub.find((x) => x.fieldNo === 3)?.val || 0;
            cacheTok = sub.find((x) => x.fieldNo === 5)?.val || 0;
            reasTok = sub.find((x) => x.fieldNo === 9)?.val || 0;
            const f10 = sub.find((x) => x.fieldNo === 10);
            visTok = f10 ? (f10.val || 0) : null;
            const bot = sub.find((x) => x.fieldNo === 7 && x.wireType === 2)?.sub.toString('utf8');
            const genModel = bot ? botToModel.get(bot) : null;
            fromGenMeta = Boolean(genModel);
            model = genModel || ENUM_MODEL_FALLBACK[enumVal] || 'unknown';
          }
        }

        records.push({
          idx: s.idx,
          stepType: s.step_type,
          t1,
          t6,
          t7,
          hasUsage,
          enumVal,
          fromGenMeta,
          inTok,
          outBase,
          reasTok,
          visTok,
          // field #3 is the billed output total and already includes the
          // reasoning tokens in field #9 -- do not add them again.
          outTok: outBase,
          cacheTok,
          model,
          toolName,
        });
      }
    } finally {
      try { db?.close(); } catch {}
    }

    convDbCache.set(cid, { stamp, records });
    return records;
  } catch (err) {
    console.error(`Error reading conversation DB for ${cid}:`, err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Core Aggregation Engine (Authoritative SQLite conversations/*.db)
// ---------------------------------------------------------------------------
export function getAggregatedStats(params = {}) {
  const range = params.range || 'all';
  const currentConvId = params.currentConvId || null;
  const isEmptyTest = Boolean(params.emptyTest);
  const convsDir = params.convsDir !== undefined ? params.convsDir : CONVS_DIR;

  if (!isEmptyTest) void syncLivePricing();

  const now = Date.now();
  let minTime = 0;
  if (range === '24h') minTime = now - 24 * 3600 * 1000;
  else if (range === '7d') minTime = now - 7 * 24 * 3600 * 1000;
  else if (range === '30d') minTime = now - 30 * 24 * 3600 * 1000;

  const dbMeta = isEmptyTest ? {} : getDbMetadata();
  const convList = [];

  let grandInput = 0;
  let grandOutputBase = 0;
  let grandReasoning = 0;
  let grandOutput = 0;
  let grandCache = 0;
  let grandToolCalls = 0;
  let grandWorkToolCalls = 0;
  let grandDispatchToolCalls = 0;
  let grandSteps = 0;
  let grandTurns = 0;
  let grandMessages = 0;
  let grandCostUsd = 0;
  let grandBaseCostUsd = 0;
  let grandLongContextSteps = 0;
  let grandLongContextExtraUsd = 0;
  let grandPricedTokens = 0;
  let grandUnpricedTokens = 0;
  let grandPricedSteps = 0;
  let grandUnpricedSteps = 0;
  const unpricedModels = new Set();

  let grandModelDurationMs = 0;
  let grandToolDurationMs = 0;
  let grandWaitDurationMs = 0;
  let grandInterTurnMs = 0;
  let rawStep15SumMs = 0;

  let maxPeakContextTokens = 0;
  let totalCompactionEvents = 0;
  let compactedConversationsCount = 0;

  let totalUsageRows = 0;
  let genMetaMissCount = 0;
  let unmappedModelRows = 0;
  let visTokCheckedCount = 0;
  let visTokMismatchCount = 0;

  let globalLastReply = null;

  const modelTotals = {};
  const dailyBuckets = {};
  const hourlyBuckets = {};
  const heatMapData = {};

  if (!isEmptyTest && convsDir && existsSync(convsDir)) {
    const files = readdirSync(convsDir).filter((f) => f.endsWith('.db'));
    for (const file of files) {
      const cid = file.slice(0, -3);
      const dbFilePath = join(convsDir, file);
      const records = parseConversationDbCached(cid, dbFilePath);
      if (!records || records.length === 0) continue;

      const meta = dbMeta[cid] || {};
      const hier = resolveHierarchy(cid, dbMeta);
      let displayTitle = meta.title || '';
      if (!displayTitle) {
        if (hier.isSubagent) {
          const agentTag = hier.agentName || 'subagent';
          const parentRef = hier.parentTitle || (hier.parentId ? hier.parentId.slice(0, 8) : cid.slice(0, 8));
          displayTitle = `[${agentTag}] ← ${parentRef}`;
        } else {
          displayTitle = '未命名会话';
        }
      }

      let cIn = 0;
      let cOutBase = 0;
      let cReas = 0;
      let cOut = 0;
      let cCache = 0;
      let cToolCalls = 0;
      let cWorkToolCalls = 0;
      let cDispatchToolCalls = 0;
      const cToolBreakdown = {};
      let cSteps = 0;
      let cTurns = 0;
      let cMsgs = 0;
      let cCostUsd = 0;
      let cBaseCostUsd = 0;
      let cLongContextSteps = 0;
      let cLongContextExtraUsd = 0;
      let cPricedTokens = 0;
      let cUnpricedTokens = 0;
      let cPricedSteps = 0;
      let cUnpricedSteps = 0;
      let cFirstTime = 0;
      let cLastTime = 0;
      let cModelMs = 0;
      let cTurnTailMs = 0;
      let cToolMs = 0;
      let cInterTurnMs = 0;
      let cRawStep15Ms = 0;
      const cModels = {};
      const cActiveDates = new Set();
      // Context window watermark & compaction tracking (ctx = inTok + cacheTok)
      let prevCtx = null;
      let cCurrentCtx = 0;
      let cPeakCtx = 0;
      const cCompactions = [];
      const cRawContextSeries = [];
      // Last real model reply in this conversation (stepType 15 with usage).
      // Tracked separately from the running totals: the card under 「生成速率」
      // means ONE reply, not the conversation average.
      let lastReply = null;

      let prevEndMs = 0;

      for (const r of records) {
        const stepTime = r.t1 || r.t7 || 0;
        if (stepTime > 0) {
          if (!cFirstTime || stepTime < cFirstTime) cFirstTime = stepTime;
          if (!cLastTime || stepTime > cLastTime) cLastTime = stepTime;
          // Heatmap always reflects full historical activity across all weeks regardless of range filter
          const allDateStr = toLocalDateStr(stepTime);
          heatMapData[allDateStr] = (heatMapData[allDateStr] || 0) + 1;
        }

        // Track unfiltered global latest reply across ALL conversations
        if (r.stepType === 15 && r.t7 > r.t1 && (r.t7 - r.t1) < 600000 && r.hasUsage && r.outTok > 0) {
          const mid = (r.t6 >= r.t1 && r.t6 <= r.t7) ? r.t6 : r.t7;
          const genMs = mid - r.t1;
          const replyMs = genMs > 0 ? genMs : (r.t7 - r.t1);
          const replyTime = r.t7 || r.t1;
          if (!globalLastReply || replyTime > globalLastReply.time) {
            globalLastReply = {
              convId: cid,
              convTitle: displayTitle,
              time: replyTime,
              ms: replyMs,
              out: r.outTok,
              think: r.reasTok,
              model: r.model || 'unknown',
              tokPerSec: parseFloat((r.outTok / (replyMs / 1000)).toFixed(1)),
            };
          }
        }

        if (minTime > 0 && stepTime > 0 && stepTime < minTime) {
          const endMs = r.t7 > r.t1 ? r.t7 : r.t1;
          if (endMs > prevEndMs) {
            prevEndMs = endMs;
          }
          continue;
        }

        cSteps++;
        if (r.stepType === 14) cTurns++;
        if (r.stepType === 132) {
          cToolCalls++;
          const tName = r.toolName || 'unknown_tool';
          cToolBreakdown[tName] = (cToolBreakdown[tName] || 0) + 1;
          if (DISPATCH_TOOLS.has(tName)) {
            cDispatchToolCalls++;
          } else {
            cWorkToolCalls++;
          }
        }

        if (r.hasUsage) {
          cMsgs++;
          totalUsageRows++;
          if (!r.fromGenMeta) genMetaMissCount++;
          if (!r.model || r.model === 'unknown') unmappedModelRows++;
          if (r.visTok !== null && r.visTok !== undefined) {
            visTokCheckedCount++;
            if (r.outBase !== r.visTok + r.reasTok) {
              visTokMismatchCount++;
            }
          }

          cIn += r.inTok;
          cOutBase += r.outBase;
          cReas += r.reasTok;
          cOut += r.outTok;
          cCache += r.cacheTok;

          // Context watermark & compaction check (ignore drops to 0 which are session/subagent breaks)
          const ctx = r.inTok + r.cacheTok;
          if (ctx > cPeakCtx) cPeakCtx = ctx;
          if (ctx > 0) cCurrentCtx = ctx;
          let isCompaction = false;
          if (prevCtx !== null && prevCtx >= 20000 && ctx > 0 && ctx < prevCtx * 0.7) {
            isCompaction = true;
            cCompactions.push({
              idx: r.idx,
              before: prevCtx,
              after: ctx,
              dropPct: Math.round((1 - ctx / prevCtx) * 100),
              time: stepTime,
            });
          }
          if (ctx > 0) {
            cRawContextSeries.push({
              idx: r.idx,
              ctx,
              isCompaction,
              before: isCompaction ? prevCtx : undefined,
              dropPct: isCompaction ? Math.round((1 - ctx / prevCtx) * 100) : undefined,
              time: stepTime,
            });
          }
          prevCtx = ctx;

          const stepTotal = r.inTok + r.outTok + r.cacheTok;
          const stepCostDetail = calcStepCostDetail(r.model, r.inTok, r.outTok, r.cacheTok, stepTime || now);
          const isStepPriced = stepCostDetail !== null;
          const mKey = r.model || 'unknown';
          if (isStepPriced) {
            cCostUsd += stepCostDetail.costUsd;
            cBaseCostUsd += stepCostDetail.baseCostUsd;
            cPricedSteps++;
            cPricedTokens += stepTotal;
            if (stepCostDetail.isLongContext) {
              cLongContextSteps++;
              cLongContextExtraUsd += stepCostDetail.extraUsd;
            }
          } else {
            cUnpricedSteps++;
            cUnpricedTokens += stepTotal;
            unpricedModels.add(mKey);
          }

          cModels[mKey] = (cModels[mKey] || 0) + stepTotal;
          if (!modelTotals[mKey]) {
            const mp = getModelPricing(mKey, now);
            modelTotals[mKey] = {
              tokens: 0,
              costUsd: 0,
              baseCostUsd: 0,
              longContextSteps: 0,
              longContextExtraUsd: 0,
              messages: 0,
              priced: mp !== null,
              pricing: mp
                ? {
                    in: mp.in,
                    out: mp.out,
                    cache: mp.cache,
                    longContext: mp.longContext || null,
                    estimated: Boolean(mp.estimated),
                    source: mp.source || 'builtin',
                  }
                : null,
            };
          }
          modelTotals[mKey].tokens += stepTotal;
          if (isStepPriced) {
            modelTotals[mKey].costUsd += stepCostDetail.costUsd;
            modelTotals[mKey].baseCostUsd += stepCostDetail.baseCostUsd;
            if (stepCostDetail.isLongContext) {
              modelTotals[mKey].longContextSteps += 1;
              modelTotals[mKey].longContextExtraUsd += stepCostDetail.extraUsd;
            }
          }
          modelTotals[mKey].messages += 1;

          if (stepTime > 0) {
            const dateStr = toLocalDateStr(stepTime);
            if (!dailyBuckets[dateStr]) {
              dailyBuckets[dateStr] = { tokens: 0, costUsd: 0, pricedSteps: 0, steps: 0, toolCalls: 0, messages: 0 };
            }
            dailyBuckets[dateStr].tokens += stepTotal;
            if (isStepPriced) {
              dailyBuckets[dateStr].costUsd += stepCostDetail.costUsd;
              dailyBuckets[dateStr].pricedSteps += 1;
            }
            dailyBuckets[dateStr].messages += 1;

            const hourKey = toLocalHourKey(stepTime);
            if (!hourlyBuckets[hourKey]) {
              hourlyBuckets[hourKey] = { tokens: 0, costUsd: 0, pricedSteps: 0, steps: 0, toolCalls: 0, messages: 0 };
            }
            hourlyBuckets[hourKey].tokens += stepTotal;
            if (isStepPriced) {
              hourlyBuckets[hourKey].costUsd += stepCostDetail.costUsd;
              hourlyBuckets[hourKey].pricedSteps += 1;
            }
            hourlyBuckets[hourKey].messages += 1;
          }
        }

        if (stepTime > 0) {
          const dateStr = toLocalDateStr(stepTime);
          cActiveDates.add(dateStr);
          if (!dailyBuckets[dateStr]) {
            dailyBuckets[dateStr] = { tokens: 0, costUsd: 0, pricedSteps: 0, steps: 0, toolCalls: 0, messages: 0 };
          }
          dailyBuckets[dateStr].steps += 1;
          if (r.stepType === 132) dailyBuckets[dateStr].toolCalls += 1;

          const hourKey = toLocalHourKey(stepTime);
          if (!hourlyBuckets[hourKey]) {
            hourlyBuckets[hourKey] = { tokens: 0, costUsd: 0, pricedSteps: 0, steps: 0, toolCalls: 0, messages: 0 };
          }
          hourlyBuckets[hourKey].steps += 1;
          if (r.stepType === 132) hourlyBuckets[hourKey].toolCalls += 1;
        }

        // Mutually exclusive & exhaustive 3-slice timing breakdown within active turn windows:
        // Slice 1: Model generation = 15.(t6 - t1)
        // Slice 2: Tool execution   = 132.(t7 - t1) (100% nested inside preceding 15's [t6, t7])
        // Slice 3: Window wait/tail = 15.(t7 - t6) - 132.(t7 - t1)
        if (r.stepType === 15 && r.t7 > r.t1 && (r.t7 - r.t1) < 600000) {
          const step15Ms = r.t7 - r.t1;
          cRawStep15Ms += step15Ms;
          const mid = (r.t6 >= r.t1 && r.t6 <= r.t7) ? r.t6 : r.t7;
          const genMs = mid - r.t1;
          const tailMs = r.t7 - mid;
          cModelMs += genMs;
          cTurnTailMs += tailMs;
          if (r.hasUsage && r.outTok > 0) {
            const replyMs = genMs > 0 ? genMs : step15Ms;
            lastReply = {
              idx: r.idx,
              ms: replyMs,
              out: r.outTok,
              think: r.reasTok,
              model: r.model || 'unknown',
              time: r.t7 || r.t1,
            };
          }
        } else if (r.stepType === 132 && r.t7 > r.t1 && (r.t7 - r.t1) < 600000) {
          cToolMs += (r.t7 - r.t1);
        }

        if (prevEndMs > 0 && r.t1 > prevEndMs) {
          const dt = r.t1 - prevEndMs;
          if (dt < 600000) {
            cInterTurnMs += dt;
          }
        }
        const endMs = r.t7 > r.t1 ? r.t7 : r.t1;
        if (endMs > prevEndMs) {
          prevEndMs = endMs;
        }
      }

      if (cSteps === 0) continue;

      const cWaitMs = Math.max(0, cTurnTailMs - cToolMs);

      grandInput += cIn;
      grandOutputBase += cOutBase;
      grandReasoning += cReas;
      grandOutput += cOut;
      grandCache += cCache;
      grandToolCalls += cToolCalls;
      grandWorkToolCalls += cWorkToolCalls;
      grandDispatchToolCalls += cDispatchToolCalls;
      grandSteps += cSteps;
      grandTurns += cTurns;
      grandMessages += cMsgs;
      grandCostUsd += cCostUsd;
      grandBaseCostUsd += cBaseCostUsd;
      grandLongContextSteps += cLongContextSteps;
      grandLongContextExtraUsd += cLongContextExtraUsd;
      grandPricedTokens += cPricedTokens;
      grandUnpricedTokens += cUnpricedTokens;
      grandPricedSteps += cPricedSteps;
      grandUnpricedSteps += cUnpricedSteps;

      grandModelDurationMs += cModelMs;
      grandToolDurationMs += cToolMs;
      grandWaitDurationMs += cWaitMs;
      grandInterTurnMs += cInterTurnMs;
      rawStep15SumMs += cRawStep15Ms;

      if (cPeakCtx > maxPeakContextTokens) maxPeakContextTokens = cPeakCtx;
      if (cCompactions.length > 0) {
        totalCompactionEvents += cCompactions.length;
        compactedConversationsCount++;
      }

      const totalConvTokens = cIn + cOut + cCache;
      const cacheRatio = (cCache + cIn) > 0 ? (cCache / (cCache + cIn) * 100) : 0;
      const convActiveMs = cModelMs + cToolMs + cWaitMs;
      const convModelSec = cModelMs / 1000;
      const speedTokPerSec = convModelSec > 0.1 && cOut > 0 ? Math.round(cOut / convModelSec) : 0;
      const knownModels = Object.entries(cModels).filter(([k]) => k && k !== 'unknown').sort((a, b) => b[1] - a[1]);
      const topModelEntry = knownModels[0] || Object.entries(cModels).sort((a, b) => b[1] - a[1])[0];
      const primaryModel = topModelEntry ? topModelEntry[0] : '未知模型';
      const primaryModelTokens = topModelEntry ? topModelEntry[1] : 0;
      // Unified denominator: use totalConvTokens consistently across conversation cards and global model breakdown
      const primaryModelPercent = totalConvTokens > 0
        ? parseFloat(((primaryModelTokens / totalConvTokens) * 100).toFixed(1))
        : 0;

      const isConvPriced = cPricedSteps > 0;
      const convCostUsd = isConvPriced ? parseFloat(cCostUsd.toFixed(2)) : null;
      const convCostYuan = isConvPriced ? parseFloat((cCostUsd * USD_CNY_RATE).toFixed(2)) : null;
      const convCostUsdExact = isConvPriced ? parseFloat(cCostUsd.toFixed(4)) : null;
      const convCostYuanExact = isConvPriced ? parseFloat((cCostUsd * USD_CNY_RATE).toFixed(4)) : null;
      const convPricedTokenPct = totalConvTokens > 0
        ? parseFloat(((cPricedTokens / totalConvTokens) * 100).toFixed(1))
        : 0;

      const topTools = Object.entries(cToolBreakdown)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, count]) => ({
          name,
          count,
          category: DISPATCH_TOOLS.has(name) ? 'dispatch' : 'work',
        }));

      convList.push({
        id: cid,
        title: displayTitle,
        isSubagent: hier.isSubagent,
        agentName: hier.agentName,
        parentId: hier.parentId,
        parentTitle: hier.parentTitle,
        rootId: hier.rootId,
        rootTitle: hier.rootTitle,
        nestingDepth: hier.nestingDepth,
        childSubagentCount: 0,
        childSubagentTokens: 0,
        childSubagentIds: [],
        childSubagents: [],
        primaryModel,
        primaryModelPercent,
        steps: cSteps,
        turns: cTurns,
        messages: cMsgs,
        toolCalls: cToolCalls,
        workToolCalls: cWorkToolCalls,
        dispatchToolCalls: cDispatchToolCalls,
        topTools,
        inputTokens: cIn,
        outputTokens: cOut,
        reasoningTokens: cReas,
        cacheTokens: cCache,
        totalTokens: totalConvTokens,
        currentContextTokens: cCurrentCtx,
        peakContextTokens: cPeakCtx,
        compactionCount: cCompactions.length,
        compactionEvents: cCompactions,
        contextSeries: downsampleContextSeries(cRawContextSeries, cPeakCtx, 60),
        priced: isConvPriced,
        partiallyPriced: isConvPriced && cUnpricedSteps > 0,
        pricedTokens: cPricedTokens,
        unpricedTokens: cUnpricedTokens,
        pricedTokenPct: convPricedTokenPct,
        longContextSteps: cLongContextSteps,
        longContextExtraUsd: parseFloat(cLongContextExtraUsd.toFixed(4)),
        costUsd: convCostUsd,
        costYuan: convCostYuan,
        costUsdExact: convCostUsdExact,
        costYuanExact: convCostYuanExact,
        costDisplay: isConvPriced ? `$${convCostUsd.toFixed(2)}` : '—',
        cacheHitRate: parseFloat(cacheRatio.toFixed(1)),
        durationMs: convActiveMs,
        modelDurationMs: cModelMs,
        toolDurationMs: cToolMs,
        waitDurationMs: cWaitMs,
        wallSpanMs: (cLastTime && cFirstTime) ? Math.max(0, cLastTime - cFirstTime) : 0,
        lastModified: cLastTime || meta.modified || 0,
        activeDates: [...cActiveDates].sort(),
        isCurrent: cid === currentConvId,
        speedTokPerSec,
        lastReplySpeedTokPerSec: lastReply
          ? parseFloat((lastReply.out / (lastReply.ms / 1000)).toFixed(1))
          : 0,
        lastReplyMs: lastReply ? lastReply.ms : 0,
        lastReplyTime: lastReply ? lastReply.time : 0,
        lastReplyOutTok: lastReply ? lastReply.out : 0,
        lastReplyThinkTok: lastReply ? lastReply.think : 0,
        lastReplyModel: lastReply ? lastReply.model : null,
      });
    }
  }

  // Link child subagents back to their parent / root conversations
  const convById = new Map(convList.map((c) => [c.id, c]));
  for (const c of convList) {
    if (!c.isSubagent) continue;
    const host = (c.parentId && convById.get(c.parentId)) || (c.rootId && convById.get(c.rootId));
    if (host && host.id !== c.id) {
      host.childSubagentCount++;
      host.childSubagentTokens += c.totalTokens;
      host.childSubagentIds.push(c.id);
      host.childSubagents.push({
        id: c.id,
        title: c.title,
        agentName: c.agentName,
        totalTokens: c.totalTokens,
        costDisplay: c.costDisplay,
      });
    }
  }

  const subagentConversationsCount = convList.filter((c) => c.isSubagent).length;
  const mainConversationsCount = convList.length - subagentConversationsCount;

  const grandTotalTokens = grandInput + grandOutput + grandCache;
  const grandCacheRatio = (grandCache + grandInput) > 0 ? (grandCache / (grandCache + grandInput) * 100) : 0;
  const grandActiveDurationMs = grandModelDurationMs + grandToolDurationMs + grandWaitDurationMs;
  const tokPerSec = grandModelDurationMs > 100 && grandOutput > 0
    ? Math.round(grandOutput / (grandModelDurationMs / 1000))
    : 0;
  const pricedTokenCoveragePct = grandTotalTokens > 0
    ? parseFloat(((grandPricedTokens / grandTotalTokens) * 100).toFixed(1))
    : 0;

  // Continuous timeline: 25-point hourly rolling trend for '24h', daily calendar sequence otherwise
  const timelineGranularity = range === '24h' ? 'hour' : 'day';
  const timeline = [];
  if (!isEmptyTest) {
    if (timelineGranularity === 'hour') {
      const endHour = new Date(now);
      endHour.setMinutes(0, 0, 0);
      for (let i = 24; i >= 0; i--) {
        const hStart = new Date(endHour.getTime() - i * 3600 * 1000);
        const hEnd = new Date(hStart.getTime() + 3600 * 1000);
        const hourKey = toLocalHourKey(hStart.getTime());
        const fullDate = toLocalDateStr(hStart.getTime());
        const hh = String(hStart.getHours()).padStart(2, '0');
        const hhNext = String(hEnd.getHours()).padStart(2, '0');
        const timeRange = `${fullDate.slice(5)} ${hh}:00 - ${hhNext}:00`;
        const h = hourlyBuckets[hourKey];
        if (h) {
          const isHourPriced = h.pricedSteps > 0 || h.messages === 0;
          timeline.push({
            granularity: 'hour',
            hourKey,
            date: `${hh}:00`,
            timeRange,
            fullDate,
            tokens: h.tokens,
            priced: isHourPriced,
            costUsd: isHourPriced ? parseFloat(h.costUsd.toFixed(2)) : null,
            cost: isHourPriced ? parseFloat((h.costUsd * USD_CNY_RATE).toFixed(2)) : null,
            costDisplay: isHourPriced ? `$${h.costUsd.toFixed(2)}` : '—',
            steps: h.steps,
            messages: h.messages,
            toolCalls: h.toolCalls,
          });
        } else {
          timeline.push({
            granularity: 'hour',
            hourKey,
            date: `${hh}:00`,
            timeRange,
            fullDate,
            tokens: 0,
            priced: true,
            costUsd: 0,
            cost: 0,
            costDisplay: '$0.00',
            steps: 0,
            messages: 0,
            toolCalls: 0,
          });
        }
      }
    } else {
      const spanDays = range === '30d' ? 30 : (range === '7d' ? 7 : 14);
      const endDay = new Date(now);
      endDay.setHours(0, 0, 0, 0);
      for (let i = spanDays - 1; i >= 0; i--) {
        const dObj = new Date(endDay.getTime() - i * 24 * 3600 * 1000);
        const date = toLocalDateStr(dObj.getTime());
        const d = dailyBuckets[date];
        if (d) {
          const isDayPriced = d.pricedSteps > 0 || d.messages === 0;
          timeline.push({
            granularity: 'day',
            date: date.slice(5),
            fullDate: date,
            tokens: d.tokens,
            priced: isDayPriced,
            costUsd: isDayPriced ? parseFloat(d.costUsd.toFixed(2)) : null,
            cost: isDayPriced ? parseFloat((d.costUsd * USD_CNY_RATE).toFixed(2)) : null,
            costDisplay: isDayPriced ? `$${d.costUsd.toFixed(2)}` : '—',
            steps: d.steps,
            messages: d.messages,
            toolCalls: d.toolCalls,
          });
        } else {
          timeline.push({
            granularity: 'day',
            date: date.slice(5),
            fullDate: date,
            tokens: 0,
            priced: true,
            costUsd: 0,
            cost: 0,
            costDisplay: '$0.00',
            steps: 0,
            messages: 0,
            toolCalls: 0,
          });
        }
      }
    }
  }

  // Token Categories Breakdown (Exact components)
  const denom = grandTotalTokens || 1;
  const tokenCategories = [
    { label: '缓存命中读取', percent: grandTotalTokens > 0 ? parseFloat(((grandCache / denom) * 100).toFixed(1)) : 0, tokens: grandCache, color: '#3B82F6' },
    { label: '未缓存新输入', percent: grandTotalTokens > 0 ? parseFloat(((grandInput / denom) * 100).toFixed(1)) : 0, tokens: grandInput, color: '#10B981' },
    // 常规生成输出 = 可见文本（输出总量 - 其中已含的思考量），否则与下一项重复计票
    { label: '常规生成输出', percent: grandTotalTokens > 0 ? parseFloat((((grandOutputBase - grandReasoning) / denom) * 100).toFixed(2)) : 0, tokens: Math.max(0, grandOutputBase - grandReasoning), color: '#8B5CF6' },
    { label: '深度思考推理', percent: grandTotalTokens > 0 ? parseFloat(((grandReasoning / denom) * 100).toFixed(2)) : 0, tokens: grandReasoning, color: '#F59E0B' },
  ];

  // Model Categories Breakdown (Tiered pricing; unknown tiers output '—')
  const modelColors = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EC4899', '#94A3B8'];
  const modelCategories = Object.entries(modelTotals)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([modelName, info], idx) => {
      const isPriced = Boolean(info.priced);
      const costVal = isPriced ? parseFloat(info.costUsd.toFixed(2)) : null;
      return {
        label: modelName,
        percent: grandTotalTokens > 0 ? parseFloat(((info.tokens / denom) * 100).toFixed(1)) : 0,
        tokens: info.tokens,
        priced: isPriced,
        costUsd: costVal,
        costDisplay: isPriced ? `$${costVal.toFixed(2)}` : '—',
        baseCostUsd: isPriced ? parseFloat(info.baseCostUsd.toFixed(4)) : 0,
        longContextSteps: info.longContextSteps || 0,
        longContextExtraUsd: isPriced ? parseFloat(info.longContextExtraUsd.toFixed(4)) : 0,
        pricing: info.pricing || null,
        messages: info.messages,
        color: modelColors[idx % modelColors.length],
      };
    });

  // Time Categories Breakdown (Mutually exclusive & exhaustive 3-slice active duration)
  const timeDenom = grandActiveDurationMs || 1;
  const modelTimePct = grandActiveDurationMs > 0 ? parseFloat(((grandModelDurationMs / timeDenom) * 100).toFixed(1)) : 0;
  const toolTimePct = grandActiveDurationMs > 0 ? parseFloat(((grandToolDurationMs / timeDenom) * 100).toFixed(1)) : 0;
  const waitTimePct = grandActiveDurationMs > 0 ? parseFloat(Math.max(0, 100 - modelTimePct - toolTimePct).toFixed(1)) : 0;

  const timeCategories = [
    { label: '模型思考与生成', percent: modelTimePct, ms: grandModelDurationMs, color: '#8B5CF6' },
    { label: '窗口调度与收尾', percent: waitTimePct, ms: grandWaitDurationMs, color: '#3B82F6' },
    { label: '工具命令执行', percent: toolTimePct, ms: grandToolDurationMs, color: '#10B981' },
  ];

  // The single most recent reply across ALL conversations — unfiltered by range
  const latestReply = globalLastReply;

  const genMetaMissRatePct = totalUsageRows > 0
    ? parseFloat(((genMetaMissCount / totalUsageRows) * 100).toFixed(3))
    : 0;

  return {
    kpis: {
      activeConversations: convList.length,
      totalConversations: Math.max(Object.keys(dbMeta).length, convList.length),
      mainConversationsCount,
      subagentConversationsCount,
      totalTokens: grandTotalTokens,
      inputTokens: grandInput,
      outputTokens: grandOutput,
      reasoningTokens: grandReasoning,
      maxPeakContextTokens,
      totalCompactionEvents,
      compactedConversationsCount,
      turnsCount: grandTurns,
      messagesCount: grandMessages,
      costUsd: parseFloat(grandCostUsd.toFixed(2)),
      costYuan: parseFloat((grandCostUsd * USD_CNY_RATE).toFixed(2)),
      costUsdExact: parseFloat(grandCostUsd.toFixed(4)),
      costYuanExact: parseFloat((grandCostUsd * USD_CNY_RATE).toFixed(4)),
      baseCostUsd: parseFloat(grandBaseCostUsd.toFixed(4)),
      longContextSteps: grandLongContextSteps,
      longContextExtraUsd: parseFloat(grandLongContextExtraUsd.toFixed(4)),
      usdCnyRate: USD_CNY_RATE,
      pricedConvCount: convList.filter((c) => c.priced).length,
      fullyPricedConvCount: convList.filter((c) => c.priced && !c.partiallyPriced).length,
      pricedTokens: grandPricedTokens,
      unpricedTokens: grandUnpricedTokens,
      pricedTokenCoveragePct,
      pricedStepsCount: grandPricedSteps,
      unpricedStepsCount: grandUnpricedSteps,
      unpricedModels: [...unpricedModels],
      cacheHitRate: parseFloat(grandCacheRatio.toFixed(1)),
      cacheTokens: grandCache,
      toolCalls: grandToolCalls,
      workToolCalls: grandWorkToolCalls,
      dispatchToolCalls: grandDispatchToolCalls,
      toolDurationMs: grandToolDurationMs,
      modelDurationMs: grandModelDurationMs,
      waitDurationMs: grandWaitDurationMs,
      interTurnDurationMs: grandInterTurnMs,
      activeDurationMs: grandActiveDurationMs,
      generationSpeedTokPerSec: tokPerSec,
      latestReply,
      pricingSync: getPricingSyncStatus(),
      diagnostics: {
        totalUsageRows,
        genMetaMissCount,
        genMetaMissRatePct,
        unmappedModelRows,
        rawStep15SumMs,
        threeSliceSumMs: grandActiveDurationMs,
        visTokCheckedCount,
        visTokMismatchCount,
      },
    },
    timeline,
    timelineGranularity,
    tokenCategories,
    modelCategories,
    timeCategories,
    heatMap: heatMapData,
    conversations: convList.sort((a, b) => b.lastModified - a.lastModified),
  };
}

// ---------------------------------------------------------------------------
// Bootstrapper: Sidecar Mode vs Standalone HTTP Mode
// ---------------------------------------------------------------------------
const isSidecar = Boolean(
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT &&
  process.env.ANTIGRAVITY_LS_ADDRESS &&
  process.env.ANTIGRAVITY_CSRF_TOKEN
);

const isMain = Boolean(
  process.argv[1] &&
  fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()
);

if (isSidecar) {
  const { SidecarApp, Response } = await import('sidecar_sdk');
  const app = new SidecarApp();
  const noStore = { 'Cache-Control': 'no-store' };

  app.page('/', () => new Response(readLocal('index.html'), { contentType: 'text/html; charset=utf-8', headers: noStore }));
  app.page('/app.js', () => new Response(readLocal('app.js'), { contentType: 'application/javascript; charset=utf-8', headers: noStore }));
  app.api('/styles.css', () => new Response(readLocal('styles.css'), { contentType: 'text/css; charset=utf-8', headers: noStore }), 'GET');

  app.api('/api/stats', (data) => getAggregatedStats(data), 'GET');
  app.api('/api/stats', (data) => getAggregatedStats(data), 'POST');
  app.api('/api/sync-pricing', async () => {
    await syncLivePricing({ force: true });
    const pricingSync = getPricingSyncStatus();
    return { ok: !pricingSync.lastError, pricingSync };
  }, 'POST');

  void syncLivePricing();
  setInterval(() => { void syncLivePricing(); }, 6 * 3600 * 1000).unref();

  app.run();
} else if (isMain) {
  void syncLivePricing();
  setInterval(() => { void syncLivePricing(); }, 6 * 3600 * 1000).unref();

  const PORT = process.env.PORT || 5678;
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(readLocal('index.html'));
    }
    if (url.pathname === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(readLocal('app.js'));
    }
    if (url.pathname === '/styles.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(readLocal('styles.css'));
    }
    if (url.pathname === '/preload.js') {
      const mockPreload = `window.sidecar = { conversationId: null, fetch: (url, opt) => fetch(url, opt), ui: { toggleAuxPane: () => {}, toggleConversation: () => {} } };`;
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      return res.end(mockPreload);
    }
    if (url.pathname === '/api/sync-pricing') {
      syncLivePricing({ force: true }).then(() => {
        const pricingSync = getPricingSyncStatus();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: !pricingSync.lastError, pricingSync }));
      });
      return;
    }
    if (url.pathname === '/api/stats') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let params = {};
        try { if (body) params = JSON.parse(body); } catch {}
        const data = getAggregatedStats(params);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Context Insights running at http://127.0.0.1:${PORT}`);
  });
}
