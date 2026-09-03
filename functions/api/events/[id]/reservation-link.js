// PUT /api/events/:id/reservation-link - 확정된 장소의 예약 앱(웹) 링크 저장 (빈 값이면 삭제)
// 후보지 등록·투표처럼 누구나 넣을 수 있는 정보라 관리 비밀번호는 받지 않는다.
import { confirmedPlace, loadEvent, normalizeReservationLink, publicEvent, readJson, saveEvent } from '../../_shared.js';

export async function onRequestPut({ request, params, env }) {
  const event = await loadEvent(env, params.id);
  if (!event) {
    return Response.json({ error: '약속을 찾을 수 없습니다.' }, { status: 404 });
  }
  const place = confirmedPlace(event);
  if (!place) {
    return Response.json({ error: '장소를 먼저 확정해 주세요.' }, { status: 409 });
  }

  const { body, error } = await readJson(request);
  if (error) return error;

  const linkResult = normalizeReservationLink(body.link);
  if (linkResult.error) {
    return Response.json({ error: linkResult.error }, { status: 400 });
  }
  place.reservationLink = linkResult.link;
  await saveEvent(env, event);
  return Response.json(publicEvent(event));
}
