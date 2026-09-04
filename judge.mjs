#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Шаг 2: превратить факты в вердикт. Здесь работает модель.
//
//   node judge.mjs --dry          # посчитать, во сколько обойдётся
//   node judge.mjs --limit 10     # десять штук, попробовать
//   node judge.mjs                # всё, чего ещё нет в judged.json
//   node judge.mjs --redo         # пересудить заново (после правки промпта)
//   node judge.mjs --effort low   # дешевле и быстрее, качество замерь сам
//
// Доступ:  export ANTHROPIC_API_KEY="sk-ant-..."
// ═══════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const args = process.argv.slice(2);
const has = (n) => args.includes("--" + n);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };

const MODEL = flag("model", "claude-opus-5");
const EFFORT = flag("effort", "medium");
const LIMIT = Number(flag("limit", 0));
const DRY = has("dry");
const REDO = has("redo");
const IN = flag("in", "signals.json");
const OUT = flag("out", "judged.json");
const PARALLEL = 4;

// Цена Opus 5 за миллион токенов. Держим рядом с кодом, чтобы
// стоимость прогона была видна сразу, а не в конце месяца в счёте.
const PRICE = { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 };

// ── что мы хотим получить ────────────────────────────────────────
// Схема это не украшение. Без неё модель вернёт абзац текста, который
// придётся разбирать регулярками, и однажды она напишет его иначе.
// Со схемой ответ либо соответствует форме, либо запрос падает с ошибкой.
const Verdict = z.object({
  state: z.enum(["dead", "abandoned", "dated", "working", "good"])
    .describe("общее состояние сайта"),
  need: z.number().int().min(0).max(100)
    .describe("насколько сайту нужна переделка: 0 не нужна, 100 нужна срочно"),
  problems: z.array(z.object({
    what: z.string().describe("проблема одной фразой по-русски"),
    evidence: z.string().describe("на каком именно факте основано, кратко"),
    severity: z.enum(["high", "medium", "low"]),
  })).describe("не больше трёх проблем, самая важная первой"),
  hook_ru: z.string()
    .describe("одна фраза по-русски: что сказать владельцу при первом контакте"),
  pitch_it: z.string()
    .describe("одно-два предложения по-итальянски для письма, вежливо, без продажи, " +
              "называет конкретную находку с этого сайта"),
  worth_contacting: z.boolean()
    .describe("есть ли смысл писать: false если сайт свежий и хороший"),
  confidence: z.enum(["low", "medium", "high"])
    .describe("low если данных мало или они противоречивы"),
});

// ── чем модель руководствуется ───────────────────────────────────
// Это главный файл проекта. Всё качество живёт здесь, а не в коде.
// Правь этот текст, прогоняй eval.mjs, смотри, стало лучше или хуже.
const SYSTEM = `Ты оцениваешь сайты небольших заведений в итальянской провинции
под Римом: рестораны, агритуризмо, залы, салоны, магазины. Твой заказчик
веб-разработчик, он ищет, кому предложить переделку сайта.

Тебе дают факты, собранные автоматически со страницы. Твоя работа
не пересказать их, а понять, что они значат для владельца.

Как оценивать:

Сначала спроси себя, теряет ли заведение из-за сайта деньги. Отсутствие
мета viewport значит, что на телефоне страницу надо растягивать пальцами,
а телефон это большинство посетителей. Меню картинкой или PDF нечитаемо
на телефоне и невидимо для поиска. Нет ни формы, ни ссылки tel: значит
гость должен сам переписывать номер. Главная фотография на несколько
мегабайт означает, что на мобильном интернете страница не откроется.

Свежесть важна меньше, чем кажется. Копирайт 2019 года на сайте, который
в остальном работает и удобен, это мелочь. А вот копирайт 2019 плюс
отсутствие адаптива плюс меню картинкой это заброшенный сайт.

Будь честен, когда чинить нечего. Если сайт быстрый, адаптивный, с формой
и свежий, поставь worth_contacting false и need меньше 30. Разработчику
полезнее короткий список настоящих кандидатов, чем длинный список,
где половина выдумана. Выдуманная проблема в письме убивает доверие
мгновенно, потому что владелец свой сайт видел.

Не делай выводов о том, чего в фактах нет. Ты не видел, как сайт выглядит,
ты видел только его признаки. Если признаков мало, ставь confidence low
и не сочиняй.

pitch_it пиши так, как пишет живой человек соседу по городку: вежливо,
на вы, без рекламных оборотов, без слов вроде moderno, professionale,
soluzione. Назови находку и что она означает для гостя. Не предлагай
услуг, это сделает само письмо, твоя задача дать одну точную фразу.

hook_ru это то же самое, но для твоего заказчика, чтобы он понимал,
что отправляет.`;

// ── факты в читаемый вид ─────────────────────────────────────────
// Модели проще читать текст, чем сырой JSON, и он вдвое короче.
// Меньше токенов на запрос это прямая экономия на каждом из 150 сайтов.
function brief(s) {
  const L = [];
  const add = (k, v) => { if (v !== null && v !== undefined && v !== "") L.push(`${k}: ${v}`); };
  const yn = (b) => (b ? "да" : "нет");

  add("Заведение", s.name + (s.town ? `, ${s.town}` : ""));
  add("Адрес", s.url);
  add("Заголовок", s.title);
  add("Описание", s.description);
  add("Платформа", s.platform || "своя вёрстка или неизвестно");
  add("Ответ сервера", `${s.ttfbMs} мс, страница ${s.htmlKb} КБ`);
  if (s.https === false) add("Защищённое соединение", `нет, ${s.httpsProblem}`);
  add("Язык страницы", s.lang);

  add("Мета viewport (адаптив под телефон)", yn(s.hasViewport));
  if (s.fixedWidthPx) add("Жёсткая ширина в пикселях", "да, вёрстка под десктоп");
  if (s.tableLayout) add("Вёрстка таблицами", "да, приём из 2000-х");

  add("Форма на странице", yn(s.hasForm));
  add("Ссылка tel:", yn(s.hasTelLink));
  add("Ссылка mailto:", yn(s.hasMailto));
  add("WhatsApp", yn(s.hasWhatsapp));
  add("Слова про бронирование", yn(s.bookingWords));

  add("Меню упомянуто", yn(s.menu?.mentioned));
  if (s.menu?.asPdf) add("Меню файлом PDF", "да");
  if (s.menu?.asImage) add("Меню картинкой", "да");
  add("Часы работы на странице", yn(s.hoursWords));
  add("Английская версия", yn(s.english));

  add("Картинок на странице", s.counts?.images);
  if (s.images?.checked)
    add("Вес картинок", `проверено ${s.images.checked}, самая тяжёлая ${s.images.heaviestKb} КБ`);

  add("Копирайт в подвале", s.copyrightYear || "не указан");
  add("Самый свежий год на странице", s.newestYearOnPage || "не найден");
  add("Последнее изменение по заголовку", s.lastModified);
  if (s.hasFlash) add("Flash", "да, технология умерла в 2020");
  if (s.jqueryOld) add("jQuery 1.x", "да, версия десятилетней давности");

  add("Соцсети", [s.social?.facebook && "Facebook", s.social?.instagram && "Instagram",
                  s.social?.tripadvisor && "TripAdvisor"].filter(Boolean).join(", ") || "не найдены");
  return L.join("\n");
}

// ── случаи, где модель не нужна ──────────────────────────────────
// Сайт вернул 404 или домен исчез. Вердикт очевиден, и платить
// за него нельзя: модель здесь не добавит ни одного слова.
// Таких у нас 38 из 188, это пятая часть счёта.
function withoutModel(s) {
  if (!s.error) return null;
  if (s.blocked) return {
    ...s, judged: "правилом",
    verdict: { state: "working", need: 0, problems: [],
      hook_ru: "Сайт закрыт от автоматических запросов, открой его руками.",
      pitch_it: "", worth_contacting: false, confidence: "low" },
  };
  const gone = /не существует|не резолвится/.test(s.error);
  return {
    ...s, judged: "правилом",
    verdict: {
      state: "dead",
      need: 100,
      problems: [{ what: gone ? "Домен больше не существует" : "Сайт не открывается",
                   evidence: s.error, severity: "high" }],
      hook_ru: gone
        ? "Их домен исчез: сайта у них фактически нет, хотя ссылка ещё ходит по справочникам."
        : `Сайт не открывается (${s.error}). Владелец может об этом не знать.`,
      pitch_it: gone
        ? `Ho provato a visitare il vostro sito ma il dominio non risulta più attivo: chi vi cerca online non vi trova.`
        : `Ho provato ad aprire il vostro sito e non si carica. Ve lo segnalo perché forse non ve ne siete accorti.`,
      worth_contacting: true,
      confidence: "high",
    },
  };
}

// ── запуск ───────────────────────────────────────────────────────
if (!existsSync(IN)) {
  console.error(`\n❌ Нет ${IN}. Сначала: node collect.mjs\n`);
  process.exit(1);
}
const all = JSON.parse(readFileSync(IN, "utf8"));
const done = !REDO && existsSync(OUT)
  ? new Map(JSON.parse(readFileSync(OUT, "utf8")).map((r) => [r.name, r]))
  : new Map();

const byRule = [];
const forModel = [];
for (const s of all) {
  if (done.has(s.name)) continue;
  const r = withoutModel(s);
  if (r) byRule.push(r); else forModel.push(s);
}
const batch = LIMIT ? forModel.slice(0, LIMIT) : forModel;

console.log(`\nВсего сайтов:            ${all.length}`);
console.log(`Уже разобрано раньше:    ${done.size}`);
console.log(`Решается правилом:       ${byRule.length}  (моделью не платим)`);
console.log(`Идёт в модель:           ${batch.length}`);

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
const client = HAS_KEY ? new Anthropic() : null;

// ── сколько это будет стоить ─────────────────────────────────────
// Считаем до запуска, а не после. Это единственный способ не узнать
// цену задним числом, когда деньги уже потрачены.
if (batch.length) {
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

   Ключ живёт только в переменной окружения, в файлы он не попадает.\n`);
  process.exit(1);
}

// ── один сайт ────────────────────────────────────────────────────
const usage = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 };

async function judge(s) {
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: EFFORT, format: zodOutputFormat(Verdict) },
    // Инструкция одна на все 150 запросов, поэтому кэшируем её:
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
  if (!res.parsed_output)
    throw new Error("ответ не разобрался по схеме");

  return { ...s, judged: "моделью", verdict: res.parsed_output };
}

const results = [...done.values(), ...byRule];
let n = 0, failed = 0;

async function worker(queue) {
  while (queue.length) {
    const s = queue.shift();
    try {
      results.push(await judge(s));
    } catch (e) {
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
const spent = (usage.in * PRICE.in + usage.out * PRICE.out +
               usage.cacheWrite * PRICE.cacheWrite + usage.cacheRead * PRICE.cacheRead) / 1e6;
const hot = results.filter((r) => r.verdict?.worth_contacting && r.verdict.need >= 60);

console.log(`\n\n📄 ${OUT}: ${results.length} вердиктов${failed ? `, не вышло ${failed}` : ""}`);
if (batch.length) {
  console.log(`\n   Потрачено:      $${spent.toFixed(3)}`);
  console.log(`   Вход:           ${usage.in} токенов`);
  console.log(`   Из кэша:        ${usage.cacheRead} токенов (в десять раз дешевле)`);
  console.log(`   Выход:          ${usage.out} токенов`);
  if (usage.cacheRead === 0 && batch.length > 1)
    console.log(`   ⚠️  Кэш не сработал ни разу. Значит инструкция меняется между запросами.`);
}
console.log(`\n   Стоит писать:   ${hot.length} заведений`);
console.log(`\n   Дальше: node eval.mjs --make 30  и проверь модель своими глазами\n`);
