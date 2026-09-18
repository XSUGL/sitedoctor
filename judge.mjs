#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Шаг 2: превратить факты в вердикт. Здесь работает модель.
//
//   node judge.mjs --dry          # посчитать, во сколько обойдётся
//   node judge.mjs --limit 10     # десять штук, попробовать
//   node judge.mjs                # всё, чего ещё нет в judged.json
//   node judge.mjs --redo         # пересудить заново (после правки промпта)
//   node judge.mjs --effort low   # дешевле и быстрее, качество замерь сам
//   node judge.mjs --free --limit 5   # бесплатная модель: проверить конвейер
//
// Доступ:  export ANTHROPIC_API_KEY="sk-ant-..."
// Бесплатно: export FREE_API_KEY="..."   (ключ console.groq.com, карта не нужна)
// ═══════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { Verdict, SYSTEM, brief, withoutModel } from "./brain.mjs";
import { claudeAsker, freeAsker, emptyUsage, CLAUDE_PRICE as PRICE, spentOn } from "./ask.mjs";

const args = process.argv.slice(2);
const has = (n) => args.includes("--" + n);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };

// --free гоняет тот же конвейер через бесплатный OpenAI-совместимый
// эндпоинт. Смысл не в качестве, а в том, чтобы проверить сборку промпта,
// схему и разбор ответа, не потратив ни цента. Результат кладётся в
// отдельный файл и помечается иначе, чтобы дешёвый прогон никогда
// не подмешался в замеры качества.
const FREE = has("free");
const FREE_URL = process.env.FREE_BASE_URL || "https://api.groq.com/openai/v1";
const FREE_KEY = process.env.FREE_API_KEY || process.env.GROQ_API_KEY;

const MODEL = flag("model", FREE ? (process.env.FREE_MODEL || "openai/gpt-oss-20b") : "claude-opus-5");
const EFFORT = flag("effort", "medium");
const LIMIT = Number(flag("limit", 0));
const DRY = has("dry");
const REDO = has("redo");
const IN = flag("in", "signals.json");
const OUT = flag("out", FREE ? "judged-free.json" : "judged.json");
// Бесплатный тариф Groq: 30 запросов в минуту и 8 тысяч токенов в минуту.
// В четыре потока мы упрёмся в лимит на втором сайте.
const PARALLEL = FREE ? 1 : 4;
const FREE_GAP = 2200;   // мс между запросами, это ~27 запросов в минуту


// ── запуск ───────────────────────────────────────────────────────
if (!existsSync(IN)) {
  console.error(`\n❌ Нет ${IN}. Сначала: node collect.mjs\n`);
  process.exit(1);
}
const all = JSON.parse(readFileSync(IN, "utf8"));

// Ключ по адресу, а не по названию: две точки одной фирмы носят одно имя,
// и по имени вердикт одной подставился бы обеим.
const key = (r) => r.url || r.name;
const done = !REDO && existsSync(OUT)
  ? new Map(JSON.parse(readFileSync(OUT, "utf8")).map((r) => [key(r), r]))
  : new Map();

const byRule = [];
const forModel = [];
for (const s of all) {
  if (done.has(key(s))) continue;
  const r = withoutModel(s);
  if (r) byRule.push(r); else forModel.push(s);
}
const batch = LIMIT ? forModel.slice(0, LIMIT) : forModel;

console.log(`\nВсего сайтов:            ${all.length}`);
console.log(`Уже разобрано раньше:    ${done.size}`);
console.log(`Решается правилом:       ${byRule.length}  (моделью не платим)`);
console.log(`Идёт в модель:           ${batch.length}`);

const HAS_KEY = FREE ? Boolean(FREE_KEY) : Boolean(process.env.ANTHROPIC_API_KEY);
const client = (!FREE && HAS_KEY) ? new Anthropic() : null;

// ── сколько это будет стоить ─────────────────────────────────────
// Считаем до запуска, а не после. Это единственный способ не узнать
// цену задним числом, когда деньги уже потрачены.
if (batch.length && FREE) {
  console.log(`\nПровайдер:               ${FREE_URL}`);
  console.log(`Модель:                  ${MODEL}  (бесплатная)`);
  console.log(`Цена:                    $0.00. Это проверка конвейера, а не замер качества.`);
  console.log(`Скорость:                по одному сайту раз в ${(FREE_GAP / 1000).toFixed(1)} с, иначе лимит.`);
  console.log(`Результат ляжет в:       ${OUT}  (в judged.json не попадёт)`);
} else if (batch.length) {
  const sample = brief(batch[0]) + SYSTEM;
  let tokens, exact = false;
  if (HAS_KEY) {
    // Точный счёт даёт сам API: свой токенизатор писать не надо
    // и брать чужой (tiktoken) тоже нельзя, он считает по-другому.
    const est = await client.messages.countTokens({
      model: MODEL, system: SYSTEM,
      messages: [{ role: "user", content: brief(batch[0]) }],
    });
    tokens = est.input_tokens; exact = true;
  } else {
    tokens = Math.round(sample.length / 3.2);   // грубо: кириллица дороже латиницы
  }
  const outGuess = 400;                          // вердикт короткий, но с рассуждением
  const perSite = (tokens * PRICE.in + outGuess * PRICE.out) / 1e6;
  console.log(`\nНа один сайт:            ~${tokens} токенов входа${exact ? "" : " (грубая оценка, без ключа)"}`);
  console.log(`Примерная цена:          $${perSite.toFixed(4)} за сайт, ` +
              `$${(perSite * batch.length).toFixed(2)} за все ${batch.length}`);
  console.log(`Модель:                  ${MODEL}, усилие ${EFFORT}`);
  console.log(`   Реальная цена будет ниже: инструкция кэшируется со второго сайта.`);
}

if (DRY) {
  console.log(`\n👀 Это только расчёт, ничего не отправлено.\n   Запуск: node judge.mjs\n`);
  process.exit(0);
}

if (!HAS_KEY) {
  // Правила отработали и без модели, их результат сохраняем: он бесплатный
  // и уже полезен. За остальным вернёшься, когда будет ключ.
  if (byRule.length) {
    writeFileSync(OUT, JSON.stringify([...done.values(), ...byRule], null, 1));
    console.log(`\n📄 ${OUT}: ${byRule.length} вердиктов, вынесенных правилами (бесплатно).`);
  }
  console.error(`\n❌ Для остальных ${batch.length} нужен ключ. Возьми на console.anthropic.com:

   export ANTHROPIC_API_KEY="sk-ant-..."

   Ключ живёт только в переменной окружения, в файлы он не попадает.

   Проверить конвейер, не платя ничего, можно на бесплатной модели:

   export FREE_API_KEY="..."        # console.groq.com, карта не нужна
   node judge.mjs --free --limit 5

   Вердикты оттуда лягут в judged-free.json и в замеры качества не пойдут.\n`);
  process.exit(1);
}

// ── один сайт ────────────────────────────────────────────────────
// Сам запрос живёт в ask.mjs: тем же кодом пользуется cascade.mjs,
// и промпт со схемой у них гарантированно одни и те же.
const usage = emptyUsage();
const ask = FREE
  ? freeAsker({ url: FREE_URL, key: FREE_KEY, model: MODEL, usage })
  : claudeAsker({ model: MODEL, effort: EFFORT, usage, client });

const LABEL = FREE ? "бесплатной моделью" : "моделью";
const judgeOne = async (s) => ({ ...s, judged: LABEL, verdict: await ask(s) });

const results = [...done.values(), ...byRule];
let n = 0, failed = 0;

async function worker(queue) {
  while (queue.length) {
    const s = queue.shift();
    try {
      results.push(await judgeOne(s));
    } catch (e) {
      if (e.retryAfter) {           // упёрлись в лимит: подождать и вернуть сайт в очередь
        await new Promise((r) => setTimeout(r, (e.retryAfter + 1) * 1000));
        queue.unshift(s);
        continue;
      }
      failed++;
      // Типизированные ошибки SDK: по ним видно, чинить ключ,
      // ждать лимит или это просто один плохой сайт.
      const kind =
        e instanceof Anthropic.AuthenticationError ? "ключ не принят" :
        e instanceof Anthropic.RateLimitError ? "упёрлись в лимит запросов" :
        e instanceof Anthropic.APIError ? `API ${e.status}` : e.message;
      results.push({ ...s, judged: "не вышло", judgeError: kind });
      if (e instanceof Anthropic.AuthenticationError) { queue.length = 0; }
    }
    n++;
    process.stdout.write(`\r   ${n}/${batch.length}  ${s.name.slice(0, 42).padEnd(42)}`);
    if (FREE && queue.length) await new Promise((r) => setTimeout(r, FREE_GAP));
    writeFileSync(OUT, JSON.stringify(results, null, 1));   // после каждого: обрыв не потеряет работу
  }
}

if (batch.length) {
  console.log(`\n🧠 Сужу ${batch.length} сайтов, по ${PARALLEL} за раз\n`);
  const queue = [...batch];
  await Promise.all(Array.from({ length: PARALLEL }, () => worker(queue)));
}

results.sort((a, b) => (b.verdict?.need ?? -1) - (a.verdict?.need ?? -1));
writeFileSync(OUT, JSON.stringify(results, null, 1));

// ── итог и настоящая цена ────────────────────────────────────────
const spent = spentOn(usage);
const hot = results.filter((r) => r.verdict?.worth_contacting && r.verdict.need >= 60);

console.log(`\n\n📄 ${OUT}: ${results.length} вердиктов${failed ? `, не вышло ${failed}` : ""}`);
if (batch.length && FREE) {
  console.log(`\n   Потрачено:      $0.00  (${MODEL})`);
  console.log(`   Вход:           ${usage.in} токенов`);
  console.log(`   Выход:          ${usage.out} токенов`);
  console.log(`\n   Это проверка конвейера. Качество меряется только на платном прогоне.`);
} else if (batch.length) {
  console.log(`\n   Потрачено:      $${spent.toFixed(3)}`);
  console.log(`   Вход:           ${usage.in} токенов`);
  console.log(`   Из кэша:        ${usage.cacheRead} токенов (в десять раз дешевле)`);
  console.log(`   Выход:          ${usage.out} токенов`);
  if (usage.cacheRead === 0 && batch.length > 1)
    console.log(`   ⚠️  Кэш не сработал ни разу. Значит инструкция меняется между запросами.`);
}
console.log(`\n   Стоит писать:   ${hot.length} заведений`);
console.log(`\n   Дальше: node eval.mjs --make 30  и проверь модель своими глазами\n`);
