// POST /api/events/:id/teams-export - 약속 요약을 Teams 채널 웹후크로 보낸다.
// 웹후크 URL은 저장하지 않고 요청마다 받아 이번 전송에만 쓴다.
import {
  TEAMS_EXPORT_COOLDOWN_MS,
  buildWebhookPayload,
  isFullyConfirmed,
  loadEvent,
  postToTeams,
  readJson,
  sanitizeTeamsNote,
  saveEvent,
  validateTeamsWebhookUrl,
} from '../../_shared.js';

export async function onRequestPost({ request, params, env }) {
  const event = await loadEvent(env, params.id);
  if (!event) {
    return Response.json({ error: '약속을 찾을 수 없습니다.' }, { status: 404 });
  }

  // 공유는 모든 결정(날짜·시간·장소)이 끝난 뒤 마지막 단계에서만 한다.
  if (!isFullyConfirmed(event)) {
    return Response.json({ error: '일정과 장소를 모두 확정한 뒤에 공유할 수 있어요.' }, { status: 409 });
  }

  const { body, error } = await readJson(request);
  if (error) return error;

  const webhook = validateTeamsWebhookUrl(body.webhookUrl);
  if (webhook.error) {
    return Response.json({ error: webhook.error }, { status: 400 });
  }

  // 같은 약속이 연달아 채널에 올라가지 않도록 짧은 쿨다운을 둔다.
  const now = Date.now();
  const lastSent = event.lastTeamsExportAt ? new Date(event.lastTeamsExportAt).getTime() : 0;
  if (now - lastSent < TEAMS_EXPORT_COOLDOWN_MS) {
    return Response.json({ error: '방금 내보냈어요. 잠시 후 다시 시도해 주세요.' }, { status: 429 });
  }

  const shareUrl = `${new URL(request.url).origin}/m/${event.id}`;
  const result = await postToTeams(webhook.url, buildWebhookPayload(event, shareUrl, sanitizeTeamsNote(body.note)));
  if (result.status === 200) {
    event.lastTeamsExportAt = new Date(now).toISOString();
    await saveEvent(env, event);
  }
  return Response.json(result.body, { status: result.status });
}
