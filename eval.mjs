#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Шаг 3: проверить, а хорошо ли модель судит.
//
// Это то, что отличает инженера от человека, который дёргает API.
// «Работает» это не мнение, а число, и оно должно расти, когда ты
// правишь промпт, и падать, когда ты его ломаешь.
//
//   node eval.mjs --make 30    # создать golden.csv на 30 сайтов
//   node eval.mjs              # сравнить свои оценки с оценками модели
//   node eval.mjs --worst 10   # где расходимся сильнее всего
// ═══════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const has = (n) => args.includes("--" + n);

const JUDGED = flag("judged", "judged.json");
const GOLDEN = flag("golden", "golden.csv");
const MAKE = Number(flag("make", 0));
const WORST = Number(flag("worst", 8));

if (!existsSync(JUDGED)) {
  console.error(`\n❌ Нет ${JUDGED}. Сначала: node judge.mjs\n`);
  process.exit(1);
}
const judged = JSON.parse(readFileSync(JUDGED, "utf8"));

// ── создать заготовку для разметки ───────────────────────────────
// Размечать надо ДО того, как посмотришь ответ модели. Иначе
// ты не оцениваешь сайт, а соглашаешься с моделью, и число выйдет
// красивое и бессмысленное.
if (MAKE) {
  if (existsSync(GOLDEN)) {
    console.error(`\n❌ ${GOLDEN} уже есть. Удали его сам, если правда хочешь начать заново.\n`);
    process.exit(1);
  }
  // Берём вперемешку, а не первые по алфавиту: иначе выборка
  // окажется из одних агритуризмо на букву А.
  const pool = judged.filter((r) => r.verdict && r.judged === "моделью");
  const src = pool.length >= MAKE ? pool : judged.filter((r) => r.verdict);
  const pick = [...src].sort(() => Math.random() - 0.5).slice(0, MAKE)
    .sort((a, b) => a.name.localeCompare(b.name));

  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["Заведение", "Сайт", "Твой балл 0-100", "Писать им? да/нет", "Заметка"].map(esc).join(",")];
  for (const r of pick) rows.push([r.name, r.url, "", "", ""].map(esc).join(","));
  writeFileSync(GOLDEN, "﻿" + rows.join("\n"));

  console.log(`\n📝 ${GOLDEN}: ${pick.length} сайтов для разметки.

   Открой его в Numbers и пройди сам, своими глазами:

     open ${GOLDEN}

   По каждому открой сайт НА ТЕЛЕФОНЕ и поставь:
     балл 0-100  насколько ему нужна переделка
     да/нет      написал бы ты им на самом деле

   Смотри на сайт, а не на вердикт модели. В этом весь смысл:
   ты создаёшь эталон, с которым её потом сравнивают.

   Полчаса работы. Это самые полезные полчаса во всём проекте:
   без них ты не сможешь сказать, стало лучше или хуже.\n`);
  process.exit(0);
}

// ── прочитать разметку ───────────────────────────────────────────
if (!existsSync(GOLDEN)) {
  console.error(`\n❌ Нет ${GOLDEN}. Создай заготовку: node eval.mjs --make 30\n`);
  process.exit(1);
}
const lines = readFileSync(GOLDEN, "utf8").replace(/^﻿/, "").trim().split("\n");
const gold = [];
for (const l of lines.slice(1)) {
  const c = l.match(/"([^"]|"")*"/g)?.map((x) => x.slice(1, -1).replace(/""/g, '"')) || [];
  const [name, , need, write, note] = c;
  if (!name || need === "" || need === undefined) continue;
  gold.push({
    name: name.trim(),
    need: Number(need),
    write: /^(да|yes|y|1|true)$/i.test((write || "").trim()),
    note: note || "",
  });
}

if (!gold.length) {
  console.error(`\n❌ В ${GOLDEN} нет ни одной заполненной строки.
   Заполни колонку «Твой балл» хотя бы у двадцати сайтов.\n`);
  process.exit(1);
}

// ── сопоставить ──────────────────────────────────────────────────
const byName = new Map(judged.map((r) => [r.name, r]));
const pairs = [];
for (const g of gold) {
  const j = byName.get(g.name);
  if (j?.verdict) pairs.push({ ...g, m: j.verdict, url: j.url, judged: j.judged });
}

if (!pairs.length) {
  console.error(`\n❌ Ни одно название из ${GOLDEN} не нашлось в ${JUDGED}.\n`);
  process.exit(1);
}

// ── метрики ──────────────────────────────────────────────────────
// Ошибка в баллах говорит, насколько модель промахивается в оценке.
// Но решение бинарное: писать или нет. Поэтому главные числа ниже.
const errs = pairs.map((p) => Math.abs(p.need - p.m.need));
const mae = errs.reduce((a, b) => a + b, 0) / errs.length;

// Матрица ошибок. Два вида промаха стоят по-разному, и это важно:
const tp = pairs.filter((p) => p.write && p.m.worth_contacting).length;
const fp = pairs.filter((p) => !p.write && p.m.worth_contacting).length;   // дорогая
const fn = pairs.filter((p) => p.write && !p.m.worth_contacting).length;   // дешёвая
const tn = pairs.filter((p) => !p.write && !p.m.worth_contacting).length;

const acc = (tp + tn) / pairs.length;
const prec = tp + fp ? tp / (tp + fp) : 0;
const rec = tp + fn ? tp / (tp + fn) : 0;
const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;

const pc = (x) => `${Math.round(x * 100)}%`;
console.log(`\n📊 Сверено ${pairs.length} сайтов из ${gold.length} размеченных\n`);
console.log(`   Средняя ошибка в баллах    ${mae.toFixed(1)} из 100`);
console.log(`   Совпадение решения         ${pc(acc)}`);
console.log(`   Точность                   ${pc(prec)}   из тех, кому модель велела писать, ты бы написал стольким`);
console.log(`   Полнота                    ${pc(rec)}   из тех, кому ты бы написал, модель нашла столько`);
console.log(`   F1                         ${f1.toFixed(2)}\n`);

console.log(`   Модель зовёт писать, ты бы не стал:  ${fp}  ← дорогая ошибка`);
console.log(`   Ты бы написал, модель отговорила:    ${fn}  ← дешёвая ошибка\n`);

if (fp > fn) {
  console.log(`   Промахи в дорогую сторону. Ложный повод в письме бьёт по доверию:
   владелец свой сайт видел. Ужесточи в промпте требование не сочинять
   проблемы и поднять планку worth_contacting.\n`);
} else if (fn > fp) {
  console.log(`   Модель слишком осторожна и теряет живых кандидатов.
   Смягчи в промпте формулировку про «будь честен, когда чинить нечего».\n`);
}

// ── где расходимся сильнее всего ─────────────────────────────────
// Ради этого списка eval и существует. Средние числа говорят,
// что что-то не так, а этот список говорит, что именно чинить.
const worst = [...pairs].sort((a, b) => Math.abs(b.need - b.m.need) - Math.abs(a.need - a.m.need))
  .slice(0, WORST);

console.log(`   Самые крупные расхождения:\n`);
for (const p of worst) {
  const d = p.m.need - p.need;
  console.log(`   ${p.name.slice(0, 38).padEnd(38)} ты ${String(p.need).padStart(3)}  ` +
              `модель ${String(p.m.need).padStart(3)}  (${d > 0 ? "+" : ""}${d})`);
  console.log(`      модель: ${p.m.problems?.[0]?.what || "проблем не нашла"}`);
  if (p.note) console.log(`      ты:     ${p.note}`);
}

// ── сохранить замер, чтобы сравнивать прогоны ────────────────────
// Без истории ты не докажешь, что промпт стал лучше: память врёт,
// а «мне кажется, теперь точнее» не аргумент.
const LOG = "eval-log.json";
const log = existsSync(LOG) ? JSON.parse(readFileSync(LOG, "utf8")) : [];
const entry = { at: new Date().toISOString(), n: pairs.length,
                mae: +mae.toFixed(1), acc: +acc.toFixed(3), prec: +prec.toFixed(3),
                rec: +rec.toFixed(3), f1: +f1.toFixed(3), fp, fn,
                note: flag("note", "") };
log.push(entry);
writeFileSync(LOG, JSON.stringify(log, null, 1));

if (log.length > 1) {
  const prev = log[log.length - 2];
  const arrow = (now, before, less = false) => {
    const d = now - before;
    if (Math.abs(d) < 0.005) return "без изменений";
    const better = less ? d < 0 : d > 0;
    return `${d > 0 ? "+" : ""}${d.toFixed(2)} ${better ? "лучше" : "хуже"}`;
  };
  console.log(`\n   Против прошлого прогона:`);
  console.log(`      ошибка в баллах  ${arrow(entry.mae, prev.mae, true)}`);
  console.log(`      F1               ${arrow(entry.f1, prev.f1)}`);
}
console.log(`\n   Замер записан в ${LOG} (всего прогонов: ${log.length})\n`);
