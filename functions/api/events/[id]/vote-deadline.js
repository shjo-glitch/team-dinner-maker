// PUT /api/events/:id/vote-deadline - 투표 마감시간 설정·해제 (모임장 메뉴)
// body: { managePin, voteDeadline: ISO 문자열 | null }  — null 이면 마감 해제
import { checkManagePin, loadEvent, normalizeVoteDeadline, publicEvent, readJson, saveEvent } from '../../_shared.js';

export async function onRequestPut({ request, params, env }) {
  const event = await loadEvent(env, params.id);
  if (!event) {
    return Response.json({ error: '약속을 찾을 수 없습니다.' }, { status: 404 });
  }

  const { body, error } = await readJson(request);
  if (error) return error;

  // 형식 검사를 비밀번호보다 먼저 해서 입력 실수로 잠금 횟수가 깎이지 않게 한다.
  const result = normalizeVoteDeadline(body.voteDeadline);
  if (result.error) {
    return Response.json({ error: result.error }, { status: 400 });
  }

  const denied = await checkManagePin(env, event, body.managePin == null ? '' : String(body.managePin));
  if (denied) return denied;

  event.voteDeadline = result.deadline;
  await saveEvent(env, event);
  return Response.json(publicEvent(event));
}
