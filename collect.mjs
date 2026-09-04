#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Шаг 1: собрать факты о сайте. МОДЕЛЬ ЗДЕСЬ НЕ УЧАСТВУЕТ.
//
// Всё, на что может ответить регулярка или заголовок ответа, должно
// отвечать бесплатно. Модель дороже кода в тысячи раз и иногда врёт,
// поэтому её работа начинается там, где кода уже не хватает: оценить,
// выглядит ли сайт живым, и что владельцу чинить первым.
//
//   node collect.mjs --url https://example.it     # один сайт
//   node collect.mjs --limit 20                   # первые 20 из списка
//   node collect.mjs                              # весь список
// ═══════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };

const ONE = flag("url", "");
const LIMIT = Number(flag("limit", 0));
// Свой список задаётся флагом --source. По умолчанию берём тот, что рядом
// с проектом, а если его нет, шаблон из examples: репозиторий должен
// запускаться у любого, кто его склонировал, а не только на моей машине.
const SOURCE = flag("source",
  [`${process.env.HOME}/leadfinder/all-emails.csv`, "sites.csv", "examples/sample-sites.csv"]
    .find((p) => existsSync(p)) || "sites.csv");
const OUT = flag("out", "signals.json");
const CONCURRENCY = 6;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/131.0 Safari/537.36";

// ── откуда берём список ──────────────────────────────────────────
function loadTargets() {
  if (ONE) return [{ name: new URL(norm(ONE)).hostname, site: norm(ONE) }];
  if (!existsSync(SOURCE)) {
    console.error(`\n❌ Нет файла ${SOURCE}. Укажи свой: --source путь.csv\n`);
    process.exit(1);
  }
  const lines = readFileSync(SOURCE, "utf8").replace(/^﻿/, "").trim().split("\n");
  const out = [];
  for (const l of lines.slice(1)) {
    const c = l.match(/"([^"]|"")*"/g)?.map((x) => x.slice(1, -1).replace(/""/g, '"')) || [];
    const [name, , , town, site] = c;
    if (name && site && site !== "нет") out.push({ name, town: town || "", site: norm(site) });
  }
  return LIMIT ? out.slice(0, LIMIT) : out;
}

const norm = (u) => (/^https?:\/\//i.test(u) ? u : "https://" + u);

// Сетевые ошибки Node прячет под общим "fetch failed". Настоящая причина
// лежит в e.cause.code, и разница принципиальная: протухший сертификат
// это находка для письма, а несуществующий домен это конец разговора.
const REASON = {
  ENOTFOUND: "домен не существует",
  EAI_AGAIN: "домен не резолвится",
  ECONNREFUSED: "сервер отклоняет соединение",
  ECONNRESET: "сервер оборвал соединение",
  ETIMEDOUT: "сервер не отвечает",
  CERT_HAS_EXPIRED: "сертификат просрочен",
  ERR_TLS_CERT_ALTNAME_INVALID: "сертификат выписан на другой домен",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "сертификату нельзя доверять",
  DEPTH_ZERO_SELF_SIGNED_CERT: "самоподписанный сертификат",
  SELF_SIGNED_CERT_IN_CHAIN: "самоподписанный сертификат в цепочке",
};
const why = (e) => {
  if (e.name === "TimeoutError") return "не ответил за 20 секунд";
  const code = e.cause?.code || e.code;
  return REASON[code] || (code ? `сеть: ${code}` : e.message);
};

// ── загрузка страницы ────────────────────────────────────────────
async function once(url, ms) {
  const t0 = Date.now();
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": UA, "Accept-Language": "it-IT,it;q=0.9,en;q=0.8" },
    signal: AbortSignal.timeout(ms),
  });
  const html = await res.text();
  return {
    status: res.status,
    finalUrl: res.url,
    ttfbMs: Date.now() - t0,
    htmlBytes: Buffer.byteLength(html),
    lastModified: res.headers.get("last-modified") || null,
    server: res.headers.get("server") || null,
    html,
  };
}

async function grab(url, ms = 20000) {
  try {
    const page = await once(url, ms);
    return { ...page, https: true, httpsProblem: null };
  } catch (e) {
    // https не вышел. Пробуем http: если так сайт открывается, значит
    // он работает, но браузер показывает посетителю «не защищено».
    // Это лучший повод для письма из всех возможных.
    if (!url.startsWith("https://")) throw e;
    const reason = why(e);
    const page = await once(url.replace(/^https:/, "http:"), ms);
    return { ...page, https: false, httpsProblem: reason };
  }
}

// Вес картинок: HEAD по первым шести. Тяжёлая главная фотка на 5 МБ
// это реальная находка, из-за неё сайт на телефоне открывается вечность.
async function weighImages(urls) {
  let bytes = 0, checked = 0, heaviest = 0, heaviestUrl = null;
  for (const u of urls.slice(0, 6)) {
    try {
      const r = await fetch(u, { method: "HEAD", headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(8000) });
      const n = Number(r.headers.get("content-length") || 0);
      if (n > 0) {
        bytes += n; checked++;
        if (n > heaviest) { heaviest = n; heaviestUrl = u; }
      }
    } catch { /* картинка не отдалась, это само по себе не диагноз */ }
  }
  return { checked, totalKb: Math.round(bytes / 1024),
           heaviestKb: Math.round(heaviest / 1024), heaviestUrl };
}

// ── разбор страницы: только факты, без выводов ───────────────────
function signals(page, target) {
  const h = page.html;
  const low = h.toLowerCase();
  const base = new URL(page.finalUrl);
  const abs = (u) => { try { return new URL(u, base).href; } catch { return null; } };

  const tag = (re) => (h.match(re) || [])[1]?.trim() || null;
  const all = (re) => [...h.matchAll(re)].map((m) => m[1]);

  const imgs = all(/<img[^>]+src=["']([^"']+)["']/gi).map(abs).filter(Boolean);
  const links = all(/<a[^>]+href=["']([^"']+)["']/gi);
  const scripts = all(/<script[^>]+src=["']([^"']+)["']/gi);
  const styles = all(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/gi);

  // На чём собран сайт. Конструктор сам по себе не приговор, но
  // бесплатный поддомен вроде wixsite.com владелец обычно и хочет заменить.
  const platform =
    /wix\.com|wixstatic|wixsite/.test(low) ? "Wix" :
    /wp-content|wp-includes/.test(low) ? "WordPress" :
    /squarespace/.test(low) ? "Squarespace" :
    /shopify/.test(low) ? "Shopify" :
    /joomla/.test(low) ? "Joomla" :
    /altervista/.test(low) ? "Altervista" :
    /jimdo/.test(low) ? "Jimdo" :
    /weebly/.test(low) ? "Weebly" :
    /sites\.google\.com/.test(low) ? "Google Sites" :
    /blogspot/.test(low) ? "Blogspot" : null;

  // Меню картинкой или PDF: болезнь именно ресторанов. На телефоне
  // такое меню нечитаемо, а поиск его не индексирует.
  //
  // Ловушка: слово menu на сайте почти всегда означает навигацию, а не еду.
  // Ссылка /menu/ это раздел сайта, menu-icon.svg это иконка бургера.
  // Без этих исключений признак срабатывал на каждом втором сайте,
  // и модель уверенно сообщала о проблеме, которой нет.
  const NOISE = /icon|burger|hamburger|nav|arrow|sprite|logo|btn|button|bullet|toggle|mobile.?menu|main.?menu|menu.?item/i;
  // Слово carta по-итальянски это ещё и бумага, карта, удостоверение.
  // На нём признак ловил налоговые консультации и канцелярские магазины,
  // поэтому осталось только сочетание carta dei vini.
  const FOOD = /men[uù]|listino|piatti|carta[-_ ]?dei[-_ ]?vini/i;

  // Якорь вида #menu это переход по той же странице, то есть навигация.
  // Отрезаем всё после решётки, прежде чем проверять.
  const menuLinks = links
    .filter((u) => !u.startsWith("#"))
    .filter((u) => FOOD.test(u.split("#")[0]) && !NOISE.test(u));
  const menuPdf = menuLinks.some((u) => /\.pdf(\?|$)/i.test(u));

  // Признака «меню картинкой» здесь больше нет, и это осознанное решение.
  // Он определялся по имени файла, и на живых данных дал семь срабатываний
  // при нуле попаданий: menu-mobile.png, menu-chi-siamo.png, Model-Menu.png
  // это всё навигация, а не еда. Имя файла просто не доказывает содержимое.
  // Признак, который всегда ошибается, хуже отсутствующего: он заставляет
  // модель уверенно сообщать владельцу о проблеме, которой нет.
  // Ссылка на PDF таким свойством не страдает: четыре из четырёх верны.
  const menuImage = false;
  const menuInText = /\bmen[uù]\b/i.test(h);

  // Годы в подвале: если самый свежий 2019, сайт брошен.
  const years = [...h.matchAll(/(?:©|&copy;|copyright)[^0-9]{0,20}((?:19|20)\d\d)/gi)]
    .map((m) => Number(m[1]));
  const anyYears = [...h.matchAll(/\b(20[0-2]\d)\b/g)].map((m) => Number(m[1]))
    .filter((y) => y >= 2005 && y <= new Date().getFullYear());

  return {
    name: target.name,
    town: target.town || "",
    url: page.finalUrl,
    redirected: page.finalUrl.replace(/\/$/, "") !== norm(target.site).replace(/\/$/, ""),
    status: page.status,

    // скорость и вес
    ttfbMs: page.ttfbMs,
    htmlKb: Math.round(page.htmlBytes / 1024),
    lastModified: page.lastModified,
    platform,
    https: page.https,
    httpsProblem: page.httpsProblem,

    // что вообще на странице
    title: tag(/<title[^>]*>([^<]{0,200})/i),
    description: tag(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,300})/i),
    lang: tag(/<html[^>]+lang=["']([a-z-]{2,5})["']/i),
    counts: { images: imgs.length, links: links.length,
              scripts: scripts.length, styles: styles.length },

    // телефон
    hasViewport: /<meta[^>]+name=["']viewport["']/i.test(h),
    fixedWidthPx: /width\s*[:=]\s*["']?\s*(9[0-9]{2}|1[0-9]{3})\s*(px)?/i.test(h),
    tableLayout: (h.match(/<table/gi) || []).length >= 3,

    // как с ними связаться
    hasForm: /<form[\s>]/i.test(h),
    hasTelLink: /href=["']tel:/i.test(h),
    hasMailto: /href=["']mailto:/i.test(h),
    hasWhatsapp: /wa\.me|api\.whatsapp/i.test(low),
    bookingWords: /prenot|riserv|book now|prenota/i.test(h),

    // меню и часы
    menu: { mentioned: menuInText, asPdf: menuPdf, asImage: menuImage,
            links: menuLinks.slice(0, 3).map(abs).filter(Boolean) },
    hoursWords: /orari|aperto|chiuso|lun|mar|mer|gio|ven|sab|dom/i.test(h)
                && /\d{1,2}[:.]\d{2}/.test(h),

    // языки
    english: /hreflang=["']en/i.test(h) || /\/en[\/"']/.test(h)
             || /\b(home|contact us|book a table)\b/i.test(h),

    // соцсети
    social: {
      facebook: /facebook\.com\//i.test(low),
      instagram: /instagram\.com\//i.test(low),
      tripadvisor: /tripadvisor\./i.test(low),
    },

    // возраст
    copyrightYear: years.length ? Math.max(...years) : null,
    newestYearOnPage: anyYears.length ? Math.max(...anyYears) : null,

    // древности
    hasFlash: /\.swf\b|application\/x-shockwave/i.test(low),
    jqueryOld: /jquery[.-]?1\.\d/i.test(low),

    _images: imgs,   // служебное, для взвешивания; в отчёт не идёт
  };
}

// ── один сайт целиком ────────────────────────────────────────────
async function inspect(target) {
  const stub = (extra) => ({ name: target.name, town: target.town || "",
                             url: norm(target.site), ...extra });
  try {
    const page = await grab(norm(target.site));

    // Страница с кодом 4xx или 5xx это не сайт, а заглушка. Разобрать её
    // как обычную значит получить запись, где все признаки false, и модель
    // уверенно напишет «у них нет ни меню, ни часов». Такой вывод хуже,
    // чем отсутствие вывода, поэтому обрываем здесь.
    if (page.status >= 400) {
      const blocked = page.status === 403 || page.status === 429;
      return stub({
        status: page.status,
        // 403 почти всегда защита от ботов, а не поломка. Разница важная:
        // владельцу нечего чинить, просто мы не видим страницу.
        error: blocked
          ? `${page.status}: сайт закрыт от автоматических запросов, смотреть руками`
          : `${page.status}: страница не отдаётся`,
        blocked,
      });
    }

    const s = signals(page, target);
    s.images = await weighImages(s._images);
    delete s._images;
    s.error = null;
    return s;
  } catch (e) {
    // Недоступный сайт это тоже вердикт, и часто самый ценный:
    // владелец может не знать, что его сайт лежит.
    return stub({ error: why(e) });
  }
}

// ── прогон с ограничением одновременных запросов ─────────────────
const targets = loadTargets();
console.log(`\n🔍 Смотрю ${targets.length} сайт(ов), по ${CONCURRENCY} за раз\n`);

const results = [];
let done = 0;
async function worker(queue) {
  while (queue.length) {
    const t = queue.shift();
    const r = await inspect(t);
    results.push(r);
    done++;
    const mark = r.error ? "✗" : "·";
    process.stdout.write(`\r   ${mark} ${done}/${targets.length}  ${r.name.slice(0, 40).padEnd(40)}`);
  }
}
const queue = [...targets];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

results.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(OUT, JSON.stringify(results, null, 1));

// ── что получилось ───────────────────────────────────────────────
const live = results.filter((r) => !r.error);
const pct = (n) => `${Math.round((n / live.length) * 100)}%`.padStart(4);
const count = (fn) => live.filter(fn).length;

const blocked = results.filter((r) => r.blocked).length;
const broken = results.length - live.length - blocked;

console.log(`\n\n📄 ${OUT}: ${results.length} записей, разобрано ${live.length}\n`);
console.log(`   закрыты от ботов, смотреть руками ${String(blocked).padStart(2)}`);
console.log(`   лежат или не открылись            ${String(broken).padStart(2)}`);
console.log(`   работают только по http (не защищено)${String(count((r) => r.https === false)).padStart(2)}  ${pct(count((r) => r.https === false))}`);
console.log(`   без мета viewport (не адаптив)${String(count((r) => !r.hasViewport)).padStart(5)}  ${pct(count((r) => !r.hasViewport))}`);
console.log(`   меню PDF или картинкой        ${String(count((r) => r.menu?.asPdf || r.menu?.asImage)).padStart(5)}  ${pct(count((r) => r.menu?.asPdf || r.menu?.asImage))}`);
console.log(`   нет формы и нет tel-ссылки    ${String(count((r) => !r.hasForm && !r.hasTelLink)).padStart(5)}  ${pct(count((r) => !r.hasForm && !r.hasTelLink))}`);
console.log(`   нет часов работы              ${String(count((r) => !r.hoursWords)).padStart(5)}  ${pct(count((r) => !r.hoursWords))}`);
console.log(`   нет английского               ${String(count((r) => !r.english)).padStart(5)}  ${pct(count((r) => !r.english))}`);
console.log(`   ответ дольше 3 секунд         ${String(count((r) => r.ttfbMs > 3000)).padStart(5)}  ${pct(count((r) => r.ttfbMs > 3000))}`);
console.log(`   картинки тяжелее 1 МБ         ${String(count((r) => r.images?.heaviestKb > 1024)).padStart(5)}  ${pct(count((r) => r.images?.heaviestKb > 1024))}`);
console.log(`   копирайт 2022 и старше        ${String(count((r) => r.copyrightYear && r.copyrightYear <= 2022)).padStart(5)}  ${pct(count((r) => r.copyrightYear && r.copyrightYear <= 2022))}`);
console.log(`\n   Дальше: node judge.mjs\n`);
