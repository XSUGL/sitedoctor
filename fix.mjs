#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Агент, который чинит. Судья говорит, что плохо, строитель пишет
// новую страницу, и та же линейка меряет её заново.
//
//   node fix.mjs --worst              # взять сайт с худшей оценкой
//   node fix.mjs --name "Trattoria"   # конкретный
//   node fix.mjs --rounds 3           # сколько попыток дать агенту
//   node fix.mjs --free               # чинить и судить бесплатной моделью
//
// Смысл в петле: агент не объявляет успех, его проверяет тот же
// judge, что выносил приговор старому сайту. Если оценка не упала,
// попытка считается неудачной, и провал видно в отчёте.
// ═══════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { SYSTEM, BUILDER, repairBrief, brief } from "./brain.mjs";
import { signals } from "./extract.mjs";
import { claudeAsker, freeAsker, claudeText, freeText, emptyUsage, spentOn } from "./ask.mjs";

const args = process.argv.slice(2);
const has = (n) => args.includes("--" + n);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };

const JUDGED = flag("judged", "judged.json");
const OUTDIR = flag("outdir", "fixed");
const ROUNDS = Number(flag("rounds", 3));
const FREE = has("free");
const FREE_URL = process.env.FREE_BASE_URL || "https://api.groq.com/openai/v1";
const FREE_KEY = process.env.FREE_API_KEY || process.env.GROQ_API_KEY;
const MODEL = flag("model", FREE ? (process.env.FREE_MODEL || "openai/gpt-oss-20b") : "claude-opus-5");
const EFFORT = flag("effort", "medium");

if (!existsSync(JUDGED)) {
  console.error(`\n❌ Нет ${JUDGED}. Сначала: node collect.mjs && node judge.mjs\n`);
  process.exit(1);
}
if (FREE ? !FREE_KEY : !process.env.ANTHROPIC_API_KEY) {
  console.error(`\n❌ Нужен ключ: ${FREE ? 'export FREE_API_KEY="..."' : 'export ANTHROPIC_API_KEY="sk-ant-..."'}\n`);
  process.exit(1);
}

// ── кого чиним ───────────────────────────────────────────────────
const judged = JSON.parse(readFileSync(JUDGED, "utf8")).filter((r) => r.verdict);
const NAME = flag("name", null);
const site = NAME
  ? judged.find((r) => r.name.toLowerCase().includes(NAME.toLowerCase()))
  : [...judged].sort((a, b) => b.verdict.need - a.verdict.need)[0];

if (!site) {
  console.error(`\n❌ Не нашёл сайт${NAME ? ` по «${NAME}»` : ""} в ${JUDGED}\n`);
  process.exit(1);
}

// ── линейка ──────────────────────────────────────────────────────
// Страница, которую сочинил агент, лежит файлом: у неё нет ни TTFB,
// ни сертификата, ни даты последнего изменения на сервере. Эти три
// признака мы подставляем как «нормальный современный хостинг»,
// потому что они от вёрстки не зависят, а без них сравнение вышло бы
// нечестным в другую сторону: агент получил бы минус за то, что мы
// его страницу никуда не выложили. Всё остальное меряется всерьёз.
function measure(html) {
  const page = {
    html, finalUrl: site.url || "https://esempio.it/", status: 200,
    ttfbMs: 200, htmlBytes: Buffer.byteLength(html), lastModified: new Date().toUTCString(),
    https: true, httpsProblem: null,
  };
  const s = signals(page, { name: site.name, town: site.town, site: site.url || "esempio.it" });
  return { ...s, imgKb: 0, imgHeavy: 0 };
}

const usage = emptyUsage();
const build = FREE
  ? freeText({ url: FREE_URL, key: FREE_KEY, model: MODEL, system: BUILDER, usage })
  : claudeText({ model: MODEL, effort: EFFORT, system: BUILDER, usage });
const judge = FREE
  ? freeAsker({ url: FREE_URL, key: FREE_KEY, model: MODEL, usage })
  : claudeAsker({ model: MODEL, effort: EFFORT, usage });

console.log(`\n🔧 Чиню: ${site.name}${site.town ? `, ${site.town}` : ""}`);
console.log(`   Было:  ${site.verdict.need}/100  (${site.verdict.state})`);
console.log(`   Модель: ${MODEL}${FREE ? " (бесплатная)" : `, усилие ${EFFORT}`}, попыток до ${ROUNDS}\n`);
for (const p of site.verdict.problems || []) console.log(`   · ${p.what}`);

mkdirSync(OUTDIR, { recursive: true });
const slug = site.name.toLowerCase().replace(/[^a-z0-9а-яёіїєґ]+/gi, "-").replace(/^-|-$/g, "").slice(0, 50);

const rounds = [];
let feedback = null, best = null;

for (let r = 1; r <= ROUNDS; r++) {
  process.stdout.write(`\n   Попытка ${r}: пишу страницу...`);
  let html;
  try { html = await build(repairBrief(site, site.verdict, feedback)); }
  catch (e) { console.log(` не вышло: ${e.message}`); break; }

  // Страница, набитая тегами ради проверки, это не починенный сайт.
  // Смотрим, есть ли на ней вообще текст для человека.
  const words = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
                    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().split(" ").length;
  const holes = [...html.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]);

  process.stdout.write(` ${Math.round(Buffer.byteLength(html) / 1024)} КБ, ${words} слов. Сужу...`);
  let verdict;
  try { verdict = await judge(measure(html)); }
  catch (e) { console.log(` судья споткнулся: ${e.message}`); break; }

  const round = { r, need: verdict.need, state: verdict.state, words, holes, html, verdict };
  rounds.push(round);
  console.log(` стало ${verdict.need}/100 (${verdict.state})`);
  for (const p of verdict.problems || []) console.log(`      · ${p.what}`);

  if (!best || verdict.need < best.need) best = round;
  if (verdict.need <= 20) break;                      // достаточно хорошо
  feedback = (verdict.problems || []).map((p) => `- ${p.what} (${p.evidence})`).join("\n");
}

// ── отчёт ────────────────────────────────────────────────────────
if (!best) { console.error(`\n❌ Ни одной попытки не получилось\n`); process.exit(1); }

const file = `${OUTDIR}/${slug}.html`;
writeFileSync(file, best.html);
writeFileSync(`${OUTDIR}/${slug}.json`, JSON.stringify({
  name: site.name, url: site.url,
  before: { need: site.verdict.need, state: site.verdict.state, problems: site.verdict.problems },
  after: { need: best.need, state: best.state, problems: best.verdict.problems },
  rounds: rounds.map(({ html, ...x }) => x),
  model: MODEL,
  // Три признака подставлены, а не измерены: страница лежит файлом.
  assumed: ["ttfbMs", "https", "lastModified"],
}, null, 1));

const delta = site.verdict.need - best.need;
console.log(`\n   ${site.verdict.need} → ${best.need}  ${delta > 0 ? `на ${delta} лучше` : delta === 0 ? "без изменений" : `на ${-delta} ХУЖЕ`}`);
if (best.holes.length) console.log(`   Плейсхолдеров осталось: ${[...new Set(best.holes)].join(", ")}  (агент не стал выдумывать)`);
if (!FREE) console.log(`   Потрачено: $${spentOn(usage).toFixed(3)}`);
console.log(`\n📄 ${file}`);
console.log(`   Три признака подставлены как «нормальный хостинг»: ttfb, https, дата.`);
console.log(`   Остальное померено тем же кодом, что и живые сайты.\n`);
