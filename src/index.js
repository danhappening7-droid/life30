// 旧URL（*.workers.dev）へのアクセスを正式ドメインへ 301 転送し、それ以外は静的アセットをそのまま配信する
const CANONICAL_HOST = "12futures.jp";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname.endsWith(".workers.dev") || url.hostname === "www." + CANONICAL_HOST) {
      url.hostname = CANONICAL_HOST;
      url.protocol = "https:";
      url.port = "";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
