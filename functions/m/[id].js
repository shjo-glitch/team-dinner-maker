// GET /m/:id - 약속 페이지.
// Share to Teams 등에서 링크 미리보기 카드가 뜨도록, 정적 event.html 의 <head> 에
// 약속별 OG 메타태그를 주입해서 내려준다. 약속을 못 찾으면 원본을 그대로 넘긴다.
import { buildEventMeta, buildMetaTags, loadEvent } from '../api/_shared.js';

export async function onRequestGet(context) {
  const { params, env, request, next } = context;
  const response = await next();

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  const event = await loadEvent(env, params.id).catch(() => null);
  if (!event) return response;

  const url = new URL(request.url);
  const meta = buildEventMeta(event, `${url.origin}/m/${event.id}`);
  return new HTMLRewriter()
    .on('title', {
      element(element) {
        element.after(buildMetaTags(meta), { html: true });
      },
    })
    .transform(response);
}
