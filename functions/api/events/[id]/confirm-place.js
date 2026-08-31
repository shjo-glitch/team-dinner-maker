// POST   /api/events/:id/confirm-place - 후보지 하나를 최종 장소로 확정 (일정 확정과 병행 가능)
// DELETE /api/events/:id/confirm-place - 장소 확정 취소
import { checkManagePin, loadEvent, normalizePlaceLink, publicEvent, readJson, saveEvent } from '../../_shared.js';

export async function onRequestPost({ request, params, env }) {
  const event = await loadEvent(env, params.id);
  if (!event) {
    return Response.json({ error: '약속을 찾을 수 없습니다.' }, { status: 404 });
  }
  const { body, error } = await readJson(request);
  if (error) return error;

  const place = (event.places || []).find((candidate) => candidate.id === String(body.placeId || ''));
  if (!place) {
    return Response.json({ error: '후보 장소를 찾을 수 없습니다.' }, { status: 404 });
  }

  // 장소를 확정하면서 네이버 지도 링크를 함께 넣거나 고칠 수 있다. (빈 값이면 기존 링크 유지)
  const linkInput = String(body.link || '').trim();
  if (linkInput) {
    const linkResult = normalizePlaceLink(linkInput);
    if (linkResult.error) {
      return Response.json({ error: linkResult.error }, { status: 400 });
    }
    place.link = linkResult.link;
  }

  const denied = await checkManagePin(env, event, body.managePin == null ? '' : String(body.managePin));
  if (denied) return denied;

  event.confirmedPlaceId = place.id;
  await saveEvent(env, event);
  return Response.json(publicEvent(event));
}

export async function onRequestDelete({ request, params, env }) {
  const event = await loadEvent(env, params.id);
  if (!event) {
    return Response.json({ error: '약속을 찾을 수 없습니다.' }, { status: 404 });
  }

  const { body, error } = await readJson(request);
  if (error) return error;

  const denied = await checkManagePin(env, event, body.managePin == null ? '' : String(body.managePin));
  if (denied) return denied;

  event.confirmedPlaceId = null;
  await saveEvent(env, event);
  return Response.json(publicEvent(event));
}
