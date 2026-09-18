#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Каскад: сначала спрашиваем бесплатную модель, дорогую подключаем
// только там, где дешёвая сама признаёт, что не уверена.
//
//   node cascade.mjs --limit 20        # прогнать каскадом
//   node cascade.mjs --compare --limit 20   # обе модели на каждом сайте
//
// Смысл не в том, чтобы сэкономить на ста пятидесяти сайтах: там
// экономятся доллары. Смысл в числе, которое получается на выходе:
// "столько же качества за столько-то процентов денег". Без эталона
// из eval.mjs это число не существует, поэтому каскад и живёт рядом.
//
// Доступ:  export FREE_API_KEY="..."  и  export ANTHROPIC_API_KEY="..."
// ═══════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { withoutModel } from "./brain.mjs";
import { claudeAsker, freeAsker, emptyUsage, spentOn } from "./ask.mjs";

const args = process.argv.slice(2);
const has = (n) => args.includes("--" + n);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };

const IN = flag("in", "signals.json");
const OUT = flag("out", "judged-cascade.json");
const LIMIT = Number(flag("limit", 0));
const COMPARE = has("compare");
const GAP = Number(flag("gap", 2200));

const FREE_URL = process.env.FREE_BASE_URL || "https://api.groq.com/openai/v1";
const FREE_KEY = process.env.FREE_API_KEY || process.env.GROQ_API_KEY;
const FREE_MODEL = flag("free-model", process.env.FREE_MODEL || "openai/gpt-oss-20b");
const BIG_MODEL = flag("model", "claude-opus-5");
const EFFORT = flag("effort", "medium");

// ── правило эскалации ────────────────────────────────────────────
// Три причины позвать дорогую модель, и все три проверяемы:
//   1. дешёвая сама сказала, что не уверена;
//   2. балл попал в полосу вокруг решения "писать или нет" - именно
//      там ошибка меняет ответ, а не просто сдвигает число;
//   3. дешёвая вообще не справилась.
// Полосу можно двигать: чем она шире, тем дороже и точнее.
const [LO, HI] = String(flag("band", "40:70")).split(":").map(Number);

function whyEscalate(v) {
  if (!v) return "дешёвая не справилась";
  if (v.confidence === "low") return "низкая уверенность";
  if (v.need >= LO && v.need <= HI) return `балл ${v.need} в спорной полосе ${LO}-${HI}`;
  return null;
}

// ── что судим ────────────────────────────────────────────────────
if (!existsSync(IN)) {
  console.error(`\n❌ Нет ${IN}. Сначала: node collect.mjs\n`);
  process.exit(1);
}
if (!FREE_KEY) {
  console.error(`\n❌ Нужен бесплатный ключ: export FREE_API_KEY="..."  (console.groq.com)\n`);
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(`\n❌ Нужен и платный ключ: export ANTHROPIC_API_KEY="sk-ant-..."
   Каскад без дорогой модели это просто бесплатный прогон: node judge.mjs --free\n`);
  process.exit(1);
}

const all = JSON.parse(readFileSync(IN, "utf8"));
const forModel = all.filter((s) => !withoutModel(s));
const batch = LIMIT ? forModel.slice(0, LIMIT) : forModel;

console.log(`\nСайтов на разбор:        ${batch.length}  (правила отсеяли ${all.length - forModel.length})`);
console.log(`Ступень 1:               ${FREE_MODEL}  бесплатно`);
console.log(`Ступень 2:               ${BIG_MODEL}, усилие ${EFFORT}`);
console.log(COMPARE
  ? `Режим:                   сравнение - обе модели на каждом сайте, чтобы выбрать полосу`
  : `Эскалация:               низкая уверенность или балл в полосе ${LO}-${HI}`);

const freeUsage = emptyUsage(), bigUsage = emptyUsage();
const askFree = freeAsker({ url: FREE_URL, key: FREE_KEY, model: FREE_MODEL, usage: freeUsage });
const askBig = claudeAsker({ model: BIG_MODEL, effort: EFFORT, usage: bigUsage });

const results = [];
let n = 0, escalated = 0, failed = 0;

for (const s of batch) {
  n++;
  process.stdout.write(`\r   ${n}/${batch.length}  ${s.name.slice(0, 40).padEnd(40)}`);

  // Лимит бесплатного тарифа это не отказ, а просьба подождать.
  // Ждём и спрашиваем снова, но сайт из прогона не выбрасываем:
  // иначе на входе четыре сайта, на выходе три, и никто не заметит.
  let cheap = null, cheapError = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { cheap = await askFree(s); break; }
    catch (e) {
      if (!e.retryAfter) { cheapError = e.message; break; }
      if (attempt === 5) { cheapError = e.message; break; }
      await new Promise((r) => setTimeout(r, (e.retryAfter + 1) * 1000));
    }
  }

  const why = COMPARE ? "режим сравнения" : whyEscalate(cheap);
  let big = null;
  if (why) {
    try { big = await askBig(s); escalated++; }
    catch (e) { failed++; }
  }

  results.push({
    ...s,
    judged: big ? "каскадом (дорогая)" : "каскадом (дешёвая)",
    verdict: big || cheap,
    cascade: {
      escalated: Boolean(big),
      why: why || null,
      cheap,
      cheapError,
      big: COMPARE ? big : undefined,
    },
  });
  writeFileSync(OUT, JSON.stringify(results, null, 1));
  if (n < batch.length) await new Promise((r) => setTimeout(r, GAP));
}

// ── что это дало ─────────────────────────────────────────────────
const bigSpent = spentOn(bigUsage);
const perSite = escalated ? bigSpent / escalated : 0;
const allBig = perSite * batch.length;

console.log(`\n\n📄 ${OUT}: ${results.length} вердиктов${failed ? `, не вышло ${failed}` : ""}`);
console.log(`\n   Решено бесплатно:   ${results.length - escalated} из ${results.length}`);
console.log(`   Ушло к дорогой:     ${escalated}  (${Math.round(escalated / results.length * 100)}%)`);
console.log(`\n   Потрачено:          $${bigSpent.toFixed(3)}`);
if (escalated && !COMPARE) {
  console.log(`   Если бы все к ней:  $${allBig.toFixed(3)}`);
  console.log(`   Экономия:           ${Math.round((1 - bigSpent / allBig) * 100)}%`);
}

if (COMPARE) {
  // Обе модели ответили на всё, значит можно померить согласие и
  // прикинуть, что дала бы каждая полоса. Это и есть способ выбрать
  // полосу числом, а не на глаз.
  const both = results.filter((r) => r.cascade.cheap && r.cascade.big);
  const agree = both.filter((r) => r.cascade.cheap.worth_contacting === r.cascade.big.worth_contacting);
  const mae = both.reduce((a, r) => a + Math.abs(r.cascade.cheap.need - r.cascade.big.need), 0) / (both.length || 1);
  console.log(`\n   Согласие по решению: ${agree.length}/${both.length} (${Math.round(agree.length / (both.length || 1) * 100)}%)`);
  console.log(`   Средний разрыв в баллах: ${mae.toFixed(1)}`);
  console.log(`\n   Что дала бы полоса (доля к дорогой / ошибок решения среди оставшихся):`);
  for (const [lo, hi] of [[0, 0], [45, 60], [40, 70], [35, 80], [0, 100]]) {
    const esc = both.filter((r) => {
      const v = r.cascade.cheap;
      return v.confidence === "low" || (v.need >= lo && v.need <= hi && hi > 0);
    });
    const kept = both.filter((r) => !esc.includes(r));
    const wrong = kept.filter((r) => r.cascade.cheap.worth_contacting !== r.cascade.big.worth_contacting);
    const label = hi === 0 ? "только низкая уверенность" : lo === 0 && hi === 100 ? "всё к дорогой" : `${lo}-${hi}`;
    console.log(`     ${label.padEnd(26)} ${String(Math.round(esc.length / both.length * 100) + "%").padStart(4)} к дорогой, ` +
                `ошибок ${wrong.length} из ${kept.length}`);
  }
}

console.log(`\n   Дальше: node eval.mjs --judged ${OUT}  и сравни F1 с обычным прогоном\n`);
