const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

if (tg) {
  tg.ready();
  tg.expand();
}

const form = document.getElementById('search-form');
const statusBox = document.getElementById('status');
const positionsList = document.getElementById('positions-list');
const addPositionBtn = document.getElementById('add-position-btn');
const positionBlockTemplate = document.getElementById('position-block-template');

function renumberPositionBlocks() {
  const blocks = positionsList.querySelectorAll('.position-block');
  blocks.forEach((block, index) => {
    block.querySelector('.position-block-title').textContent = `Должность ${index + 1}`;
    block.querySelector('.remove-position-btn').style.visibility = blocks.length > 1 ? 'visible' : 'hidden';
  });
}

function addPositionBlock(position, city) {
  const fragment = positionBlockTemplate.content.cloneNode(true);
  const block = fragment.querySelector('.position-block');
  block.querySelector('.position-input').value = position || '';
  block.querySelector('.city-input').value = city || '';
  block.querySelector('.remove-position-btn').addEventListener('click', () => {
    if (positionsList.querySelectorAll('.position-block').length <= 1) return;
    block.remove();
    renumberPositionBlocks();
  });
  positionsList.appendChild(block);
  renumberPositionBlocks();
}

addPositionBlock('Бухгалтер', 'Киев');

addPositionBtn.addEventListener('click', () => {
  addPositionBlock('', '');
});

function getChatIdFromQuery() {
  const params = new URLSearchParams(window.location.search);
  return params.get('chat_id') || '';
}

function getTelegramUserId() {
  const userId = tg && tg.initDataUnsafe && tg.initDataUnsafe.user
    ? tg.initDataUnsafe.user.id
    : '';

  return userId ? String(userId) : '';
}

function getTargetChatId() {
  return getChatIdFromQuery() || getTelegramUserId();
}

function getTelegramUsername() {
  return tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.username
    ? tg.initDataUnsafe.user.username
    : '';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const positions = Array.from(positionsList.querySelectorAll('.position-block')).map((block) => ({
    position: block.querySelector('.position-input').value.trim(),
    city: block.querySelector('.city-input').value.trim()
  }));

  const payload = {
    positions,
    employmentType: (formData.get('employmentType') || 'any').toString(),
    minExperienceYears: (formData.get('minExperienceYears') || '').toString().trim(),
    telegramUsername: getTelegramUsername()
  };

  if (!positions.length || positions.some((item) => !item.position || !item.city)) {
    statusBox.textContent = 'Заполните должность и город для каждой позиции.';
    return;
  }

  if (payload.minExperienceYears !== '') {
    const years = Number(payload.minExperienceYears);
    if (!Number.isFinite(years) || years < 0) {
      statusBox.textContent = 'Минимальный опыт должен быть числом от 0.';
      return;
    }
  }

  const chatId = getTargetChatId();
  if (!chatId) {
    statusBox.textContent = 'Откройте форму по кнопке Старт в боте.';
    return;
  }

  statusBox.textContent = 'Отправляю запрос боту...';

  try {
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, chatId })
    });

    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error || 'Ошибка отправки запроса.');
    }

    statusBox.textContent = 'Готово. Результаты отправлены в Telegram-чат.';

    if (tg) {
      setTimeout(() => tg.close(), 1200);
    }
  } catch (error) {
    statusBox.textContent = error.message || 'Ошибка сети. Попробуйте снова.';
  }
});