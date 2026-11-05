import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StatuslineUsage } from '../types.js';

interface LastResponse {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

// Rebuilds the statusLine payload Claude Code doesn't run under the SDK, from the session's own frames
export class StatuslineSynth {
  private model?: string;
  private last?: LastResponse;
  // A result's durations are per turn, unlike its cost; the statusLine reported session totals.
  private durationMs = 0;
  private apiDurationMs = 0;

  observe(msg: SDKMessage): StatuslineUsage | undefined {
    if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
      const u = msg.message.usage;
      this.model = msg.message.model;
      this.last = {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      };
      return undefined;
    }
    if (msg.type !== 'result') return undefined;
    this.durationMs += msg.duration_ms;
    this.apiDurationMs += msg.duration_api_ms;
    const model = this.model;
    // modelUsage keys can carry a variant suffix (`[1m]`) the assistant frame's model id lacks.
    const key = model && (model in msg.modelUsage ? model : Object.keys(msg.modelUsage).find((k) => k.startsWith(model)));
    const size = key ? msg.modelUsage[key]?.contextWindow : undefined;
    return {
      ...(model ? { model: { id: model } } : {}),
      ...(size && this.last ? { contextWindow: { context_window_size: size, current_usage: this.last } } : {}),
      cost: {
        total_cost_usd: msg.total_cost_usd,
        total_duration_ms: this.durationMs,
        total_api_duration_ms: this.apiDurationMs,
      },
    };
  }
}
