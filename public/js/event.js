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

let eventData = null;
let voteCal = null;
let resultCal = null;
let activeParticipantName = null;

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

function renderResult() {
  const counts = buildCounts();
  // 뱃지 농도: 1명이 선택할 때마다 (1/참여자 수)씩 진해진다.
  resultCal.setResult(counts, eventData.participants.length);
  renderCandidateRanking(counts);

  $('result-people-count').textContent = eventData.participants.length;
  const wrap = $('result-people');
  wrap.innerHTML =
    eventData.participants.length === 0
      ? '<span class="empty-note">아직 참여자가 없어요.</span>'
      : eventData.participants.map((p) => `<span class="person-chip" style="cursor:default">${esc(p.name)}</span>`).join('');
}

function showDateDetail(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = ['일', '월', '화', '수', '목', '금', '토'][new Date(y, m - 1, d).getDay()];
  const ok = eventData.participants.filter((p) => p.dates.includes(dateStr));
  const no = eventData.participants.filter((p) => !p.dates.includes(dateStr));
  const holiday = KR_HOLIDAYS[dateStr];

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
  $('panel-vote').hidden = tab !== 'vote';
  $('panel-result').hidden = tab !== 'result';
  if (tab === 'result') renderResult();
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

async function cancelEvent() {
  const confirmed = confirm(`'${eventData.title}' 약속과 참여자 일정이 모두 삭제됩니다.\n이 작업은 되돌릴 수 없습니다.\n\n정말 파기할까요?`);
  if (!confirmed) return;

  const button = $('cancel-event');
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = '파기하는 중…';

  try {
    const res = await fetch(`/api/events/${eventId}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 404) throw new Error(data.error || '약속을 파기하지 못했습니다.');
    location.assign('/');
  } catch (err) {
    alert(err.message || '약속을 파기하지 못했습니다. 다시 시도해 주세요.');
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function init() {
  eventData = eventId ? await loadEvent() : null;
  if (!eventData) {
    $('not-found').hidden = false;
    return;
  }
  $('app').hidden = false;

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
  $('cancel-event').addEventListener('click', cancelEvent);

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
