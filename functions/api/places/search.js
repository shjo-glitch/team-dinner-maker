// GET /api/places/search?query=... - 카카오 장소검색 (기준점 + 자체 랭킹). REST 키는 서버에서만 쓴다.
import { searchKakaoPlaces } from '../_place-search.js';

export async function onRequestGet({ request, env }) {
  const query = String(new URL(request.url).searchParams.get('query') || '').trim();
  const result = await searchKakaoPlaces(query, env.KAKAO_REST_API_KEY);
  return Response.json(result.body, { status: result.status });
}
