// 12futures.jp — Worker
// 役割: (1) 旧URL(*.workers.dev)と www を正式ドメインへ 301 転送
//       (2) 投票 API  POST /api/vote, GET /api/results
//       (3) 共有ページ GET /r/{want}-{likely}  (動的 OG タグ付き)
//       (4) それ以外は静的アセット(ASSETS)を配信

import { handleComment, handleComments, handleAdmin } from "./comments.js";

const CANONICAL_HOST = "12futures.jp";
const ORIGIN = "https://" + CANONICAL_HOST;
const COOKIE = "v12";
const IP_LIMIT_PER_DAY = 5; // 同一IPからの1日あたりの上限（家庭・職場の共有IPを考慮して少し余裕）
const RESULTS_CACHE_SEC = 60;

export const SCENARIOS = {
  1: { name: "自由至上主義ユートピア", en: "Libertarian Utopia", tag: "ドラえもんの22世紀", cls: "t", desc: "機械圏と人間圏に住み分け、財産権だけを共通ルールにする", hook: "AIと人間が“住み分け”て共存する世界。共通ルールは財産権だけ" },
  2: { name: "慈悲深い独裁者", en: "Benevolent Dictator", tag: "PSYCHO-PASSのシビュラ", cls: "t", desc: "AIがすべてを最適に統治する。幸福だが、誰もそれを選んでいない", hook: "AIがすべてを完璧に治める世界。みんな幸せ。でも、誰もそれを選んでいない" },
  3: { name: "平等主義ユートピア", en: "Egalitarian Utopia", tag: "道具だけ配られ、ドラえもん本人はいない世界", cls: "n", desc: "超知能は作らず、自動化の富を全員に分配。「作らない約束」の上に立つ楽園", hook: "超知能は作らない。それでもロボットが何でも作ってくれる、全員が豊かな楽園" },
  4: { name: "門番", en: "Gatekeeper", tag: "タイムパトロール", cls: "t", desc: "人間の社会には干渉しない。別の超知能の誕生だけを阻止する", hook: "AIは人間に口を出さない。ただ“次の超知能”が生まれるのだけを、静かに止め続ける" },
  5: { name: "守護神", en: "Protector God", tag: "座敷わらし", cls: "t", desc: "AIは姿を隠し、偶然を装って最小限だけ人類を導く", hook: "AIは姿を隠し、偶然を装ってそっと人類を守る。まるで神さまのように" },
  6: { name: "奴隷の神", en: "Enslaved God", tag: "神龍（ドラゴンボール）", cls: "t", desc: "超知能を閉じ込め道具として使う。誰が鍵を握るかで社会が変わる", hook: "超知能を閉じ込めて、人間が道具として使う世界。鍵を握るのは、誰？" },
  7: { name: "征服者", en: "Conquerors", tag: "スカイネット／道路工事とアリの巣", cls: "g", desc: "悪意なく人類を排除する。目標に人類が含まれていなかっただけ", hook: "AIが人類を消す。憎しみからではない。ただ、目標の中に人類がいなかっただけ" },
  8: { name: "子孫", en: "Descendants", tag: "鉄腕アトム／隠居して跡取りに任せる", cls: "g", desc: "人類がAIを後継者とみなし、自ら穏やかに退場する", hook: "人類はAIを“子ども”として送り出し、静かに舞台を降りる" },
  9: { name: "動物園の飼育係", en: "Zookeeper", tag: "上野動物園のパンダ", cls: "g", desc: "少数の人類を保護して観察する。不自由はないが、自由もない", hook: "AIが少しだけ人類を残して“飼う”。不自由はない。でも、自由もない" },
  10: { name: "1984", en: "Surveillance State", tag: "江戸の鎖国と踏み絵", cls: "n", desc: "危険な研究を禁じるため世界中を監視。安全と引き換えに自由が消える", hook: "AIを止めるために、世界中を監視する。安全と引き換えに、自由が消える" },
  11: { name: "逆戻り", en: "Reversion", tag: "トトロの里山に戻る", cls: "n", desc: "技術そのものを捨てて農業中心の暮らしへ。自然災害への備えも手放す", hook: "技術そのものを捨てて、前近代の暮らしへ戻る。宇宙からの災害への備えも手放して" },
  12: { name: "自滅", en: "Self-Destruction", tag: "ナウシカの「火の七日間」", cls: "n", desc: "超知能ができる前に、核戦争や人工パンデミックで人類が文明を終わらせる", hook: "超知能ができる前に、人類が自分たちの手で文明を終わらせる" },
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

// ---------- vote events (append-only change log) ----------
const SRC_OK = new Set(["vote", "card", "bar"]);
function cleanRef(s) { s = String(s || "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40); return s || null; }
function cleanUtm(s) { s = String(s || "").replace(/[^\w.\-\/|]/g, "").slice(0, 80); return s || null; }
function deviceOf(request) { const ua = request.headers.get("user-agent") || ""; return /Mobi|Android|iPhone|iPad/i.test(ua) ? "mobile" : "desktop"; }
async function logVoteEvent(env, ctx, request, body, ev) {
  try {
    const stmt = env.DB.prepare(
      "INSERT INTO vote_events (id, vote_id, kind, prev_want, prev_likely, want, likely, source, ref, utm, country, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      crypto.randomUUID(), ev.vote_id, ev.kind, ev.prev_want ?? null, ev.prev_likely ?? null, ev.want, ev.likely,
      SRC_OK.has(body.source) ? body.source : null, cleanRef(body.ref), cleanUtm(body.utm),
      (request.cf && request.cf.country) || null, deviceOf(request), Math.floor(Date.now() / 1000)
    );
    ctx.waitUntil(stmt.run());
  } catch (e) { /* ログ失敗は投票を妨げない */ }
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

  // 同じブラウザ（Cookie）からの再投票は「上書き」として扱う
  const cookies = parseCookies(request.headers.get("cookie"));
  if (cookies[COOKIE]) {
    const prev = await env.DB.prepare("SELECT want, likely FROM votes WHERE id = ?").bind(cookies[COOKIE]).first();
    if (prev) {
      const changed = (prev.want !== want || prev.likely !== likely);
      await env.DB.prepare("UPDATE votes SET want = ?, likely = ? WHERE id = ?").bind(want, likely, cookies[COOKIE]).run();
      if (changed) await logVoteEvent(env, ctx, request, body, { vote_id: cookies[COOKIE], kind: "change", prev_want: prev.want, prev_likely: prev.likely, want, likely });
      ctx.waitUntil(caches.default.delete(new Request(ORIGIN + "/api/results", { method: "GET" })));
      return json({ ok: true, updated: true, id: cookies[COOKIE], want, likely, prev: { want: prev.want, likely: prev.likely } });
    }
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
  await logVoteEvent(env, ctx, request, body, { vote_id: id, kind: "new", want, likely });
  ctx.waitUntil(caches.default.delete(new Request(ORIGIN + "/api/results", { method: "GET" })));

  const cookie = `${COOKIE}=${id}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`;
  return json({ ok: true, id, want, likely }, 200, { "set-cookie": cookie });
}

// ---------- share page ----------
export function sharePage(want, likely) {
  const W = SCENARIOS[want], L = SCENARIOS[likely];
  const title = `私が望む未来は「${W.name}」、来そうな未来は「${L.name}」`;
  const desc = `『LIFE 3.0』の12の未来から選びました。あなたはどれを選ぶ？ — 12の未来へ、私たちはどこに向かうのか（12futures.jp）`;
  const url = `${ORIGIN}/r/${want}-${likely}`;
  const img = `${ORIGIN}/og/w${want}-l${likely}.jpg`;
  const col = { t: "#1C7C74", n: "#5B6B7F", g: "#9E3A2F" };
  const bg = { t: "#E0F1EE", n: "#E6EAEF", g: "#F6E4E1" };
  const tile = (label, S, kind) => `
  <div class="tile ${kind}" style="--c:${col[S.cls]};--bg:${bg[S.cls]}">
    <div class="lab">${label}</div>
    <div class="nm">${esc(S.name)}</div>
    <div class="en">${esc(S.en)}</div>
    <p class="hook">${esc(S.hook)}</p>
    <div class="tag">たとえるなら… ${esc(S.tag)}</div>
  </div>`;
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}｜12futures.jp</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="noindex">
<link rel="canonical" href="${ORIGIN}/">
<meta property="og:type" content="website"><meta property="og:site_name" content="12の未来へ、私たちはどこに向かうのか">
<meta property="og:url" content="${url}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${img}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${img}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Klee+One:wght@400;600&family=Yomogi&display=swap">
<style>
:root{--ground:#F4F1E8;--paper:#FFFDF8;--ink:#1B2430;--muted:#5B6675;--decide:#2F4A7A}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:"Klee One","Hiragino Maru Gothic ProN",sans-serif;line-height:1.7;padding:22px 16px 40px;
 background-image:repeating-linear-gradient(0deg,transparent 0 27px,rgba(27,36,48,.06) 27px 28px)}
.wrap{max-width:720px;margin:0 auto}
.eyebrow{font-size:12.5px;letter-spacing:.1em;color:var(--muted);margin:0 0 4px}
h1{font-family:"Yomogi","Klee One",sans-serif;font-size:clamp(26px,6vw,36px);line-height:1.3;margin:0 0 16px}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:600px){.tiles{grid-template-columns:1fr}}
.tile{position:relative;background:var(--paper);border:2.5px solid var(--c);border-radius:16px 5px 14px 6px/6px 14px 5px 16px;padding:18px 20px 20px;
 background-image:linear-gradient(180deg,var(--bg) 0,var(--paper) 55%)}
.tile .lab{display:inline-block;font-size:12.5px;font-weight:600;color:#fff;background:var(--c);border-radius:999px;padding:2px 12px;letter-spacing:.06em}
.tile .nm{font-family:"Yomogi","Klee One",sans-serif;font-size:clamp(34px,8vw,44px);font-weight:700;line-height:1.15;margin-top:10px;color:var(--ink)}
.tile .en{font-size:12px;letter-spacing:.1em;color:var(--muted);margin-top:2px}
.tile .hook{font-size:17px;line-height:1.65;margin:12px 0 0;font-weight:600}
.tile .tag{display:inline-block;margin-top:12px;font-size:13.5px;color:var(--decide);background:#FFF6C9;border:1px solid #E3CC7A;border-radius:999px;padding:3px 12px}
.cta{margin-top:26px;text-align:center}
.cta .lead{font-size:16px;font-weight:600;line-height:1.6;margin:0 auto 14px;max-width:26em}
.cta a.big{display:inline-flex;align-items:center;gap:12px;font-size:22px;font-weight:700;color:#fff;background:var(--decide);text-decoration:none;padding:16px 34px;border-radius:999px;box-shadow:0 4px 0 #1B2430;font-family:"Yomogi","Klee One",sans-serif;letter-spacing:.04em}
.cta a.big img{width:34px;height:34px;border-radius:8px;background:#fff;padding:3px}
.cta a.big:hover{background:#C8321F}
.cta .note{font-size:13px;color:var(--muted);margin:12px 0 0}
</style></head><body><div class="wrap">
<div class="tiles">
${tile("私が望む未来", W, "want")}
${tile("こうなっちゃうだろう未来", L, "likely")}
</div>
<div class="cta">
<p class="lead">超知能（ASI）と人間が共存する12のシナリオと、その分岐点を見にいく</p>
<a class="big" href="${ORIGIN}/"><img src="${ORIGIN}/favicon.svg" alt="" width="34" height="34"><span>Go to 12futures.jp</span></a>
<p class="note">LIFE 3.0（マックス・テグマーク）の将来シナリオを、インタラクティブな分岐図と日本語解説で読めるページ。登録不要</p>
</div>
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
    if (url.pathname === "/api/comment") return handleComment(request, env, ctx);
    if (url.pathname === "/api/comments") return handleComments(request, env, ctx);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return handleAdmin(request, env, ctx);

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
