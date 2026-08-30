// GET /api/places/search?query=... - 네이버 지역검색 프록시
import { searchLocalPlaces } from '../_shared.js';

export function onRequestGet({ request, env }) {
  const query = String(new URL(request.url).searchParams.get('query') || '').trim();
  return searchLocalPlaces(query, env.NAVER_SEARCH_KEY_ID, env.NAVER_SEARCH_KEY);
}
