// Shared utility: OpenAI ↔ Anthropic response conversion.
//
// The actual conversion logic lives in AnthropicTransformer.transformResponseIn
// (streaming) and AnthropicTransformer.convertOpenAIResponseToAnthropic (JSON).
//
// OpenAI-compatible providers (OpenAI, Groq, Mistral, Ollama) don't need a
// transformResponseOut step — their responses are already in OpenAI format.
// The Anthropic transformer handles the final conversion to Anthropic format.
//
// OpenAI/OpenRouter usage → Anthropic usage.
//
// OpenRouter's prompt_tokens INCLUDES both cached_tokens and cache_write_tokens
// (verified by live probe, see CACHING-COST-TRANSPARENCY.md §7.1 probe C:
// prompt_tokens 4517 = 4508 cache_write + 9 fresh). Anthropic's input_tokens
// excludes both, so both must be subtracted. cache_write_tokens maps to
// cache_creation_input_tokens (priced 1.25× on Claude 5m TTL).
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export function mapOpenAIUsage(usage: any): AnthropicUsage {
  const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
  const written = usage?.prompt_tokens_details?.cache_write_tokens || 0;
  return {
    input_tokens: Math.max(0, (usage?.prompt_tokens || 0) - cached - written),
    output_tokens: usage?.completion_tokens || 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
  };
}
