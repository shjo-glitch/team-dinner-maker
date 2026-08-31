// POST   /api/events/:id/confirm - 일정 확정 (날짜 + 만나는 시간 지정, 장소 정하기 단계 열기)
// DELETE /api/events/:id/confirm - 일정 확정 취소. 장소 확정도 함께 풀린다.
import { CONFIRM_TIME_RE, DATE_RE, checkManagePin, loadEvent, publicEvent, readJson, saveEvent, topCandidateDates } from '../../_shared.js';

export async function onRequestPost({ request, params, env }) {
  const event = await loadEvent(env, params.id);
  if (!event) {
    return Response.json({ error: '약속을 찾을 수 없습니다.' }, { status: 404 });
  }

  const { body, error } = await readJson(request);
  if (error) return error;

  const confirmedDate = String(body.confirmedDate || '');
  const confirmedTime = String(body.confirmedTime || '');
  if (!DATE_RE.test(confirmedDate)) {
    return Response.json({ error: '만나는 날짜를 선택해 주세요.' }, { status: 400 });
  }
  if (confirmedDate < event.startDate || confirmedDate > event.endDate) {
    return Response.json({ error: '만나는 날짜는 약속의 표시 범위 안에서 골라 주세요.' }, { status: 400 });
  }
  const candidateDates = topCandidateDates(event);
  if (candidateDates.length === 0) {
    return Response.json({ error: '아직 등록된 일정이 없어 확정할 수 없어요. 먼저 일정을 등록해 주세요.' }, { status: 400 });
  }
  if (!candidateDates.includes(confirmedDate)) {
    return Response.json({ error: '만나는 날짜는 가장 많은 인원이 겹친 1위 후보 날짜 중에서 골라 주세요.' }, { status: 400 });
  }
  if (!CONFIRM_TIME_RE.test(confirmedTime)) {
    return Response.json({ error: '만나는 시간을 HH:MM 형식으로 입력해 주세요.' }, { status: 400 });
  }

  const denied = await checkManagePin(env, event, body.managePin == null ? '' : String(body.managePin));
  if (denied) return denied;

  event.confirmedAt = new Date().toISOString();
  event.confirmedDate = confirmedDate;
  event.confirmedTime = confirmedTime;
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

  // 날짜·시간은 남겨 두어 다시 확정할 때 이전 값이 채워지게 한다.
  // 장소 확정은 일정이 풀리면 함께 풀린다.
  event.confirmedAt = null;
  event.confirmedPlaceId = null;
  await saveEvent(env, event);
  return Response.json(publicEvent(event));
}
