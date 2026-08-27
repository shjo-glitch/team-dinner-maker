'use strict';

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// '특정 날짜까지' 선택 시에만 날짜 입력칸 표시
const rangeEndInput = document.getElementById('range-end');
const managePinInput = document.getElementById('manage-pin');
const managePinHint = document.getElementById('manage-pin-hint');
const MANAGE_PIN_HINT = '약속을 파기할 때 필요한 비밀번호예요. 잊으면 복구할 수 없어요.';

function updateManagePinHint() {
  const pin = managePinInput.value;
  managePinHint.classList.remove('validation-invalid', 'validation-valid');
  if (!pin) {
    managePinHint.textContent = MANAGE_PIN_HINT;
    return;
  }
  if (!/^\d{4,6}$/.test(pin)) {
    managePinHint.textContent = '비밀번호는 4~6자 숫자로 입력해주세요.';
    managePinHint.classList.add('validation-invalid');
    return;
  }
  managePinHint.textContent = 'OK';
  managePinHint.classList.add('validation-valid');
}

managePinInput.addEventListener('input', updateManagePinHint);

document.querySelectorAll('input[name="range"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const custom = radio.value === 'custom' && radio.checked;
    rangeEndInput.hidden = !custom;
    if (custom) {
      rangeEndInput.min = fmtDate(new Date());
      rangeEndInput.focus();
    }
  });
});

// 표시 범위 계산: 이번달(오늘~말일) / 다음달(1일~말일) / 특정 날짜까지(오늘~지정일)
function computeRange() {
  const range = document.querySelector('input[name="range"]:checked').value;
  const today = new Date();
  if (range === 'this-month') {
    return { startDate: fmtDate(today), endDate: fmtDate(new Date(today.getFullYear(), today.getMonth() + 1, 0)) };
  }
  if (range === 'next-month') {
    return {
      startDate: fmtDate(new Date(today.getFullYear(), today.getMonth() + 1, 1)),
      endDate: fmtDate(new Date(today.getFullYear(), today.getMonth() + 2, 0)),
    };
  }
  const end = rangeEndInput.value;
  if (!end) return { error: '마지막 날짜를 선택해 주세요.' };
  if (end < fmtDate(today)) return { error: '마지막 날짜는 오늘 이후여야 합니다.' };
  return { startDate: fmtDate(today), endDate: end };
}

document.getElementById('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('create-error');
  errorEl.textContent = '';

  const range = computeRange();
  if (range.error) {
    errorEl.textContent = range.error;
    return;
  }

  const payload = {
    title: document.getElementById('title').value.trim(),
    totalCount: Number(document.getElementById('total').value),
    managePin: managePinInput.value,
    theme: document.querySelector('input[name="theme"]:checked').value,
    startDate: range.startDate,
    endDate: range.endDate,
  };

  if (!/^\d{4,6}$/.test(payload.managePin)) {
    errorEl.textContent = '관리 비밀번호는 숫자 4~6자리로 입력해 주세요.';
    document.getElementById('manage-pin').focus();
    return;
  }

  try {
    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '약속을 만들지 못했습니다.');
    location.href = `/m/${data.id}`;
  } catch (err) {
    errorEl.textContent = err.message;
  }
});
