export const CONTEXT_WINDOWS = { _default: 200_000 };

// The minor is at most two digits so a date snapshot isn't read as version 4.20250514
const MODEL_ID = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i;

// A guess for before the session's first `result` reports the real window: 1M from 5.x on, else only [1m]
export function lookupContextWindow(modelId) {
  const m = typeof modelId === 'string' ? modelId.match(MODEL_ID) : null;
  if (!m) return CONTEXT_WINDOWS._default;
  if (m[4]) return 1_000_000;
  const family = m[1].toLowerCase();
  if (family === 'fable' || family === 'mythos') return 1_000_000;
  return Number(m[2]) >= 5 ? 1_000_000 : CONTEXT_WINDOWS._default;
}

// `claude-opus-4-7[1m]` → "Opus 4.7 (1M)". statusLine's display_name doesn't
// fire in --print mode, so we derive from the model id.
export function prettyModelName(id) {
  if (typeof id !== 'string' || !id) return null;
  const m = id.match(MODEL_ID);
  if (!m) return id;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  const version = m[3] ? `${m[2]}.${m[3]}` : m[2];
  return `${family} ${version}${m[4] ? ' (1M)' : ''}`;
}

export function baseModelId(id) {
  return typeof id === 'string' ? id.replace(/\[1m\]$/i, '') : id;
}

// The window the last `result` reported for the model this session's turns run on now
export function sessionContextWindow(slice) {
  const model = baseModelId(slice?.lastUsage?.model);
  return (model && slice?.contextWindowByModel?.[model]) || null;
}

// Derive context-window usage + model label for one session, statusline-first
// (authoritative from claude's statusLine hook) with a message_start lastUsage
// fallback. Pure: callers pass the slice's statusline/lastUsage and, for the
// fallback, the session's context-window total.
export function contextUsage(statusline, lastUsage, { fallbackTotal } = {}) {
  const total0 = fallbackTotal || CONTEXT_WINDOWS._default;
  const slCtx = statusline?.contextWindow;
  const slCur = slCtx?.current_usage;
  if (slCtx && typeof slCtx.context_window_size === 'number') {
    const input = slCur?.input_tokens ?? 0;
    const output = slCur?.output_tokens ?? 0;
    const cacheCreate = slCur?.cache_creation_input_tokens ?? 0;
    const cacheRead = slCur?.cache_read_input_tokens ?? 0;
    const total = slCtx.context_window_size;
    const used = (typeof slCtx.total_input_tokens === 'number' && typeof slCtx.total_output_tokens === 'number')
      ? slCtx.total_input_tokens + slCtx.total_output_tokens
      : input + output + cacheCreate + cacheRead;
    const pct = (typeof slCtx.used_percentage === 'number')
      ? slCtx.used_percentage
      : (total > 0 ? (used / total) * 100 : 0);
    return {
      known: true, used, total, pct,
      breakdown: { input, output, cacheCreate, cacheRead },
      modelLabel: statusline.model?.id ?? statusline.model?.display_name ?? null,
      modelDisplay: statusline.model?.display_name ?? prettyModelName(statusline.model?.id),
    };
  }
  if (lastUsage) {
    const { inputTokens = 0, outputTokens = 0, cacheCreate = 0, cacheRead = 0 } = lastUsage;
    const used = inputTokens + outputTokens + cacheCreate + cacheRead;
    const raw = lastUsage.model ?? null;
    // The API strips [1m], so a 1M window on a model that defaults lower is the only sign of it
    const retagged = (total0 === 1_000_000 && typeof raw === 'string' && lookupContextWindow(raw) < total0)
      ? `${raw}[1m]` : raw;
    return {
      known: true, used, total: total0, pct: total0 > 0 ? (used / total0) * 100 : 0,
      breakdown: { input: inputTokens, output: outputTokens, cacheCreate, cacheRead },
      modelLabel: raw, modelDisplay: prettyModelName(retagged),
    };
  }
  return {
    known: false, used: 0, total: total0, pct: 0,
    breakdown: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    modelLabel: null, modelDisplay: null,
  };
}
