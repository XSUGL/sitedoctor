// Отдаёт дашборд, закрытый паролем. Внутри вердикты с названиями
// реальных заведений, которым ты собираешься писать: в открытый
// доступ такое не кладут.
//
//   npx wrangler secret put DASH_PASSWORD

const REALM = 'Basic realm="Site Doctor", charset="UTF-8"';

// Сравнение без ранних выходов: обычное === выдаёт длину и первые
// символы по времени ответа. На таком объёме это паранойя, но
// правильную привычку проще завести сразу.
function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const A = new TextEncoder().encode(a), B = new TextEncoder().encode(b);
  let diff = A.length ^ B.length;
  for (let i = 0; i < Math.max(A.length, B.length); i++)
    diff |= (A[i] ?? 0) ^ (B[i] ?? 0);
  return diff === 0;
}

function allowed(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try { decoded = atob(header.slice(6)); } catch { return false; }
  const i = decoded.indexOf(":");
  if (i === -1) return false;
  return same(decoded.slice(i + 1), env.DASH_PASSWORD || "");
}

export default {
  async fetch(request, env) {
    if (!env.DASH_PASSWORD) {
      return new Response(
        "Пароль не задан. Выполни: npx wrangler secret put DASH_PASSWORD",
        { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (!allowed(request, env)) {
      return new Response("Нужен пароль", {
        status: 401,
        headers: { "WWW-Authenticate": REALM, "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    // Страница с чужими данными не должна оседать в кэшах по дороге
    // и попадать в поисковые индексы.
    out.headers.set("Cache-Control", "private, no-store");
    out.headers.set("X-Robots-Tag", "noindex, nofollow");
    out.headers.set("Referrer-Policy", "no-referrer");
    return out;
  },
};
