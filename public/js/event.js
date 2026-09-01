'use strict';

// 참여 링크는 /m/<id> 형태. 예전 형식(/event.html?id=<id>)도 계속 지원한다.
const eventId = (location.pathname.match(/^\/m\/([a-z0-9]+)$/) || [])[1] || new URLSearchParams(location.search).get('id');

// 예전 형식으로 들어왔으면 주소창을 /m/<id> 로 정리 (참여 링크 복사 버튼이 새 형식을 복사하도록)
if (eventId && !location.pathname.startsWith('/m/')) {
  history.replaceState(null, '', `/m/${eventId}`);
}
const THEME_LABELS = {
  weekday: '평일 약속 (주말 선택 불가)',
  weekend: '주말 약속 (평일 선택 불가)',
  both: '평일+주말 약속',
};
// 팀즈 카드에는 짧은 라벨을 쓴다. (서버의 buildTeamsCard 와 같은 값)
const THEME_CARD_LABELS = { weekday: '평일 약속', weekend: '주말 약속', both: '평일+주말 약속' };
const DOW_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
const CONFIRM_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_MEET_TIME = '19:00';

// '19:00' -> '오후 7:00' (서버 formatMeetTime 과 같은 규칙)
function formatMeetTime(time) {
  if (!CONFIRM_TIME_RE.test(String(time || ''))) return '';
  const [hour, minute] = time.split(':').map(Number);
  return `${hour < 12 ? '오전' : '오후'} ${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, '0')}`;
}

// 확정된 약속의 만나는 시간. 확정 전이면 빈 문자열.
function meetTimeLabel() {
  return isScheduleConfirmed() ? formatMeetTime(eventData.confirmedTime) : '';
}

// 진행 단계: 1 일정 만들기 → 2 일정 투표 → 3 일정·장소 정하기 → 4 공유하기
function isScheduleConfirmed() {
  return Boolean(eventData.confirmedAt && eventData.confirmedDate && eventData.confirmedTime);
}

function confirmedPlace() {
  return (eventData.places || []).find((place) => place.id === eventData.confirmedPlaceId) || null;
}

function isFullyConfirmed() {
  return isScheduleConfirmed() && Boolean(confirmedPlace());
}

// 1단계(만들기)는 이 페이지에 들어온 시점에 이미 끝나 있다.
// 2단계(일정 & 장소 정하기)는 일정·장소 확정을 병행하고, 둘 다 끝나면 3단계(공유하기).
function currentStep() {
  return isFullyConfirmed() ? 3 : 2;
}

function renderSteps() {
  const step = currentStep();
  for (const item of $('steps').children) {
    const order = Number(item.dataset.step);
    item.classList.toggle('done', order < step);
    item.classList.toggle('current', order === step);
  }
  // 공유하기 단계가 되면 '3 공유하기' 배지가 곧 공유 진입점이 된다.
  const shareStep = $('steps').querySelector('[data-step="3"]');
  const shareable = isFullyConfirmed();
  shareStep.classList.toggle('clickable', shareable);
  shareStep.setAttribute('role', shareable ? 'button' : '');
  shareStep.tabIndex = shareable ? 0 : -1;
  shareStep.title = shareable ? '확정된 일정 공유하기' : '';
}

let eventData = null;
let voteCal = null;
let resultCal = null;
let activeParticipantName = null;
let cancelButtonTimer = null;

// 장소 정하기(확정 후) 상태
let appConfig = { naverMapKeyId: '', placeSearchEnabled: false };
let placeMap = null;
let placeMapReady = false;
let activeVoterName = null;
let searchResults = [];
let selectedResultIndex = null;

// 투표자 이름은 브라우저마다 다르므로 약속별로 기억해 둔다.
const VOTER_STORAGE_KEY = `dinner-voter:${eventId}`;

function readStoredVoter() {
  try {
    return localStorage.getItem(VOTER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeVoter(name) {
  try {
    if (name) localStorage.setItem(VOTER_STORAGE_KEY, name);
    else localStorage.removeItem(VOTER_STORAGE_KEY);
  } catch {
    // 시크릿 모드 등 저장이 막힌 환경에서는 기억하지 않고 넘어간다.
  }
}

function $(id) {
  return document.getElementById(id);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadEvent() {
  const res = await fetch(`/api/events/${eventId}`);
  if (!res.ok) return null;
  return res.json();
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) return res.json();
  } catch {
    // 설정을 못 읽으면 지도 없이 후보지 목록만 동작한다.
  }
  return { naverMapKeyId: '', placeSearchEnabled: false };
}

function buildCounts() {
  const counts = {};
  for (const p of eventData.participants) {
    for (const d of p.dates) counts[d] = (counts[d] || 0) + 1;
  }
  return counts;
}

function formatCandidateDate(dateStr) {
  const [, month, day] = dateStr.split('-').map(Number);
  return `${month}/${day}`;
}

function renderCandidateRanking(counts) {
  const rankingEl = $('candidate-ranking');

  // 일정이 확정되면 후보 순위 대신 확정된 일정을 보여준다.
  if (isScheduleConfirmed()) {
    $('date-ranking-card').classList.add('confirmed-mode');
    $('date-ranking-kicker').textContent = 'CONFIRMED';
    $('candidate-ranking-title').textContent = '확정된 일정';
    rankingEl.innerHTML = `
      <div class="confirmed-summary">
        <p class="confirmed-summary-main">${esc(formatShortDate(eventData.confirmedDate))} ${esc(formatMeetTime(eventData.confirmedTime))}</p>
        <p class="confirmed-summary-sub">${esc(eventData.confirmedDate)} · ${esc(eventData.confirmedTime)}</p>
      </div>`;
    return;
  }
  $('date-ranking-card').classList.remove('confirmed-mode');
  $('date-ranking-kicker').textContent = 'THE SHORTLIST';
  $('candidate-ranking-title').textContent = '회식 날 후보 순위';

  const rankedDates = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([dateA, countA], [dateB, countB]) => countB - countA || dateA.localeCompare(dateB));
  const topCounts = [...new Set(rankedDates.map(([, count]) => count))].slice(0, 3);

  if (topCounts.length === 0) {
    rankingEl.innerHTML = '<p class="candidate-ranking-empty">아직 등록된 일정이 없어요.</p>';
    return;
  }

  rankingEl.innerHTML = topCounts
    .map((count, index) => {
      const dates = rankedDates
        .filter(([, dateCount]) => dateCount === count)
        .map(([date]) => formatCandidateDate(date))
        .join(', ');
      const rank = index + 1;
      return `
        <div class="candidate-ranking-row rank-${rank}">
          <span class="candidate-rank-label">${rank}위</span>
          <span class="candidate-rank-dates">${dates}</span>
        </div>`;
    })
    .join('');
}

// 예전 데이터(범위 없이 생성된 약속)는 오늘~다음 달 말일을 기본 범위로 사용
function eventRange() {
  if (eventData.startDate && eventData.endDate) {
    return { startDate: eventData.startDate, endDate: eventData.endDate };
  }
  const t = new Date();
  const end = new Date(t.getFullYear(), t.getMonth() + 2, 0);
  return {
    startDate: calFmt(t.getFullYear(), t.getMonth(), t.getDate()),
    endDate: calFmt(end.getFullYear(), end.getMonth(), end.getDate()),
  };
}

function fmtRangeLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${y}.${m}.${d}`;
}

function renderHead() {
  const range = eventRange();
  $('event-title').textContent = eventData.title;
  $('event-theme').textContent = THEME_LABELS[eventData.theme] || eventData.theme;
  $('event-range').textContent = `${fmtRangeLabel(range.startDate)} ~ ${fmtRangeLabel(range.endDate)}`;
  $('event-progress').textContent = `참여 ${eventData.participants.length}명 / 총원 ${eventData.totalCount}명`;
  const meetTime = meetTimeLabel();
  $('event-time').hidden = !meetTime;
  $('event-time').textContent = meetTime ? `🕖 ${meetTime} 만남` : '';
}

function isAtCapacity() {
  return eventData.participants.length >= eventData.totalCount;
}

function syncNameInputState() {
  const nameInput = $('name');
  const hint = $('name-hint');
  const atCapacity = isAtCapacity();

  nameInput.disabled = atCapacity;
  if (activeParticipantName) {
    nameInput.placeholder = `${activeParticipantName} 님 일정 수정 중`;
    hint.textContent = `${activeParticipantName} 님의 일정을 수정 중이에요. 선택한 날짜를 저장하면 반영됩니다.`;
  } else if (atCapacity) {
    nameInput.value = '';
    nameInput.placeholder = '총원 등록 완료';
    hint.textContent = `총원 ${eventData.totalCount}명이 모두 등록됐어요. 참여자 이름을 선택하면 일정을 수정할 수 있어요.`;
  } else {
    nameInput.placeholder = '이름을 입력하세요';
    hint.textContent = '이름을 입력한 뒤 엔터를 누르면 참여자로 등록돼요. 일정 수정은 아래 참여자 이름을 선택해 주세요.';
  }
}

function updateSaveState() {
  const hasScheduleOwner = Boolean(activeParticipantName || $('name').value.trim());
  const hasSelectedDates = voteCal && voteCal.selected.size > 0;
  const disabled = !hasScheduleOwner || !hasSelectedDates;
  $('save-btn').disabled = disabled;
  $('float-save-btn').disabled = disabled;
}

function renderVotePeople() {
  const wrap = $('vote-people');
  if (eventData.participants.length === 0) {
    wrap.innerHTML = '<span class="empty-note">아직 아무도 등록하지 않았어요. 첫 번째로 등록해 보세요!</span>';
    return;
  }
  wrap.innerHTML = eventData.participants
    .map(
      (p) => {
        const active = p.name === activeParticipantName;
        return `
        <span class="person-chip${active ? ' active' : ''}" data-name="${esc(p.name)}" role="button" tabindex="0" aria-pressed="${active}">
          ${esc(p.name)}
          <button type="button" class="del" data-del="${esc(p.name)}" title="삭제">✕</button>
        </span>`;
      }
    )
    .join('');
}

// 장소 후보를 득표순 순위 행으로 그린다. (동점은 같은 순위)
function placeRankingRows(places) {
  let rank = 0;
  let prevVotes = -1;
  return places
    .map((place, index) => {
      const votes = (place.votes || []).length;
      if (votes !== prevVotes) {
        rank = index + 1;
        prevVotes = votes;
      }
      return `
        <div class="candidate-ranking-row rank-${Math.min(rank, 3)}">
          <span class="candidate-rank-label">${rank}위</span>
          <span class="candidate-rank-dates place-rank-name">${esc(place.name)}<small class="place-rank-votes">♥ ${votes}</small></span>
        </div>`;
    })
    .join('');
}

// 결과 탭의 '회식 장소' 카드: 미확정=득표 상위 5곳 / 확정=확정 장소 레이아웃
function renderPlaceRanking() {
  const card = $('place-ranking-card');
  const listEl = $('place-ranking');
  const allButton = $('place-ranking-all');
  const confirmed = confirmedPlace();

  if (confirmed) {
    card.classList.add('confirmed-mode');
    $('place-ranking-kicker').textContent = 'CONFIRMED';
    $('place-ranking-title').textContent = '확정된 장소';
    allButton.hidden = true;
    listEl.innerHTML = `
      <div class="confirmed-summary">
        <p class="confirmed-summary-main">${esc(confirmed.name)}</p>
        <p class="confirmed-summary-sub">${esc(confirmed.roadAddress || confirmed.address || '')}</p>
        <a class="confirmed-summary-link" href="${esc(placeMapLink(confirmed))}" target="_blank" rel="noopener noreferrer">네이버 지도에서 보기 ↗</a>
      </div>`;
    return;
  }

  card.classList.remove('confirmed-mode');
  $('place-ranking-kicker').textContent = 'THE VENUE SHORTLIST';
  $('place-ranking-title').textContent = '회식 장소 후보 순위';

  const places = rankedPlaces();
  if (places.length === 0) {
    listEl.innerHTML = "<p class=\"candidate-ranking-empty\">아직 등록된 후보지가 없어요. '어디서 볼까?' 탭에서 등록해 보세요.</p>";
    allButton.hidden = true;
    return;
  }
  // 카드에는 좋아요 상위 5곳만, 나머지는 '전체 후보 보기' 팝업으로.
  listEl.innerHTML = placeRankingRows(places.slice(0, 5));
  allButton.hidden = places.length <= 5;
}

function openPlaceRankingDialog() {
  $('place-ranking-full').innerHTML = placeRankingRows(rankedPlaces());
  $('place-ranking-dialog').showModal();
}

function renderResult() {
  const counts = buildCounts();
  // 뱃지 농도: 1명이 선택할 때마다 (1/참여자 수)씩 진해진다.
  resultCal.setResult(counts, eventData.participants.length);
  renderCandidateRanking(counts);
  renderPlaceRanking();

  $('result-people-count').textContent = eventData.participants.length;
  const wrap = $('result-people');
  wrap.innerHTML =
    eventData.participants.length === 0
      ? '<span class="empty-note">아직 참여자가 없어요.</span>'
      : eventData.participants.map((p) => `<span class="person-chip" style="cursor:default">${esc(p.name)}</span>`).join('');
}

function showDateDetail(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = DOW_LABELS[new Date(y, m - 1, d).getDay()];
  const ok = eventData.participants.filter((p) => p.dates.includes(dateStr));
  const no = eventData.participants.filter((p) => !p.dates.includes(dateStr));
  const holiday = getHoliday(dateStr);

  $('date-detail').hidden = false;
  $('detail-title').textContent = `${m}월 ${d}일 (${dow})${holiday ? ' · ' + holiday : ''}`;
  $('detail-ok-count').textContent = ok.length;
  $('detail-ok').innerHTML = ok.length
    ? ok.map((p) => `<span class="name-tag ok">${esc(p.name)}</span>`).join('')
    : '<span class="empty-note">이 날 가능한 사람이 없어요.</span>';
  $('detail-no').innerHTML = no.length
    ? no.map((p) => `<span class="name-tag no">${esc(p.name)}</span>`).join('')
    : '<span class="empty-note">모두 가능해요! 🎉</span>';
  $('date-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updateSelectedCount(n) {
  const text = `선택한 날짜: ${n}일`;
  $('selected-count').textContent = text;
  $('float-count').textContent = text;
  updateSaveState();
}

function switchTab(tab) {
  $('tab-vote').classList.toggle('active', tab === 'vote');
  $('tab-result').classList.toggle('active', tab === 'result');
  $('tab-place').classList.toggle('active', tab === 'place');
  $('panel-vote').hidden = tab !== 'vote';
  $('panel-result').hidden = tab !== 'result';
  $('panel-place').hidden = tab !== 'place';
  if (tab === 'result') renderResult();
  if (tab === 'place') renderPlacePanel();
}

async function saveMySchedule() {
  const errorEl = $('vote-error');
  const infoEl = $('vote-info');
  errorEl.textContent = '';
  infoEl.textContent = '';
  const name = activeParticipantName || $('name').value.trim();
  if (!name) {
    errorEl.textContent = '이름을 입력하거나 참여자 이름을 선택해 주세요.';
    $('name').focus();
    return;
  }
  if (!activeParticipantName && eventData.participants.some((participant) => participant.name === name)) {
    errorEl.textContent = '이미 등록된 이름이에요. 참여자 이름을 선택해 일정을 수정해 주세요.';
    return;
  }
  const dates = [...voteCal.selected];
  $('save-btn').disabled = true;
  $('float-save-btn').disabled = true;
  try {
    const res = await fetch(`/api/events/${eventId}/participants`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, dates }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '저장하지 못했습니다.');
    eventData = data;
    // 방금 등록한 사람을 장소 투표자로도 기억해 둔다.
    if (!activeVoterName) {
      activeVoterName = name;
      storeVoter(name);
    }
    renderHead();
    renderVotePeople();
    if (dates.length > 0) {
      // 다음 사람이 이어서 등록할 수 있게 이름과 선택을 즉시 비운다.
      $('name').value = '';
      activeParticipantName = null;
      voteCal.setSelected([]);
      renderVotePeople();
      syncNameInputState();
      updateSelectedCount(0);
      switchTab('result');
    } else {
      // 날짜 없이 엔터 등록한 뒤에는 이름 입력칸을 비우고, 참여자 뱃지로 일정 수정을 시작한다.
      $('name').value = '';
      activeParticipantName = null;
      renderVotePeople();
      syncNameInputState();
      voteCal.render();
      infoEl.textContent = `'${name}' 님이 참여자로 등록됐어요. 이름 뱃지를 선택해 가능한 날짜를 등록해 주세요.`;
    }
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    // 현재 선택 개수에 맞춰 버튼 활성화 상태 복원
    updateSelectedCount(voteCal.selected.size);
  }
}

function activateParticipant(name) {
  const participant = eventData.participants.find((p) => p.name === name);
  if (!participant) return;

  activeParticipantName = participant.name;
  $('name').value = '';
  voteCal.setSelected(participant.dates);
  renderVotePeople();
  syncNameInputState();
  updateSelectedCount(participant.dates.length);
}

async function deleteParticipant(name) {
  if (!confirm(`'${name}' 님의 일정을 삭제할까요?`)) return;
  const res = await fetch(`/api/events/${eventId}/participants?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (res.ok) {
    eventData = await res.json();
    if (activeParticipantName === name) {
      activeParticipantName = null;
      $('name').value = '';
      voteCal.setSelected([]);
    }
    renderHead();
    renderVotePeople();
    syncNameInputState();
    voteCal.render();
    updateSelectedCount(voteCal.selected.size);
  }
}

function formatLockRemaining(lockedUntil) {
  const remainingSeconds = Math.max(0, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 1000));
  return `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`;
}

// 확정 토글 버튼의 상태(enable/disable)와 라벨을 함께 갱신한다.
function setSwitchState(button, on, label) {
  button.classList.toggle('on', on);
  button.setAttribute('aria-pressed', String(on));
  button.querySelector('.toggle-label').textContent = label;
}

// 파기·확정이 같은 관리 비밀번호 잠금을 공유하므로 버튼들을 함께 잠근다.
function syncManageLockState() {
  clearTimeout(cancelButtonTimer);
  const cancelButton = $('cancel-event');
  const scheduleSwitch = $('confirm-event');
  const placeSwitch = $('confirm-place-toggle');
  const lockedUntil = eventData.deleteLockedUntil;
  const isLocked = lockedUntil && new Date(lockedUntil).getTime() > Date.now();

  if (isLocked) {
    const remaining = `${formatLockRemaining(lockedUntil)} 후 재시도`;
    cancelButton.disabled = true;
    cancelButton.textContent = remaining;
    setSwitchState(scheduleSwitch, isScheduleConfirmed(), remaining);
    setSwitchState(placeSwitch, Boolean(confirmedPlace()), remaining);
  } else {
    cancelButton.disabled = false;
    cancelButton.textContent = '약속 파기하기';
    // 스위치 ON = 확정됨(누르면 다시 정하기), OFF = 미확정(누르면 확정하기)
    setSwitchState(scheduleSwitch, isScheduleConfirmed(), isScheduleConfirmed() ? '일정 다시 정하기' : '일정 확정하기');
    setSwitchState(placeSwitch, Boolean(confirmedPlace()), confirmedPlace() ? '장소 다시 정하기' : '장소 확정하기');
  }
  scheduleSwitch.disabled = isLocked;
  placeSwitch.disabled = isLocked;

  for (const id of ['cancel-confirm', 'cancel-pin', 'confirm-submit', 'confirm-pin', 'place-dialog-submit', 'place-confirm-pin']) {
    $(id).disabled = isLocked;
  }
  if (isLocked) cancelButtonTimer = setTimeout(syncManageLockState, 1000);
}

// 확정 여부에 따라 '어디서 볼까?' 탭을 열고 닫는다.
function syncConfirmState() {
  // 장소 정하기는 일정 확정과 병행하므로 '어디서 볼까?' 탭은 항상 열려 있다.
  $('tab-place').hidden = false;
  renderHead();
  renderSteps();
  syncManageLockState();
}

function openCancelDialog() {
  const dialog = $('cancel-dialog');
  $('cancel-pin').value = '';
  $('cancel-error').textContent = '';
  dialog.showModal();
  $('cancel-pin').focus();
}

function returnHome() {
  location.assign('/');
}

function showCancelSuccess() {
  $('cancel-dialog').close();
  $('cancel-success-dialog').showModal();
  $('cancel-success-home').focus();
}

async function cancelEvent(e) {
  e.preventDefault();
  const pin = $('cancel-pin').value;
  const errorEl = $('cancel-error');
  errorEl.textContent = '';
  if (!/^\d{4,6}$/.test(pin)) {
    errorEl.textContent = '관리 비밀번호는 숫자 4~6자리로 입력해 주세요.';
    $('cancel-pin').focus();
    return;
  }

  const confirmButton = $('cancel-confirm');
  const originalLabel = confirmButton.textContent;
  confirmButton.disabled = true;
  confirmButton.textContent = '파기하는 중…';

  try {
    const res = await fetch(`/api/events/${eventId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ managePin: pin }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok || res.status === 404) {
      showCancelSuccess();
      return;
    }
    if (data.deleteLockedUntil) {
      eventData.deleteLockedUntil = data.deleteLockedUntil;
      syncManageLockState();
      $('cancel-dialog').close();
      return;
    }
    throw new Error(data.error || '약속을 파기하지 못했습니다.');
  } catch (err) {
    errorEl.textContent = err.message || '약속을 파기하지 못했습니다. 다시 시도해 주세요.';
    confirmButton.disabled = false;
    confirmButton.textContent = originalLabel;
  }
}

// ---- 어디서 볼까? (후보지 등록 / 투표) ----

// 주소에서 시/도 + 시군구 까지만 남긴다. ('경기도 성남시 분당구' 처럼 시 아래 구가 있으면 세 토막)
function addressRegion(address) {
  const tokens = String(address || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return '';
  const hasDistrictUnderCity = /시$/.test(tokens[1]) && tokens[2] && /(구|군)$/.test(tokens[2]);
  return tokens.slice(0, hasDistrictUnderCity ? 3 : 2).join(' ');
}

// 붙여넣은 POI 링크가 있으면 그대로 쓴다. 없으면 검색 URL로 폴백하는데,
// 전체 도로명주소(층·호 포함)를 넣으면 네이버 지도 검색이 실패하므로 이름 + 시군구까지만 쓴다.
function placeMapLink(place) {
  if (place.link) return place.link;
  const query = [place.name, addressRegion(place.address || place.roadAddress)].filter(Boolean).join(' ');
  return `https://map.naver.com/p/search/${encodeURIComponent(query)}`;
}

// 득표 많은 순, 같으면 먼저 등록된 순. 목록 순서가 곧 지도 핀 번호가 된다.
function sortedPlaces() {
  return [...(eventData.places || [])].sort(
    (a, b) => (b.votes || []).length - (a.votes || []).length || String(a.addedAt).localeCompare(String(b.addedAt))
  );
}

// 참여자에서 빠진 사람이 투표자로 남아 있지 않도록 정리한다.
function syncVoterName() {
  if (activeVoterName && !eventData.participants.some((p) => p.name === activeVoterName)) {
    activeVoterName = null;
    storeVoter(null);
  }
}

function selectVoter(name) {
  activeVoterName = activeVoterName === name ? null : name;
  storeVoter(activeVoterName);
  $('place-error').textContent = '';
  renderVoterChips();
  renderPlaceList();
}

function renderVoterChips() {
  const wrap = $('place-voters');
  const hint = $('place-voter-hint');
  if (eventData.participants.length === 0) {
    wrap.innerHTML = '<span class="empty-note">아직 참여자가 없어요. 먼저 일정을 등록해 주세요.</span>';
    hint.textContent = '참여자가 등록되면 투표할 수 있어요.';
    return;
  }
  wrap.innerHTML = eventData.participants
    .map((p) => {
      const active = p.name === activeVoterName;
      return `<span class="person-chip${active ? ' active' : ''}" data-voter="${esc(p.name)}" role="button" tabindex="0" aria-pressed="${active}">${esc(p.name)}</span>`;
    })
    .join('');
  hint.textContent = activeVoterName
    ? `${activeVoterName} 님으로 투표하고 있어요. 이름을 다시 누르면 해제돼요.`
    : '이름을 선택하면 투표할 수 있어요.';
}

// 득표 1위를 목록 카드와 지도 핀에서 같은 기준으로 강조한다. (아무도 투표 전이면 1위 없음)
function rankedPlaces() {
  const places = sortedPlaces();
  const topVotes = places.length ? Math.max(...places.map((place) => (place.votes || []).length)) : 0;
  return places.map((place) => ({ ...place, isTop: topVotes > 0 && (place.votes || []).length === topVotes }));
}

function renderPlaceList() {
  const places = rankedPlaces();
  $('place-count').textContent = places.length;
  const wrap = $('place-list');
  if (places.length === 0) {
    wrap.innerHTML = '<span class="empty-note">아직 등록된 후보지가 없어요. 위에서 검색해 첫 후보를 등록해 보세요!</span>';
    return;
  }
  wrap.innerHTML = places
    .map((place, index) => {
      const votes = place.votes || [];
      const voted = Boolean(activeVoterName) && votes.includes(activeVoterName);
      const isConfirmed = place.id === eventData.confirmedPlaceId;
      return `
        <article class="place-card${place.isTop ? ' top-place' : ''}${isConfirmed ? ' confirmed-card' : ''}" id="place-card-${esc(place.id)}">
          <span class="place-no" aria-hidden="true">${index + 1}</span>
          <div class="place-body">
            <h3 class="place-name">${esc(place.name)}</h3>
            ${place.category ? `<p class="place-category">${esc(place.category)}</p>` : ''}
            <p class="place-address">${esc(place.roadAddress || place.address || '')}</p>
            <div class="place-votes">${
              votes.length
                ? votes.map((voter) => `<span class="name-tag ok">${esc(voter)}</span>`).join('')
                : '<span class="empty-note">아직 투표가 없어요.</span>'
            }</div>
          </div>
          <div class="place-actions">
            <button type="button" class="vote-btn${voted ? ' voted' : ''}" data-vote="${esc(place.id)}" aria-pressed="${voted}">
              <span aria-hidden="true">${voted ? '♥' : '♡'}</span> ${votes.length}
            </button>
            <a class="place-link" href="${esc(placeMapLink(place))}" target="_blank" rel="noopener noreferrer">지도 ↗</a>
            <button type="button" class="place-del" data-place-del="${esc(place.id)}" title="후보에서 삭제">✕</button>
          </div>
          <div class="place-card-footer">
            <button type="button" class="place-confirm-btn${isConfirmed ? ' confirmed' : ''}" data-place-confirm="${esc(place.id)}">
              ${isConfirmed ? '✓ 확정된 장소 · 다시 누르면 확정 취소' : '이 곳으로 확정하기'}
            </button>
          </div>
        </article>`;
    })
    .join('');
}

function showMapNote(message) {
  const note = $('place-map-note');
  note.textContent = message;
  note.hidden = false;
  $('place-map').classList.add('map-off');
}

async function updatePlaceMap() {
  if (!placeMap) {
    placeMap = new PlaceMap($('place-map'), { onSelect: focusPlaceCard, onAuthFailure: showMapNote });
    try {
      await placeMap.init(appConfig.naverMapKeyId);
      placeMapReady = true;
    } catch (err) {
      showMapNote(err.message);
      return;
    }
  }
  if (placeMapReady) placeMap.setPlaces(rankedPlaces());
}

function focusPlaceCard(placeId) {
  const card = $(`place-card-${placeId}`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('focused');
  setTimeout(() => card.classList.remove('focused'), 1600);
}

function renderSearchResults() {
  const wrap = $('place-results');
  wrap.innerHTML = searchResults
    .map((item, index) => {
      const active = selectedResultIndex === index;
      // <button> 안에는 <a> 를 넣을 수 없어 선택 버튼과 지도 링크를 나란히 둔다.
      return `
        <div class="place-result${active ? ' selected' : ''}">
          <button type="button" class="place-result-pick" data-result="${index}" aria-pressed="${active}">
            <span class="place-result-mark" aria-hidden="true">${active ? '●' : '○'}</span>
            <span class="place-result-body">
              <b>${esc(item.name)}</b>
              <small>${esc(item.roadAddress || item.address)}</small>
              ${item.category ? `<small class="place-result-category">${esc(item.category)}</small>` : ''}
            </span>
          </button>
          <a class="place-link" href="${esc(placeMapLink(item))}" target="_blank" rel="noopener noreferrer">지도 ↗</a>
        </div>`;
    })
    .join('');
  $('place-add-btn').disabled = selectedResultIndex === null;
}

async function searchPlaces() {
  const query = $('place-query').value.trim();
  const errorEl = $('place-error');
  errorEl.textContent = '';
  $('place-info').textContent = '';
  if (!query) {
    errorEl.textContent = '검색어를 입력해 주세요.';
    $('place-query').focus();
    return;
  }

  const button = $('place-search-btn');
  button.disabled = true;
  button.textContent = '검색 중…';
  try {
    const res = await fetch(`/api/places/search?query=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '장소를 검색하지 못했어요.');
    searchResults = data.items || [];
    selectedResultIndex = searchResults.length === 1 ? 0 : null;
    renderSearchResults();
    if (searchResults.length === 0) {
      errorEl.textContent = '검색 결과가 없어요. 지역명과 상호를 함께 넣어 다시 검색해 보세요.';
    }
  } catch (err) {
    searchResults = [];
    selectedResultIndex = null;
    renderSearchResults();
    errorEl.textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = '검색';
  }
}

async function addPlace() {
  if (selectedResultIndex === null) return;
  const item = searchResults[selectedResultIndex];
  const errorEl = $('place-error');
  const infoEl = $('place-info');
  errorEl.textContent = '';
  infoEl.textContent = '';

  const button = $('place-add-btn');
  button.disabled = true;
  try {
    const res = await fetch(`/api/events/${eventId}/places`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...item, link: $('place-link').value.trim(), addedBy: activeVoterName || '' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '후보지를 등록하지 못했어요.');
    eventData = data;
    searchResults = [];
    selectedResultIndex = null;
    $('place-query').value = '';
    $('place-link').value = '';
    renderSearchResults();
    renderPlacePanel();
    infoEl.textContent = `'${item.name}' 을(를) 후보로 등록했어요.`;
  } catch (err) {
    errorEl.textContent = err.message;
    button.disabled = false;
  }
}

async function votePlace(placeId) {
  const errorEl = $('place-error');
  errorEl.textContent = '';
  if (!activeVoterName) {
    errorEl.textContent = '먼저 위에서 내 이름을 선택해 주세요.';
    $('place-voters').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const res = await fetch(`/api/events/${eventId}/places`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ placeId, name: activeVoterName }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    errorEl.textContent = data.error || '투표하지 못했어요.';
    return;
  }
  eventData = data;
  renderPlaceList();
  updatePlaceMap();
}

async function deletePlace(placeId) {
  const place = (eventData.places || []).find((candidate) => candidate.id === placeId);
  if (!place || !confirm(`'${place.name}' 을(를) 후보에서 삭제할까요?`)) return;
  const res = await fetch(`/api/events/${eventId}/places?placeId=${encodeURIComponent(placeId)}`, { method: 'DELETE' });
  if (!res.ok) return;
  eventData = await res.json();
  // 확정된 장소를 지웠다면 공유 단계도 함께 닫혀야 한다.
  syncConfirmState();
  renderPlacePanel();
}

function renderConfirmedPlace() {
  const place = confirmedPlace();
  const banner = $('confirmed-place');
  banner.hidden = !place;
  if (!place) return;
  banner.innerHTML = `
    <p class="confirmed-place-label">확정된 장소</p>
    <p class="confirmed-place-name">${esc(place.name)}</p>
    <p class="confirmed-place-address">${esc(place.roadAddress || place.address || '')}</p>
    <a class="confirmed-place-link" href="${esc(placeMapLink(place))}" target="_blank" rel="noopener noreferrer">지도에서 보기 ↗</a>
    ${place.link ? '' : '<p class="confirmed-place-warn">장소 공유 링크가 없어 <b>검색</b>으로 연결돼요. 장소를 다시 확정하며 링크를 넣으면 공유할 때도 함께 전달됩니다.</p>'}`;
}

function renderPlacePanel() {
  renderConfirmedPlace();
  const meetTime = meetTimeLabel();
  $('venue-time').hidden = !meetTime;
  $('venue-time').textContent = meetTime ? `${meetTime}에 만나요` : '';
  syncVoterName();
  renderVoterChips();
  renderPlaceList();
  renderSearchResults();
  if (!appConfig.placeSearchEnabled) {
    $('place-search-hint').textContent = '장소 검색 키가 설정되지 않아 검색을 사용할 수 없어요. 모임 주최자에게 문의해 주세요.';
    $('place-query').disabled = true;
    $('place-search-btn').disabled = true;
  }
  updatePlaceMap();
}

// 가장 많은 인원이 겹친 1위 후보 날짜들(yyyy-MM-dd, 동점 포함)과 그 인원수.
// 일정 확정은 이 날짜들 중에서만 고를 수 있다. (서버 topCandidateDates 와 같은 규칙)
function topCandidateDates() {
  const counts = buildCounts();
  const dates = Object.keys(counts);
  if (dates.length === 0) return { dates: [], count: 0 };
  const maxCount = Math.max(...Object.values(counts));
  return { dates: dates.filter((date) => counts[date] === maxCount).sort(), count: maxCount };
}

// 확정 날짜 선택지 라벨: '2026. 9. 8. (화)'
function formatConfirmOption(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${year}. ${month}. ${day}. (${DOW_LABELS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]})`;
}

function openConfirmDialog() {
  const confirmed = Boolean(eventData.confirmedAt);
  $('confirm-dialog-title').textContent = confirmed ? '일정을 다시 정할까요?' : '일정을 확정할까요?';
  $('confirm-dialog-copy').textContent = confirmed
    ? '일정 확정을 풀어요. 장소 확정과 후보지·투표·만나는 시간 값은 그대로 남고, 다시 확정하면 이전 값이 채워져요.'
    : '만나는 날짜와 시간을 확정해요. 장소 정하기는 확정 전에도 어디서 볼까? 탭에서 병행할 수 있어요.';
  $('confirm-submit').textContent = confirmed ? '확정 풀기' : '확정하기';
  // 확정 취소에는 시간이 필요 없다.
  $('confirm-time-field').hidden = confirmed;
  $('confirm-date-field').hidden = confirmed;
  // 가장 많은 인원이 겹친 1위 후보 날짜만 고를 수 있다.
  const candidates = topCandidateDates();
  const dateSelect = $('confirm-date');
  dateSelect.innerHTML = candidates.dates
    .map((date) => `<option value="${date}">${formatConfirmOption(date)}</option>`)
    .join('');
  if (candidates.dates.includes(eventData.confirmedDate)) dateSelect.value = eventData.confirmedDate;
  dateSelect.disabled = candidates.dates.length === 0;
  $('confirm-date-hint').textContent = candidates.dates.length
    ? `가장 많은 인원(${candidates.count}명)이 겹친 1위 후보 ${candidates.dates.map(formatShortDate).join(', ')} 중에서 고를 수 있어요.`
    : '아직 등록된 일정이 없어 확정할 수 없어요. 먼저 일정을 등록해 주세요.';
  // 후보가 없으면(=아무도 일정을 등록하지 않음) 확정 자체가 불가능하다.
  $('confirm-submit').disabled = !confirmed && candidates.dates.length === 0;
  $('confirm-time').value = eventData.confirmedTime || DEFAULT_MEET_TIME;
  $('confirm-pin').value = '';
  $('confirm-error').textContent = '';
  $('confirm-dialog').showModal();
  (confirmed ? $('confirm-pin') : $('confirm-time')).focus();
}

async function submitConfirm(e) {
  e.preventDefault();
  const pin = $('confirm-pin').value;
  const errorEl = $('confirm-error');
  errorEl.textContent = '';

  const wasConfirmed = isScheduleConfirmed();
  const wasFullyConfirmed = isFullyConfirmed();
  const confirmedDate = $('confirm-date').value;
  const confirmedTime = $('confirm-time').value;
  if (!wasConfirmed && !confirmedDate) {
    errorEl.textContent = '만나는 날짜를 선택해 주세요.';
    $('confirm-date').focus();
    return;
  }
  if (!wasConfirmed && !CONFIRM_TIME_RE.test(confirmedTime)) {
    errorEl.textContent = '만나는 시간을 입력해 주세요.';
    $('confirm-time').focus();
    return;
  }
  if (!/^\d{4,6}$/.test(pin)) {
    errorEl.textContent = '관리 비밀번호는 숫자 4~6자리로 입력해 주세요.';
    $('confirm-pin').focus();
    return;
  }
  const button = $('confirm-submit');
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = '처리하는 중…';

  try {
    const res = await fetch(`/api/events/${eventId}/confirm`, {
      method: wasConfirmed ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ managePin: pin, confirmedDate, confirmedTime }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.deleteLockedUntil) {
        eventData.deleteLockedUntil = data.deleteLockedUntil;
        $('confirm-dialog').close();
        syncManageLockState();
        return;
      }
      throw new Error(data.error || '처리하지 못했습니다.');
    }
    eventData = data;
    $('confirm-dialog').close();
    syncManageLockState();
    syncConfirmState();
    renderPlaceList();
    // 결과 탭을 보고 있으면 후보/확정 카드가 실시간으로 전환되게 다시 그린다.
    if (!$('panel-result').hidden) renderResult();
    maybeEnterShareStep(wasFullyConfirmed);
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

// ---- 팀즈로 내보내기 ----
// 미리보기는 서버가 만드는 Adaptive Card 와 같은 규칙으로 그린다.

function formatShortDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${month}/${day}(${DOW_LABELS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]})`;
}

function topDateRanks(limit = 3) {
  const counts = buildCounts();
  const ranked = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([dateA, countA], [dateB, countB]) => countB - countA || dateA.localeCompare(dateB));
  return [...new Set(ranked.map(([, count]) => count))].slice(0, limit).map((count, index) => ({
    rank: index + 1,
    count,
    dates: ranked.filter(([, dateCount]) => dateCount === count).map(([date]) => formatShortDate(date)),
  }));
}

function previewRow(label, value) {
  return `<div class="teams-preview-row"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
}

function renderTeamsPreview() {
  const note = $('teams-note').value.trim();
  const place = confirmedPlace();

  const rows = [
    previewRow('날짜', `${eventData.confirmedDate} (${formatShortDate(eventData.confirmedDate)})`),
    previewRow('시간', `${eventData.confirmedTime} · ${formatMeetTime(eventData.confirmedTime)}`),
  ];
  if (place) {
    rows.push(previewRow('장소', place.name));
    if (place.roadAddress || place.address) rows.push(previewRow('주소', place.roadAddress || place.address));
    if (place.link) rows.push(previewRow('장소 공유 링크', place.link));
  }
  rows.push(previewRow('참여 인원', `${eventData.participants.length}명 / 총원 ${eventData.totalCount}명`));

  $('teams-preview').innerHTML = `
    <p class="teams-preview-title">🍷 ${esc(eventData.title)}</p>
    <p class="teams-preview-meta">${esc(formatShortDate(eventData.confirmedDate))} ${esc(formatMeetTime(eventData.confirmedTime))}</p>
    ${note ? `<p class="teams-preview-note">${esc(note)}</p>` : ''}
    ${rows.join('')}
    <p class="teams-preview-action">${place && place.link ? '지도에서 보기 · ' : ''}약속 페이지 열기 →</p>`;

  renderWebhookFields();
}

// 워크플로에서 꺼내 쓸 수 있는 최상위 필드. (서버 buildWebhookPayload 와 같은 규칙)
function renderWebhookFields() {
  const place = confirmedPlace();
  const fields = [
    ['date', eventData.confirmedDate],
    ['time', eventData.confirmedTime],
    ['poi_name', place ? place.name : ''],
    ['address', place ? place.roadAddress || place.address || '' : ''],
    ['web_link', location.href],
  ];
  if (place && place.link) fields.push(['url', place.link]);
  $('webhook-fields').innerHTML =
    fields.map(([key, value]) => `<div class="webhook-field"><code>${key}</code><span>${esc(value)}</span></div>`).join('') +
    (place && place.link ? '' : '<p class="hint">장소 공유 링크가 없어 <code>url</code> 필드는 <b>보내지 않습니다.</b> 장소를 다시 확정하며 링크를 넣으면 포함돼요.</p>');
}

// OG 설명문·공유 문구에 쓰는 요약. (서버 buildEventMeta 와 같은 규칙)
function shareSummaryParts() {
  const parts = [];
  if (isScheduleConfirmed()) {
    parts.push(`${formatShortDate(eventData.confirmedDate)} ${formatMeetTime(eventData.confirmedTime)}`);
    const place = confirmedPlace();
    if (place) parts.push(place.name);
  } else {
    const dateRanks = topDateRanks(1);
    parts.push(dateRanks.length ? `날짜 1위 ${dateRanks[0].dates.join(', ')} (${dateRanks[0].count}명)` : '아직 등록된 일정이 없어요');
  }
  parts.push(`참여 ${eventData.participants.length}명 / 총원 ${eventData.totalCount}명`);
  return parts;
}

// 공유 문구(카카오톡 텍스트 · Teams 공유창 미리채움 공용).
// 공유는 일정·장소가 모두 확정된 뒤에만 열리므로 확정 값이 항상 존재한다.
// 개행은 CRLF 로 넣는다 — Teams 공유창이 URL 파라미터의 LF(%0A)만으로는 줄을 나누지 않는 경우가 있다.
function buildShareMessage() {
  const place = confirmedPlace();
  const lines = [
    eventData.title,
    `모임 날짜/시간   : ${formatShortDate(eventData.confirmedDate)} ${formatMeetTime(eventData.confirmedTime)}`,
    `모이는 곳        : ${place ? place.name : ''}`,
  ];
  if (place && place.link) lines.push(`장소 공유 링크   : ${place.link}`);
  lines.push(`모임 인원        : 참여 ${eventData.participants.length}명 / 총원 ${eventData.totalCount}명`);
  lines.push(`웹에서 자세히보기: ${location.href}`);
  return lines.join('\r\n');
}

// 채널에 붙는 링크 카드는 서버가 넣어준 OG 태그로 만들어진다. 같은 내용을 화면에서도 보여준다.
function renderLinkPreview() {
  $('link-preview').innerHTML = `
    <p class="link-preview-title">🍷 ${esc(eventData.title)}</p>
    <p class="link-preview-desc">${esc(shareSummaryParts().join(' · '))}</p>
    <p class="link-preview-host">${esc(location.host)}</p>`;
}

// Share to Teams 런처는 외부 스크립트라 차단되거나 늦게 로드될 수 있다.
async function renderShareLauncher() {
  const container = $('share-launcher');
  const hint = $('share-launcher-hint');
  container.innerHTML = '';
  hint.classList.remove('validation-invalid');

  if (!window.shareToMicrosoftTeams) {
    hint.textContent = 'Teams 공유 버튼을 불러오지 못했어요. 아래 자동 게시를 쓰거나 참여 링크를 복사해 붙여넣어 주세요.';
    hint.classList.add('validation-invalid');
    return;
  }

  hint.textContent = '팀즈 공유는 데스크톱 Chrome·Edge에서만 동작해요. 모바일에서는 카카오톡 공유나 참여 링크 복사를 이용해 주세요.';
  const button = document.createElement('div');
  button.className = 'teams-share-button';
  button.setAttribute('data-href', location.href);
  button.setAttribute('data-msg-text', buildShareMessage());
  button.setAttribute('data-icon-px-size', '32');
  container.appendChild(button);
  try {
    await window.shareToMicrosoftTeams.renderButtons({ elements: [button] });
    // 런처는 아이콘만 그린다. 앵커 안에 라벨을 넣어야 글자를 눌러도 공유 창이 열린다.
    const anchor = button.querySelector('a');
    if (anchor && !anchor.querySelector('.share-launcher-label')) {
      const label = document.createElement('span');
      label.className = 'share-launcher-label';
      label.textContent = '팀즈로 공유';
      anchor.appendChild(label);
    }
  } catch {
    hint.textContent = 'Teams 공유 버튼을 표시하지 못했어요. 아래 자동 게시를 이용해 주세요.';
    hint.classList.add('validation-invalid');
  }
}

// 웹후크 URL은 서버에 저장하지 않는다. 대신 이 브라우저에만 기억해 재입력을 덜어 준다.
const WEBHOOK_STORAGE_KEY = 'dinner-teams-webhook';

function readStoredWebhook() {
  try {
    return localStorage.getItem(WEBHOOK_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function storeWebhook(url) {
  try {
    if (url) localStorage.setItem(WEBHOOK_STORAGE_KEY, url);
    else localStorage.removeItem(WEBHOOK_STORAGE_KEY);
  } catch {
    // 시크릿 모드 등 저장이 막힌 환경에서는 기억하지 않고 넘어간다.
  }
}

let pendingPlaceId = null;

// placeId 를 주면 그 후보를 확정하는 모드(카드 버튼), 없으면 득표순 선택 모드(상단 스위치).
function openPlaceDialog(placeId) {
  const pickField = $('place-dialog-pick-field');
  const isPickMode = !placeId;
  let place = null;

  if (isPickMode) {
    const places = rankedPlaces();
    if (places.length === 0) {
      switchTab('place');
      $('place-error').textContent = '후보지를 먼저 등록해 주세요.';
      $('place-query').focus();
      return;
    }
    pickField.hidden = false;
    $('place-confirm-pick').innerHTML = places
      .map((candidate) => `<option value="${esc(candidate.id)}">${esc(candidate.name)} · ${(candidate.votes || []).length}표</option>`)
      .join('');
    place = places[0];
    pendingPlaceId = place.id;
  } else {
    place = (eventData.places || []).find((candidate) => candidate.id === placeId);
    if (!place) return;
    pickField.hidden = true;
    pendingPlaceId = placeId;
  }

  const isConfirmed = !isPickMode && place.id === eventData.confirmedPlaceId;
  $('place-dialog-title').textContent = isConfirmed ? '장소를 다시 정할까요?' : '이 곳으로 확정할까요?';
  $('place-dialog-copy').textContent = isConfirmed
    ? `'${place.name}' 확정을 풀면 일정을 공유할 수 없게 돼요. 후보지와 투표는 그대로 남습니다.`
    : isPickMode
      ? '최종 장소를 고르고 확정하면 일정 확정과 함께 공유 단계가 열려요.'
      : `'${place.name}'을(를) 최종 장소로 확정하면 공유 단계가 열려요.`;
  $('place-dialog-submit').textContent = isConfirmed ? '확정 풀기' : '장소 확정하기';
  $('place-dialog-link-field').hidden = isConfirmed;
  $('place-confirm-link').value = place.link || '';
  $('place-confirm-pin').value = '';
  $('place-dialog-error').textContent = '';
  $('place-dialog').showModal();
  $('place-confirm-pin').focus();
}

// 상단 '장소 확정하기' 스위치: OFF→확정 다이얼로그(후보 선택), ON→확정 풀기 다이얼로그
function togglePlaceConfirm() {
  const confirmed = confirmedPlace();
  openPlaceDialog(confirmed ? confirmed.id : null);
}

async function submitPlaceConfirm(e) {
  e.preventDefault();
  const errorEl = $('place-dialog-error');
  errorEl.textContent = '';
  const pin = $('place-confirm-pin').value;
  if (!/^\d{4,6}$/.test(pin)) {
    errorEl.textContent = '관리 비밀번호는 숫자 4~6자리로 입력해 주세요.';
    $('place-confirm-pin').focus();
    return;
  }

  const isConfirmed = pendingPlaceId === eventData.confirmedPlaceId;
  const wasFullyConfirmed = isFullyConfirmed();
  const button = $('place-dialog-submit');
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = '처리하는 중…';
  try {
    const res = await fetch(`/api/events/${eventId}/confirm-place`, {
      method: isConfirmed ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ managePin: pin, placeId: pendingPlaceId, link: $('place-confirm-link').value.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.deleteLockedUntil) {
        eventData.deleteLockedUntil = data.deleteLockedUntil;
        $('place-dialog').close();
        syncManageLockState();
        return;
      }
      throw new Error(data.error || '처리하지 못했어요.');
    }
    eventData = data;
    $('place-dialog').close();
    syncConfirmState();
    renderPlacePanel();
    // 결과 탭을 보고 있으면 후보/확정 카드가 실시간으로 전환되게 다시 그린다.
    if (!$('panel-result').hidden) renderResult();
    maybeEnterShareStep(wasFullyConfirmed);
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

// ---- 카카오톡 공유 ----
// 카카오 JavaScript 키(config.kakaoJsKey)가 있으면 공식 SDK 로 공유 창을 연다.
// 키가 없거나 SDK 로드에 실패하면 OS 공유 시트(navigator.share) → 클립보드 복사 순으로 폴백한다.
const KAKAO_SDK_SRC = 'https://t1.kakaocdn.net/kakao_js_sdk/2.7.9/kakao.min.js';
const KAKAO_SDK_INTEGRITY = 'sha384-JpLApTkB8lPskhVMhT+m5Ln8aHlnS0bsIexhaak0jOhAkMYedQoVghPfSpjNi9K1';
let kakaoLoadPromise = null;

// OS 공유 시트는 모바일에서만 쓴다. (데스크톱 시트에는 카카오톡이 없는 경우가 많다)
function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function loadKakaoSdk() {
  if (kakaoLoadPromise) return kakaoLoadPromise;
  kakaoLoadPromise = new Promise((resolve, reject) => {
    if (!appConfig.kakaoJsKey) {
      reject(new Error('no-key'));
      return;
    }
    const script = document.createElement('script');
    script.src = KAKAO_SDK_SRC;
    script.integrity = KAKAO_SDK_INTEGRITY;
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      try {
        if (!window.Kakao.isInitialized()) window.Kakao.init(appConfig.kakaoJsKey);
        resolve(window.Kakao);
      } catch (error) {
        reject(error);
      }
    };
    script.onerror = () => reject(new Error('load-failed'));
    document.head.appendChild(script);
  });
  // 실패했으면 다음 시도 때 다시 로드할 수 있게 캐시를 비운다.
  kakaoLoadPromise.catch(() => (kakaoLoadPromise = null));
  return kakaoLoadPromise;
}

async function shareToKakao() {
  const hint = $('kakao-share-hint');
  hint.classList.remove('validation-invalid');
  const message = buildShareMessage();

  // 1순위: 카카오 공식 SDK (친구/채팅방 선택 창)
  try {
    const kakao = await loadKakaoSdk();
    kakao.Share.sendDefault({
      objectType: 'text',
      text: message,
      link: { mobileWebUrl: location.href, webUrl: location.href },
      buttonTitle: '약속 확인하기',
    });
    hint.textContent = '카카오톡 공유 창을 열었어요.';
    return;
  } catch {
    // 아래 폴백으로
  }

  // 2순위: OS 공유 시트 (모바일 — 카카오톡 선택 가능)
  if (navigator.share && isMobileDevice()) {
    try {
      await navigator.share({ title: eventData.title, text: message });
      hint.textContent = '공유 창을 열었어요. 목록에서 카카오톡을 선택해 주세요.';
      return;
    } catch (error) {
      if (error.name === 'AbortError') return; // 사용자가 닫음
    }
  }

  // 3순위: 문구 복사 (clipboard API 실패 시 execCommand 폴백)
  if (await copyTextToClipboard(message)) {
    hint.textContent = '공유 문구를 복사했어요. 카카오톡 채팅방에 붙여넣어 주세요.';
  } else {
    hint.textContent = '복사에 실패했어요. 아래 미리보기 내용을 직접 복사해 주세요.';
    hint.classList.add('validation-invalid');
  }
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 포커스 문제나 비보안 컨텍스트에서는 예전 방식으로 복사한다.
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    textarea.remove();
    return copied;
  }
}

// 다이얼로그를 열 때 현재 환경에서 어떤 방식으로 공유되는지 안내한다.
function renderKakaoHint() {
  const hint = $('kakao-share-hint');
  hint.classList.remove('validation-invalid');
  if (appConfig.kakaoJsKey) hint.textContent = '';
  else if (navigator.share && isMobileDevice()) hint.textContent = '공유 창이 열리면 목록에서 카카오톡을 선택해 주세요.';
  else hint.textContent = '이 브라우저에서는 공유 문구가 복사돼요. 카카오톡에 붙여넣어 주세요.';
}

// 방금의 확정으로 일정·장소가 모두 갖춰졌으면 공유 단계로 넘긴다:
// '어디서 볼까?' 탭의 확정 카드로 이동시키고 공유 다이얼로그를 바로 연다.
function maybeEnterShareStep(wasFullyConfirmed) {
  if (wasFullyConfirmed || !isFullyConfirmed()) return;
  switchTab('place');
  const confirmedCard = document.querySelector('.place-card.confirmed-card');
  if (confirmedCard) confirmedCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  openTeamsDialog();
}

function openTeamsDialog() {
  const storedWebhook = readStoredWebhook();
  $('teams-webhook').value = storedWebhook;
  $('teams-webhook-clear').hidden = !storedWebhook;
  $('teams-note').value = '';
  $('teams-error').textContent = '';
  $('teams-info').textContent = '';
  $('teams-advanced').open = false;
  renderLinkPreview();
  renderTeamsPreview();
  renderShareLauncher();
  renderKakaoHint();
  $('teams-dialog').showModal();
}

async function submitTeamsExport(e) {
  e.preventDefault();
  const errorEl = $('teams-error');
  const infoEl = $('teams-info');
  errorEl.textContent = '';
  infoEl.textContent = '';

  const webhookUrl = $('teams-webhook').value.trim();
  if (!webhookUrl) {
    errorEl.textContent = '웹후크 URL을 입력해 주세요.';
    $('teams-webhook').focus();
    return;
  }

  const button = $('teams-submit');
  const originalLabel = button.innerHTML;
  button.disabled = true;
  button.textContent = '보내는 중…';
  try {
    const res = await fetch(`/api/events/${eventId}/teams-export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl, note: $('teams-note').value.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    // 서버의 URL 형식 검증(400)을 통과했다면 브라우저에 기억해 둔다.
    // (401 등 워크플로 설정 문제는 URL 자체는 맞는 경우라 함께 기억한다)
    if (res.status !== 400) {
      storeWebhook(webhookUrl);
      $('teams-webhook-clear').hidden = false;
    }
    if (!res.ok) throw new Error(data.error || '내보내지 못했어요.');
    infoEl.textContent = '채널로 보냈어요! 팀즈에서 확인해 주세요.';
    setTimeout(() => $('teams-dialog').close(), 1400);
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    button.disabled = false;
    button.innerHTML = originalLabel;
  }
}

async function init() {
  const [loadedEvent, loadedConfig] = await Promise.all([eventId ? loadEvent() : null, loadConfig()]);
  eventData = loadedEvent;
  appConfig = loadedConfig;
  if (!eventData) {
    $('not-found').hidden = false;
    return;
  }
  $('app').hidden = false;
  // 약속 생성 시 조회해 둔 공휴일이 있으면 내장 목록 대신 사용한다.
  setActiveHolidays(eventData.holidays);
  activeVoterName = readStoredVoter();

  document.title = `${eventData.title} - 회식 날짜 잡기`;

  const range = eventRange();

  voteCal = new Calendar($('vote-calendar'), {
    theme: eventData.theme,
    mode: 'select',
    startDate: range.startDate,
    endDate: range.endDate,
    canSelect: () => Boolean(activeParticipantName || $('name').value.trim()),
    onChange: (sel) => {
      updateSelectedCount(sel.size);
    },
  });
  voteCal.render();
  updateSelectedCount(0);

  resultCal = new Calendar($('result-calendar'), {
    theme: eventData.theme,
    mode: 'result',
    startDate: range.startDate,
    endDate: range.endDate,
    onDateClick: showDateDetail,
  });
  resultCal.render();

  renderHead();
  renderVotePeople();
  syncNameInputState();
  syncManageLockState();
  syncConfirmState();

  $('tab-vote').addEventListener('click', () => switchTab('vote'));
  $('tab-result').addEventListener('click', () => switchTab('result'));
  $('save-btn').addEventListener('click', saveMySchedule);

  // 새 이름은 엔터로 참여자만 먼저 등록하고, 입력칸은 바로 비운다.
  $('name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      saveMySchedule();
    }
  });

  // 기존 참여자를 선택한 뒤 새 이름을 입력하면 새 참여자 등록 흐름으로 전환한다.
  $('name').addEventListener('input', () => {
    if (activeParticipantName) {
      activeParticipantName = null;
      voteCal.setSelected([]);
      renderVotePeople();
      syncNameInputState();
    }
    voteCal.render();
    updateSaveState();
  });

  // 저장하기 버튼이 화면에서 벗어나면 하단 플로팅 저장 바를 띄운다.
  // (플로팅 바는 #panel-vote 안에 있어서 결과 탭에서는 패널과 함께 숨겨진다.)
  $('float-save-btn').addEventListener('click', saveMySchedule);
  const floatEl = $('float-save');
  new IntersectionObserver(
    ([entry]) => {
      floatEl.hidden = entry.isIntersecting;
    },
    { rootMargin: '0px 0px -8px 0px' }
  ).observe($('save-btn'));

  $('copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $('copy-link').textContent = '✅ 복사 완료!';
    } catch {
      prompt('아래 링크를 복사하세요.', location.href);
    }
    setTimeout(() => ($('copy-link').textContent = '🔗 참여 링크 복사'), 1500);
  });
  $('teams-dialog-form').addEventListener('submit', submitTeamsExport);
  $('teams-dialog-close').addEventListener('click', () => $('teams-dialog').close());
  $('kakao-share-btn').addEventListener('click', shareToKakao);
  $('teams-webhook-clear').addEventListener('click', () => {
    storeWebhook(null);
    $('teams-webhook').value = '';
    $('teams-webhook-clear').hidden = true;
    $('teams-webhook').focus();
  });
  $('teams-note').addEventListener('input', renderTeamsPreview);

  $('tab-place').addEventListener('click', () => switchTab('place'));

  $('confirm-event').addEventListener('click', openConfirmDialog);
  $('confirm-dialog-form').addEventListener('submit', submitConfirm);
  $('confirm-dialog-close').addEventListener('click', () => $('confirm-dialog').close());

  $('place-search-btn').addEventListener('click', searchPlaces);
  $('place-query').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      searchPlaces();
    }
  });
  $('place-add-btn').addEventListener('click', addPlace);

  // 검색 결과: 한 번 더 누르면 선택 해제
  $('place-results').addEventListener('click', (e) => {
    const result = e.target.closest('[data-result]');
    if (!result) return;
    const index = Number(result.dataset.result);
    selectedResultIndex = selectedResultIndex === index ? null : index;
    renderSearchResults();
  });

  $('place-voters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-voter]');
    if (chip) selectVoter(chip.dataset.voter);
  });
  $('place-voters').addEventListener('keydown', (e) => {
    const chip = e.target.closest('[data-voter]');
    if (chip && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      selectVoter(chip.dataset.voter);
    }
  });

  // 후보지 카드: ♥ → 투표 토글, ✕ → 후보 삭제
  $('place-list').addEventListener('click', (e) => {
    const voteButton = e.target.closest('[data-vote]');
    if (voteButton) {
      votePlace(voteButton.dataset.vote);
      return;
    }
    const deleteButton = e.target.closest('[data-place-del]');
    if (deleteButton) {
      deletePlace(deleteButton.dataset.placeDel);
      return;
    }
    const confirmButton = e.target.closest('[data-place-confirm]');
    if (confirmButton) openPlaceDialog(confirmButton.dataset.placeConfirm);
  });

  const shareStepBadge = $('steps').querySelector('[data-step="3"]');
  shareStepBadge.addEventListener('click', () => {
    if (isFullyConfirmed()) openTeamsDialog();
  });
  shareStepBadge.addEventListener('keydown', (e) => {
    if (isFullyConfirmed() && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openTeamsDialog();
    }
  });

  $('place-ranking-all').addEventListener('click', openPlaceRankingDialog);
  $('place-ranking-close').addEventListener('click', () => $('place-ranking-dialog').close());

  $('place-dialog-form').addEventListener('submit', submitPlaceConfirm);
  $('place-dialog-close').addEventListener('click', () => $('place-dialog').close());
  $('confirm-place-toggle').addEventListener('click', togglePlaceConfirm);
  $('place-confirm-pick').addEventListener('change', (e) => {
    pendingPlaceId = e.target.value;
    const picked = (eventData.places || []).find((candidate) => candidate.id === pendingPlaceId);
    $('place-confirm-link').value = picked && picked.link ? picked.link : '';
  });

  $('cancel-event').addEventListener('click', openCancelDialog);
  $('cancel-dialog-form').addEventListener('submit', cancelEvent);
  $('cancel-dialog-close').addEventListener('click', () => $('cancel-dialog').close());
  $('cancel-success-home').addEventListener('click', returnHome);
  $('cancel-success-dialog').addEventListener('cancel', (e) => {
    e.preventDefault();
    returnHome();
  });

  // 참여자 칩: 클릭 → 일정 수정 활성화, ✕ → 삭제
  $('vote-people').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      deleteParticipant(del.dataset.del);
      return;
    }
    const chip = e.target.closest('.person-chip[data-name]');
    if (chip) {
      activateParticipant(chip.dataset.name);
    }
  });

  $('vote-people').addEventListener('keydown', (e) => {
    if (e.target.closest('[data-del]')) return;
    const chip = e.target.closest('.person-chip[data-name]');
    if (chip && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      activateParticipant(chip.dataset.name);
    }
  });
}

init();
