// POST /api/events - 새 약속 생성 (Cloudflare Pages Functions + D1)
import { DATE_RE, MANAGE_PIN_RE, THEMES, createManagePinSalt, getHolidaysForRange, hashManagePin, readJson } from '../_shared.js';

export async function onRequestPost({ request, env }) {
  const { body, error } = await readJson(request);
  if (error) return error;

  const title = String(body.title || '').trim();
  const totalCount = Number(body.totalCount);
  const theme = String(body.theme || '');

  if (!title || title.length > 60) {
    return Response.json({ error: '약속 이름은 1~60자로 입력해 주세요.' }, { status: 400 });
  }
  if (!Number.isInteger(totalCount) || totalCount < 2 || totalCount > 100) {
    return Response.json({ error: '총 인원은 2~100 사이의 숫자여야 합니다.' }, { status: 400 });
  }
  if (!THEMES.includes(theme)) {
    return Response.json({ error: '테마 값이 올바르지 않습니다.' }, { status: 400 });
  }

  const startDate = String(body.startDate || '');
  const endDate = String(body.endDate || '');
  const managePin = body.managePin == null ? '' : String(body.managePin);
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate) || endDate < startDate) {
    return Response.json({ error: '표시 범위가 올바르지 않습니다.' }, { status: 400 });
  }
  if ((new Date(endDate) - new Date(startDate)) / 86400000 > 370) {
    return Response.json({ error: '표시 범위는 최대 1년까지 지정할 수 있습니다.' }, { status: 400 });
  }
  if (!MANAGE_PIN_RE.test(managePin)) {
    return Response.json({ error: '관리 비밀번호는 숫자 4~6자리로 입력해 주세요.' }, { status: 400 });
  }

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  const managePinSalt = createManagePinSalt();
  const event = {
    id,
    title,
    totalCount,
    theme,
    startDate,
    endDate,
    managePinSalt,
    managePinHash: await hashManagePin(managePin, managePinSalt),
    deleteAuthFailures: 0,
    deleteLockedUntil: null,
    expireDate: null,
    confirmedAt: null,
    confirmedTime: null,
    createdAt: new Date().toISOString(),
    participants: [],
    places: [],
    // 표시 범위의 공휴일 (D1 캐시에서 조회, 최초 1회만 hudy 시딩). 실패면 null → 내장 데이터 폴백.
    holidays: await getHolidaysForRange(env, startDate, endDate),
  };
  await env.DB.prepare('INSERT INTO events (id, data) VALUES (?1, ?2)').bind(id, JSON.stringify(event)).run();
  return Response.json({ id });
}
