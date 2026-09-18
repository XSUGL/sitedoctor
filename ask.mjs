// ═══════════════════════════════════════════════════════════════
// Два способа спросить модель об одном сайте. Транспорт разный,
// схема и инструкция одни и те же: они приходят из brain.mjs.
//
// Каждый возвращает вердикт и свой расход токенов. Кто и почему
// спрашивает, решает вызывающий: judge.mjs или cascade.mjs.
// ═══════════════════════════════════════════════════════════════

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Verdict, SYSTEM, brief } from "./brain.mjs";

// Схема в двух видах: нативная для Claude и JSON Schema для всех
// остальных. Обе делаются из одного Verdict, поэтому разойтись не могут.
export const CLAUDE_FORMAT = zodOutputFormat(Verdict);
export const JSON_SCHEMA = CLAUDE_FORMAT.schema;

export const emptyUsage = () => ({ in: 0, out: 0, cacheWrite: 0, cacheRead: 0 });

// Цена Opus 5 за миллион токенов. Держим рядом с вызовом, а не в двух
// скриптах: разойдутся - и отчёт об экономии станет враньём.
export const CLAUDE_PRICE = { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 };
export const spentOn = (u, p = CLAUDE_PRICE) =>
  (u.in * p.in + u.out * p.out + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1e6;

/** Claude: схема нативная, инструкция кэшируется между сайтами. */
export function claudeAsker({ model, effort, usage = emptyUsage(), client = new Anthropic() }) {
  const ask = async (s) => {
    const res = await client.messages.parse({
      model,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: { effort, format: CLAUDE_FORMAT },
      // Инструкция одна на все полтораста запросов, поэтому кэшируем её:
      // со второго сайта она стоит в десять раз дешевле.
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: brief(s) }],
    });

    usage.in += res.usage.input_tokens || 0;
    usage.out += res.usage.output_tokens || 0;
    usage.cacheWrite += res.usage.cache_creation_input_tokens || 0;
    usage.cacheRead += res.usage.cache_read_input_tokens || 0;

    if (res.stop_reason === "refusal")
      throw new Error("модель отказалась отвечать: " + (res.stop_details?.category || "без причины"));
    if (!res.parsed_output) throw new Error("ответ не разобрался по схеме");

    return res.parsed_output;
  };
  ask.usage = usage;
  return ask;
}

/** Любой OpenAI-совместимый эндпоинт: Groq, Cerebras, OpenRouter, Mistral. */
export function freeAsker({ url, key, model, usage = emptyUsage() }) {
  const ask = async (s, second = false) => {
    const res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: brief(s) + (second
            ? "\n\nПредыдущий ответ не лёг в схему. Верни строго JSON по схеме, без пояснений."
            : "") },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "verdict", schema: JSON_SCHEMA, strict: true },
        },
      }),
    });

    if (res.status === 429) {
      // Лимит бесплатного тарифа. Он и есть цена вопроса: ждём и повторяем.
      const wait = Number(res.headers.get("retry-after") || 20);
      throw Object.assign(new Error(`лимит бесплатного тарифа, подожди ${wait} с`), { retryAfter: wait });
    }
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);

    const data = await res.json();
    usage.in += data.usage?.prompt_tokens || 0;
    usage.out += data.usage?.completion_tokens || 0;

    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error("пустой ответ");

    let obj;
    try { obj = JSON.parse(raw); }
    catch { if (!second) return ask(s, true); throw new Error("ответ не разобрался как JSON"); }

    // Проверяем той же схемой: бесплатная модель поблажки не получает.
    const ok = Verdict.safeParse(obj);
    if (!ok.success) {
      if (!second) return ask(s, true);
      throw new Error("ответ не лёг в схему: " + ok.error.issues.map((i) => i.path.join(".")).join(", "));
    }
    return ok.data;
  };
  ask.usage = usage;
  return ask;
}
