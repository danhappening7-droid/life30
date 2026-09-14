// 12futures.jp — Worker
// 役割: (1) 旧URL(*.workers.dev)と www を正式ドメインへ 301 転送
//       (2) 投票 API  POST /api/vote, GET /api/results
//       (3) 共有ページ GET /r/{want}-{likely}  (動的 OG タグ付き)
//       (4) それ以外は静的アセット(ASSETS)を配信

const CANONICAL_HOST = "12futures.jp";
const ORIGIN = "https://" + CANONICAL_HOST;
const COOKIE = "v12";
const IP_LIMIT_PER_DAY = 5; // 同一IPからの1日あたりの上限（家庭・職場の共有IPを考慮して少し余裕）
const RESULTS_CACHE_SEC = 60;

export const SCENARIOS = {
  1: { name: "自由至上主義ユートピア", en: "Libertarian Utopia", tag: "ドラえもんの22世紀", cls: "t" },
  2: { name: "慈悲深い独裁者", en: "Benevolent Dictator", tag: "PSYCHO-PASSのシビュラ", cls: "t" },
  3: { name: "平等主義ユートピア", en: "Egalitarian Utopia", tag: "道具だけ配られ、ドラえもん本人はいない世界", cls: "n" },
  4: { name: "門番", en: "Gatekeeper", tag: "タイムパトロール", cls: "t" },
  5: { name: "守護神", en: "Protector God", tag: "座敷わらし", cls: "t" },
  6: { name: "奴隷の神", en: "Enslaved God", tag: "神龍（ドラゴンボール）", cls: "t" },
  7: { name: "征服者", en: "Conquerors", tag: "スカイネット／道路工事とアリの巣", cls: "g" },
  8: { name: "子孫", en: "Descendants", tag: "鉄腕アトム／隠居して跡取りに任せる", cls: "g" },
  9: { name: "動物園の飼育係", en: "Zookeeper", tag: "上野動物園のパンダ", cls: "g" },
  10: { name: "1984", en: "Surveillance State", tag: "江戸の鎖国と踏み絵", cls: "n" },
  11: { name: "逆戻り", en: "Reversion", tag: "トトロの里山に戻る", cls: "n" },
  12: { name: "自滅", en: "Self-Destruction", tag: "ナウシカの「火の七日間」", cls: "n" },
};
const CIRC = ["", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫"];

// ---------- helpers ----------
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}
function parseCookies(h) {
  const out = {};
  (h || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function validPick(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- results (aggregated, cached) ----------
export async function computeResults(db) {
  const [w, l, tot] = await Promise.all([
    db.prepare("SELECT want AS k, COUNT(*) AS c FROM votes GROUP BY want").all(),
    db.prepare("SELECT likely AS k, COUNT(*) AS c FROM votes GROUP BY likely").all(),
    db.prepare("SELECT COUNT(*) AS n FROM votes").first(),
  ]);
  const want = {}, likely = {};
  for (let i = 1; i <= 12; i++) { want[i] = 0; likely[i] = 0; }
  for (const r of w.results) want[r.k] = r.c;
  for (const r of l.results) likely[r.k] = r.c;
  return { total: tot.n, want, likely, updated: new Date().toISOString() };
}
async function handleResults(request, env, ctx) {
  const cache = caches.default;
  const key = new Request(ORIGIN + "/api/results", { method: "GET" });
  let res = await cache.match(key);
  if (res) return res;
  const data = await computeResults(env.DB);
  res = new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=" + RESULTS_CACHE_SEC },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// ---------- vote ----------
export async function handleVote(request, env, ctx) {
  if (request.method !== "POST") return json({ error: "method" }, 405);
  const origin = request.headers.get("origin") || "";
  if (origin !== ORIGIN) return json({ error: "origin" }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "body" }, 400); }
  const want = validPick(body.want), likely = validPick(body.likely);
  if (!want || !likely) return json({ error: "pick" }, 400);

  const cookies = parseCookies(request.headers.get("cookie"));
  if (cookies[COOKIE]) {
    const prev = await env.DB.prepare("SELECT want, likely FROM votes WHERE id = ?").bind(cookies[COOKIE]).first();
    if (prev) return json({ error: "already", want: prev.want, likely: prev.likely }, 409);
  }
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const ip_hash = await sha256hex(ip + "|" + (env.IP_SALT || "12futures"));
  const now = Math.floor(Date.now() / 1000);
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM votes WHERE ip_hash = ? AND created_at > ?")
    .bind(ip_hash, now - 86400).first();
  if (recent.n >= IP_LIMIT_PER_DAY) return json({ error: "limit" }, 429);

  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO votes (id, want, likely, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, want, likely, ip_hash, now).run();
  ctx.waitUntil(caches.default.delete(new Request(ORIGIN + "/api/results", { method: "GET" })));

  const cookie = `${COOKIE}=${id}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`;
  return json({ ok: true, id, want, likely }, 200, { "set-cookie": cookie });
}

// ---------- share page ----------
export function sharePage(want, likely) {
  const W = SCENARIOS[want], L = SCENARIOS[likely];
  const title = `私が望む未来は ${CIRC[want]}${W.name}、来そうな未来は ${CIRC[likely]}${L.name}`;
  const desc = `『LIFE 3.0』の12シナリオから選びました。あなたはどれを選ぶ？ — 12の未来へ、私たちはどこに向かうのか（12futures.jp）`;
  const url = `${ORIGIN}/r/${want}-${likely}`;
  const img = `${ORIGIN}/og/w${want}.png`;
  const cls = { t: "#1C7C74", n: "#5B6B7F", g: "#9E3A2F" };
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}｜12futures.jp</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="noindex">
<link rel="canonical" href="${ORIGIN}/#vote">
<meta property="og:type" content="website"><meta property="og:site_name" content="12の未来へ、私たちはどこに向かうのか">
<meta property="og:url" content="${url}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${img}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${img}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>body{margin:0;background:#F4F1E8;color:#1B2430;font-family:"Hiragino Maru Gothic ProN","Klee One",sans-serif;padding:32px 16px}
.c{max-width:640px;margin:0 auto;background:#FFFDF8;border:2px solid #1B2430;border-radius:14px 4px 12px 5px/5px 12px 4px 14px;padding:24px 22px}
h1{font-size:22px;line-height:1.5;margin:0 0 14px}.p{display:flex;gap:10px;align-items:baseline;margin:10px 0;font-size:18px;flex-wrap:wrap}.p b{font-size:22px}
.lab{font-size:12px;color:#5B6675;letter-spacing:.08em}.tag{font-size:13px;color:#2F4A7A}
a.btn{display:inline-block;margin-top:18px;background:#2F4A7A;color:#fff;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:999px}
small{display:block;margin-top:16px;color:#5B6675;font-size:12px}</style></head><body><div class="c">
<h1>『LIFE 3.0』の12の未来から、この人が選んだのは</h1>
<div class="p"><span class="lab">望む未来</span><b style="color:${cls[W.cls]}">${CIRC[want]} ${esc(W.name)}</b><span class="tag">≒ ${esc(W.tag)}</span></div>
<div class="p"><span class="lab">来そうな未来</span><b style="color:${cls[L.cls]}">${CIRC[likely]} ${esc(L.name)}</b><span class="tag">≒ ${esc(L.tag)}</span></div>
<a class="btn" href="${ORIGIN}/#vote">自分も選んでみる →</a>
<small>マックス・テグマーク『LIFE 3.0』第5章の12シナリオを分岐図で読むサイト「12の未来へ、私たちはどこに向かうのか」の投票結果ページです。</small>
</div></body></html>`;
}

// ---------- router ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // (1) canonical host redirect
    if (url.hostname.endsWith(".workers.dev") || url.hostname === "www." + CANONICAL_HOST) {
      url.hostname = CANONICAL_HOST; url.protocol = "https:"; url.port = "";
      return Response.redirect(url.toString(), 301);
    }

    // (2) API
    if (url.pathname === "/api/vote") return handleVote(request, env, ctx);
    if (url.pathname === "/api/results") return handleResults(request, env, ctx);

    // (3) share page
    const m = url.pathname.match(/^\/r\/(\d{1,2})-(\d{1,2})\/?$/);
    if (m) {
      const want = validPick(m[1]), likely = validPick(m[2]);
      if (!want || !likely) return Response.redirect(ORIGIN + "/#vote", 302);
      return new Response(sharePage(want, likely), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" },
      });
    }

    // (4) static assets
    return env.ASSETS.fetch(request);
  },
};
