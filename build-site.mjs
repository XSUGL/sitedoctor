#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Готовит данные для дашборда: складывает факты и вердикты
// в один компактный файл, который отдаёт Worker.
//
//   node build-site.mjs
// ═══════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : []);
const signals = read("signals.json");
const judged = read("judged.json");

if (!signals.length) {
  console.error("\n❌ Нет signals.json. Сначала: node collect.mjs\n");
  process.exit(1);
}

// По адресу, а не по названию: две точки одной фирмы называются одинаково,
// и вердикт одной подставился бы обеим.
const verdicts = new Map(judged.map((r) => [r.url || r.name, r]));

// В браузер отправляем только то, что там показывается. Лишние поля
// это лишние килобайты на каждом открытии страницы.
const rows = signals.map((s) => {
  const j = verdicts.get(s.url || s.name);
  const v = j?.verdict;
  return {
    name: s.name,
    town: s.town || "",
    url: s.url,
    error: s.error || null,
    blocked: s.blocked || false,

    // признаки, по которым фильтруем
    viewport: s.hasViewport ?? null,
    form: (s.hasForm || s.hasTelLink) ?? null,
    menuFlat: (s.menu?.asPdf || s.menu?.asImage) ?? false,
    hours: s.hoursWords ?? null,
    english: s.english ?? null,
    https: s.https ?? null,
    heavyKb: s.images?.heaviestKb ?? 0,
    ttfb: s.ttfbMs ?? null,
    year: s.copyrightYear ?? null,
    platform: s.platform || null,

    // вердикт
    judged: j?.judged || null,
    need: v?.need ?? null,
    state: v?.state || null,
    write: v?.worth_contacting ?? null,
    conf: v?.confidence || null,
    problems: v?.problems || [],
    ru: v?.hook_ru || "",
    it: v?.pitch_it || "",
  };
});

rows.sort((a, b) => (b.need ?? -1) - (a.need ?? -1) || a.name.localeCompare(b.name));

const evalLog = read("eval-log.json");
const payload = {
  builtAt: new Date().toISOString(),
  rows,
  evals: evalLog.map((e) => ({ at: e.at, n: e.n, mae: e.mae, f1: e.f1,
                               prec: e.prec, rec: e.rec, fp: e.fp, fn: e.fn, note: e.note })),
};

mkdirSync("site/public", { recursive: true });
writeFileSync("site/public/data.json", JSON.stringify(payload));

const judgedN = rows.filter((r) => r.need !== null).length;
const kb = Math.round(JSON.stringify(payload).length / 1024);
console.log(`\n📦 site/public/data.json  ${rows.length} сайтов, ${judgedN} с вердиктом, ${kb} КБ`);

// ── встраивание в основной сайт ──────────────────────────────────
// Файл в папке ассетов Cloudflare отдаётся ДО того, как отработает
// Worker, то есть в обход пароля. Поэтому и страницу, и данные
// зашиваем прямо в сборку Worker'а: наружу они уйдут только после
// проверки доступа. Так же там устроен /stats.
const YSITE = `${process.env.HOME}/ysite/worker`;
if (existsSync(YSITE)) {
  const html = readFileSync("site/public/index.html", "utf8");
  const lit = (s) => "`" + s.replace(/\\/g, "\\\\").replace(/`/g, "\\`")
                            .replace(/\$\{/g, "\\${") + "`";

  writeFileSync(`${YSITE}/doctor-page.js`,
    `// Сгенерировано: cd ~/sitedoctor && node build-site.mjs\n` +
    `// Править надо ~/sitedoctor/site/public/index.html, не этот файл.\n` +
    `export const DOCTOR_HTML = ${lit(html)};\n`);

  writeFileSync(`${YSITE}/doctor-data.js`,
    `// Сгенерировано: cd ~/sitedoctor && node build-site.mjs\n` +
    `export const DOCTOR_DATA = ${JSON.stringify(payload)};\n`);

  console.log(`📦 ~/ysite/worker/doctor-page.js и doctor-data.js обновлены`);
  console.log(`\n   Выложить на свой домен:\n`);
  console.log(`     cd ~/ysite && npx wrangler deploy`);
  console.log(`\n   Потом открой yaroslavyuzvak.info/doctor с тем же паролем, что и /stats\n`);
} else {
  console.log(`\n   Отдельным сайтом:  cd site && npx wrangler deploy\n`);
}
