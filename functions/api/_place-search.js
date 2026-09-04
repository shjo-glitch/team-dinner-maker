// 카카오 로컬(장소검색) 기반 후보지 검색.
// "서초역 맛집" 같은 검색어를 [지역/기준점 + 카테고리]로 나눠,
//   1) 기준점 좌표를 잡고  2) 검색어 정확도 후보(A) + 주변 후보(B)를 모아  3) 자체 점수로 재정렬해
// 상위 15곳만 돌려준다. Pages Function(functions/api/places/search.js)과 로컬 server.js 가 함께 쓴다.
// REST 키는 서버에서만 쓰고 어떤 응답에도 싣지 않는다.

const KAKAO_KEYWORD_URL = 'https://dapi.kakao.com/v2/local/search/keyword.json';
const KAKAO_CATEGORY_URL = 'https://dapi.kakao.com/v2/local/search/category.json';

export const SEARCH_RADIUS_M = 1500; // 기준점 반경
const PAGE_SIZE = 15; // 카카오 1회 최대 15건
export const RESULT_LIMIT = 15; // 최종 노출 수 (10~20 사이)
const QUERY_MAX = 60;

// ---- [1] 검색 의도 분석 ----
// 검색어 토큰이 아래 표의 단어와 맞으면 그 카테고리 그룹으로 검색한다.
// sub 가 비어 있으면 "맛집"처럼 전체를 허용하고, 있으면 상세 category_name 에 sub 단어가 있어야 적합으로 본다.
const CATEGORY_RULES = [
  { group: 'FD6', label: '음식점', words: ['맛집', '음식점', '식당', '밥집', '회식', '저녁', '점심', '먹을곳', '레스토랑'], sub: [] },
  { group: 'CE7', label: '카페', words: ['카페', '까페', '커피', '디저트', '베이커리', '빵집', '케이크', '브런치'], sub: ['카페', '커피', '디저트', '베이커리', '제과', '브런치', '케이크'] },
  { group: 'FD6', label: '고기집', words: ['고기집', '고깃집', '고기', '삼겹살', '갈비', '소고기', '돼지고기', '한우', '구이', '곱창', '막창', '양꼬치', '숯불'], sub: ['육류', '고기', '갈비', '삼겹살', '소고기', '돼지', '한우', '구이', '곱창', '막창', '양꼬치'] },
  { group: 'FD6', label: '돈까스', words: ['돈까스', '돈가스', '카츠', '돈카츠'], sub: ['돈까스', '돈가스', '카츠'] },
  { group: 'FD6', label: '일식', words: ['초밥', '스시', '회', '횟집', '사시미', '오마카세', '일식', '일식집', '라멘', '우동', '이자카야', '덮밥', '텐동'], sub: ['초밥', '일식', '회', '해산물', '스시', '라멘', '우동', '이자카야', '덮밥', '텐동'] },
  { group: 'FD6', label: '양식', words: ['파스타', '이탈리안', '양식', '피자', '스테이크', '햄버거', '버거', '프렌치'], sub: ['양식', '이탈리안', '파스타', '피자', '스테이크', '햄버거', '패스트푸드', '프랑스'] },
  { group: 'FD6', label: '중식', words: ['중식', '중국집', '중식당', '짜장', '짜장면', '짬뽕', '마라', '마라탕', '딤섬', '훠궈'], sub: ['중식', '중국요리', '중식당', '마라', '딤섬', '훠궈'] },
  { group: 'FD6', label: '치킨', words: ['치킨', '통닭', '닭강정'], sub: ['치킨', '닭'] },
  { group: 'FD6', label: '술집', words: ['술집', '호프', '맥주', '포차', '포장마차', '와인바', '바', '펍', '요리주점', '주점', '막걸리', '전집', '이자카야'], sub: ['술집', '호프', '요리주점', '이자카야', '포장마차', '바', '펍', '와인', '맥주', '전집'] },
  { group: 'FD6', label: '한식', words: ['한식', '국밥', '찌개', '백반', '한정식', '칼국수', '냉면', '족발', '보쌈', '분식', '떡볶이', '샤브샤브', '샤브', '국수', '전골', '해장국', '설렁탕', '순대', '감자탕', '쌈밥', '비빔밥'], sub: ['한식'] },
  { group: 'FD6', label: '아시아음식', words: ['아시아', '베트남', '쌀국수', '태국', '인도', '커리', '멕시칸', '타코'], sub: ['아시아음식', '베트남', '태국', '인도', '멕시칸', '쌀국수', '커리'] },
  { group: 'FD6', label: '뷔페', words: ['뷔페', '부페'], sub: ['뷔페'] },
];

// "서초역맛집"처럼 붙여 쓴 경우도 잡기 위해 토큰 끝이 사전 단어로 끝나면 나눈다. (단어 길이 2 이상만)
function splitAttachedCategory(token) {
  for (const rule of CATEGORY_RULES) {
    for (const word of rule.words) {
      if (word.length >= 2 && token.length > word.length && token.endsWith(word)) {
        return [token.slice(0, -word.length), word];
      }
    }
  }
  return [token];
}

function findRule(token) {
  return CATEGORY_RULES.find((rule) => rule.words.includes(token)) || null;
}

// 검색어 → { rule, categoryWord, regionQuery }
// 카테고리 단어가 여럿이면(예: "고기 맛집") 상세 조건이 있는 쪽을 택하고, 나머지 토큰이 지역/기준점이 된다.
export function analyzeQuery(query) {
  const tokens = String(query).trim().split(/\s+/).filter(Boolean).flatMap(splitAttachedCategory).filter(Boolean);
  const matches = tokens.map((token) => ({ token, rule: findRule(token) })).filter((entry) => entry.rule);
  const chosen = matches.find((entry) => entry.rule.sub.length > 0) || matches[matches.length - 1] || null;
  const region = tokens.filter((token) => !findRule(token));
  return { rule: chosen ? chosen.rule : null, categoryWord: chosen ? chosen.token : '', regionQuery: region.join(' ').trim() };
}

// ---- 카카오 호출 ----
async function kakaoGet(url, params, restKey) {
  const endpoint = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') endpoint.searchParams.set(key, String(value));
  }
  let response;
  try {
    response = await fetch(endpoint, { headers: { Authorization: `KakaoAK ${restKey}` }, signal: AbortSignal.timeout(8000) });
  } catch {
    throw { status: 502, error: '장소 검색 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.' };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error(`[place-search] kakao ${response.status} ${detail.slice(0, 200)}`);
    if (response.status === 401 || response.status === 403) {
      throw { status: 502, error: '카카오 장소검색 권한이 없어요. 카카오 개발자 콘솔에서 앱의 "카카오맵" 서비스를 활성화해 주세요.' };
    }
    throw { status: 502, error: `장소 검색에 실패했어요. (카카오 응답 ${response.status})` };
  }
  const data = await response.json().catch(() => null);
  return data && Array.isArray(data.documents) ? data.documents : [];
}

// ---- [2] 기준점 좌표 ----
// 지하철역(SW8)을 먼저 찾고, 없으면 카테고리 없이 찾는다. (동네·건물·랜드마크)
async function resolveAnchor(regionQuery, restKey) {
  if (!regionQuery) return null;
  const bySubway = await kakaoGet(KAKAO_KEYWORD_URL, { query: regionQuery, category_group_code: 'SW8', sort: 'accuracy', size: 3 }, restKey);
  const anyPlace = bySubway.length ? bySubway : await kakaoGet(KAKAO_KEYWORD_URL, { query: regionQuery, sort: 'accuracy', size: 3 }, restKey);
  const hit = anyPlace[0];
  if (!hit) return null;
  const lat = Number(hit.y);
  const lng = Number(hit.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { name: hit.place_name, lat, lng };
}

// ---- [4] 자체 랭킹 ----
// 최종점수 = 카카오 검색 순위 50 + 거리 30 + 카테고리 적합도 15 + 품질/다양성 5
function rankScore(rank) {
  // A(검색어 정확도) 순위: 1위 50, 2위 47, 3위 44 … (최저 5)
  return Math.max(5, 50 - (rank - 1) * 3);
}
const NEARBY_ONLY_RANK_SCORE = 15; // 검색어에는 안 걸렸지만 주변에 있는 곳(B 전용)의 기본 관련도

function distanceScore(meters) {
  if (!Number.isFinite(meters)) return 10; // 기준점이 없으면 중립값
  if (meters <= 200) return 30;
  if (meters <= 400) return 27;
  if (meters <= 700) return 22;
  if (meters <= 1000) return 15;
  if (meters <= 1500) return 8;
  return 0;
}

const SPECIFIC_MISMATCH_PENALTY = -20; // "서초역 돈까스"인데 상세 카테고리가 안 맞으면 크게 감점

function categoryScore(categoryName, rule) {
  if (!rule) return 15;
  const name = String(categoryName || '');
  const inGroup = rule.group === 'CE7' ? name.startsWith('음식점 > 카페') || name.includes('카페') : name.startsWith('음식점');
  if (rule.sub.length === 0) return inGroup ? 15 : 0;
  return rule.sub.some((word) => name.includes(word)) ? 15 : SPECIFIC_MISMATCH_PENALTY;
}

function qualityScore(doc) {
  return doc.phone ? 5 : 2; // 전화번호가 등록된 곳을 조금 더 신뢰한다
}

function leafCategory(categoryName) {
  const parts = String(categoryName || '').split('>').map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] || '';
}

export function rankCandidates(primary, nearby, rule) {
  const merged = new Map();
  primary.forEach((doc, index) => {
    merged.set(doc.id, { doc, rankScore: rankScore(index + 1), source: 'primary' });
  });
  nearby.forEach((doc) => {
    if (!merged.has(doc.id)) merged.set(doc.id, { doc, rankScore: NEARBY_ONLY_RANK_SCORE, source: 'nearby' });
  });

  const scored = [...merged.values()].map((entry) => {
    // 기준점 좌표 없이 검색하면 카카오가 distance 를 빈 문자열로 준다. (0m 가 아니라 '거리 없음')
    const rawDistance = entry.doc.distance;
    const meters = rawDistance === '' || rawDistance == null ? NaN : Number(rawDistance);
    const score = entry.rankScore + distanceScore(meters) + categoryScore(entry.doc.category_name, rule) + qualityScore(entry.doc);
    return { ...entry, meters: Number.isFinite(meters) ? meters : null, score };
  });
  scored.sort((a, b) => b.score - a.score);

  // 다양성 보정: 같은 상세 카테고리가 4곳을 넘으면 그 뒤로는 3점씩 감점해 한 종류가 목록을 덮지 않게 한다.
  const seen = {};
  for (const entry of scored) {
    const leaf = leafCategory(entry.doc.category_name);
    seen[leaf] = (seen[leaf] || 0) + 1;
    if (seen[leaf] > 4) entry.score -= 3;
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function toItem(entry) {
  const doc = entry.doc;
  const lat = Number(doc.y);
  const lng = Number(doc.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    name: String(doc.place_name || '').trim(),
    category: String(doc.category_name || '').replace(/\s*>\s*/g, ' › ').trim(),
    address: String(doc.address_name || '').trim(),
    roadAddress: String(doc.road_address_name || '').trim(),
    lat,
    lng,
    distance: entry.meters,
    kakaoUrl: String(doc.place_url || ''),
    phone: String(doc.phone || ''),
  };
}

// ---- 진입점 ----
// 반환: { status, body } — body 는 { items, anchor, mode } 또는 { error }
export async function searchKakaoPlaces(rawQuery, restKey) {
  const query = String(rawQuery || '').trim();
  if (!query) return { status: 400, body: { error: '검색어를 입력해 주세요.' } };
  if (query.length > QUERY_MAX) return { status: 400, body: { error: `검색어는 ${QUERY_MAX}자 이내로 입력해 주세요.` } };
  if (!restKey) {
    return { status: 503, body: { error: '장소 검색 키가 설정되지 않았어요. 이름과 주소를 직접 입력해 등록해 주세요.' } };
  }

  const intent = analyzeQuery(query);
  try {
    // 카테고리 단어가 없으면 상호 검색으로 본다. (예: "을지로 노가리", "고공 서초점")
    if (!intent.rule) {
      const docs = await kakaoGet(KAKAO_KEYWORD_URL, { query, sort: 'accuracy', size: PAGE_SIZE }, restKey);
      const items = rankCandidates(docs, [], null).map(toItem).filter(Boolean).slice(0, RESULT_LIMIT);
      return { status: 200, body: { items, anchor: null, mode: 'keyword' } };
    }

    const anchor = await resolveAnchor(intent.regionQuery, restKey);
    if (!anchor) {
      // 기준점을 못 잡으면(지역명이 없거나 못 찾음) 검색어 그대로 카테고리 검색만 한다.
      const docs = await kakaoGet(KAKAO_KEYWORD_URL, { query, category_group_code: intent.rule.group, sort: 'accuracy', size: PAGE_SIZE }, restKey);
      const items = rankCandidates(docs, [], intent.rule).map(toItem).filter(Boolean).slice(0, RESULT_LIMIT);
      return { status: 200, body: { items, anchor: null, mode: 'category', category: intent.rule.label } };
    }

    // [3] 후보 수집: A 검색어 정확도 + B 주변 거리순 (동시에)
    const common = { category_group_code: intent.rule.group, x: anchor.lng, y: anchor.lat, radius: SEARCH_RADIUS_M, size: PAGE_SIZE };
    const [primary, nearby] = await Promise.all([
      kakaoGet(KAKAO_KEYWORD_URL, { query, ...common, sort: 'accuracy' }, restKey),
      kakaoGet(KAKAO_CATEGORY_URL, { ...common, sort: 'distance' }, restKey),
    ]);
    // [4]~[5] 재정렬 후 상위만
    const items = rankCandidates(primary, nearby, intent.rule).map(toItem).filter(Boolean).slice(0, RESULT_LIMIT);
    return { status: 200, body: { items, anchor, mode: 'anchored', category: intent.rule.label, radius: SEARCH_RADIUS_M } };
  } catch (failure) {
    if (failure && failure.status) return { status: failure.status, body: { error: failure.error } };
    console.error('[place-search] unexpected', failure);
    return { status: 502, body: { error: '장소 검색 중 오류가 났어요. 잠시 후 다시 시도해 주세요.' } };
  }
}
