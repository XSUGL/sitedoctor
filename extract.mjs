// ═══════════════════════════════════════════════════════════════
// Признаки страницы: из HTML в факты. Здесь нет ни модели, ни сети.
//
// Отдельным файлом, потому что этим меряют двоих: живые сайты
// (collect.mjs) и страницы, которые сочинил агент (fix.mjs). Если бы
// у них были разные измерители, сравнение "было - стало" ничего
// не значило бы: мерили бы двумя разными линейками.
// ═══════════════════════════════════════════════════════════════

export const norm = (u) => (/^https?:\/\//i.test(u) ? u : "https://" + u);

export function signals(page, target) {
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
    // Жёсткая ширина имеет смысл только там, где нет viewport. Отдельно
    // она ничего не значит: у адаптивного сайта контейнер в 1200 пикселей
    // это норма, а правило ловило ещё и размеры картинок и атрибуты SVG.
    // На живых данных признак срабатывал на 111 сайтах, и у 104 из них
    // viewport был на месте: то есть в промпт уходило "вёрстка под
    // десктоп" про сайты, которые под телефон свёрстаны.
    fixedWidthPx: !/<meta[^>]+name=["']viewport["']/i.test(h)
                  && /(?:max-)?width\s*[:=]\s*["']?\s*(9[0-9]{2}|1[0-9]{3})\s*px/i.test(h),
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
    // Раньше сюда входило слово home, и признак срабатывал на 140 сайтах
    // из 151, тогда как по-английски из них были двое. Слово "home" стоит
    // в меню почти каждого итальянского сайта, и признак мерил его, а не
    // наличие перевода. Теперь нужен явный признак: hreflang, атрибут lang
    // или ссылка, подписанная EN или English.
    english: /hreflang=["']en[-"']/i.test(h)
             || /<html[^>]+lang=["']en[-"']/i.test(h)
             || /<a[^>]+href=["'][^"']*(?:\/en\/|[?&]lang=en)[^"']*["'][^>]*>\s*(?:<[^>]+>\s*)*(?:en|english|inglese)\s*</i.test(h),

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
