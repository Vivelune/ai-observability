import type { Message } from "@ai-observability/schema";
import type { Observe } from "./client";
import type { LlmInfo } from "./types";

export interface WrapOpenAIOptions {
  provider?: string;
  spanName?: string;
}

type AnyFn = (...args: unknown[]) => unknown;
type Json = Record<string, unknown>;

const PARAM_KEYS = [
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "n",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "stop",
];

function toRole(role: unknown): Message["role"] {
  if (role === "system" || role === "developer") return "system";
  if (role === "assistant") return "assistant";
  if (role === "tool" || role === "function") return "tool";
  return "user";
}

function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function toMessages(messages: unknown): Message[] | undefined {
  if (!Array.isArray(messages)) return undefined;
  return messages.map((m: Json) => ({ role: toRole(m?.role), content: toText(m?.content) }));
}

function pickParameters(params: Json): Record<string, unknown> | undefined {
  const picked: Record<string, unknown> = {};
  for (const key of PARAM_KEYS) if (params[key] !== undefined) picked[key] = params[key];
  return Object.keys(picked).length > 0 ? picked : undefined;
}

function fromResponse(response: unknown): Partial<LlmInfo> {
  const res = (response ?? {}) as Json;
  const message = ((res.choices as Json[] | undefined)?.[0]?.message ?? {}) as Json;
  const usage = (res.usage ?? {}) as Json;
  const output = message.content ?? message.tool_calls;
  return {
    model: typeof res.model === "string" ? res.model : undefined,
    output: output === undefined || output === null ? undefined : toText(output),
    inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
    outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
  };
}

/** Proxy `root` so that the function at `path` is replaced by wrap(original, owner). */
function wrapPath<T extends object>(
  root: T,
  path: string[],
  wrap: (original: AnyFn, owner: object) => AnyFn,
): T {
  const [head, ...rest] = path;
  return new Proxy(root, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === head && value !== null && value !== undefined) {
        if (rest.length === 0 && typeof value === "function") return wrap(value as AnyFn, target);
        if (rest.length > 0 && typeof value === "object") return wrapPath(value, rest, wrap);
      }
      return typeof value === "function" ? (value as AnyFn).bind(target) : value;
    },
  });
}

/**
 * Wrap an OpenAI client so `client.chat.completions.create()` is traced as an llm span with
 * model, input, output, token usage and latency. v0 limits: streaming calls are passed through
 * untouched, and the wrapped call returns a plain Promise of the response.
 */
export function wrapOpenAI<T extends object>(
  client: T,
  obs: Observe,
  options: WrapOpenAIOptions = {},
): T {
  try {
    const provider = options.provider ?? "openai";
    const spanName = options.spanName ?? "openai.chat.completions";
    return wrapPath(client, ["chat", "completions", "create"], (original, owner) => {
      return (...args: unknown[]) => {
        const params = (args[0] ?? {}) as Json;
        if (params.stream) return original.apply(owner, args);
        return obs.span(
          spanName,
          async (span) => {
            span.setLlm({
              model: typeof params.model === "string" ? params.model : "unknown",
              provider,
              input: toMessages(params.messages),
              parameters: pickParameters(params),
            });
            const response = await original.apply(owner, args);
            try {
              span.setLlm(fromResponse(response));
            } catch {
              // Never let capture problems affect the caller's response.
            }
            return response;
          },
          { type: "llm" },
        );
      };
    });
  } catch {
    return client;
  }
}
