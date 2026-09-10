(() => {
  const $ = id => document.getElementById(id);
  let token = null, room = null, cursor = 0, pollTimer, busy = false, transitionBusy = false, generation = 0, failures = 0;
  let currentState = 'idle';
  let waitingStarted = 0, waitingClock = null;
  const stickers = { genko: 'images/sticker-genko.jpg', gossip: 'images/sticker-gossip.jpg', eh: 'images/sticker-eh.jpg', warrior: 'images/break-poster.jpg', saying: 'images/wall-saying.jpg', tvface: 'images/tv-comedy-face.jpg' };
  const stickerToken = /^\[sticker:(genko|gossip|eh|warrior|saying|tvface)\]$/;
  const cafeAliases = ['ابن المعلم', 'زبون الترابيزة', 'صاحب آخر شاي', 'وش القهوة', 'رايق الحارة', 'صاحب الفنجان'];
  const breakPosters = [
    ['images/break-poster.jpg', 'استراحة محارب… وجايبلك قعدة تانية'],
    ['images/sticker-genko.jpg', 'جنّنوا آدم… والقعدة الجاية أهدى'],
    ['images/wall-saying.jpg', 'كلام قليل… وقعدة جديدة كبيرة'],
    ['images/tv-comedy-face.jpg', 'فاصل ونواصل مع شخص تاني']
  ];
  let peerAlias = 'صاحب الفنجان';
  function playMatchChime() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(760, context.currentTime); oscillator.frequency.exponentialRampToValueAtTime(1040, context.currentTime + .12);
      gain.gain.setValueAtTime(.0001, context.currentTime); gain.gain.exponentialRampToValueAtTime(.12, context.currentTime + .02); gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + .24);
      oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + .25); oscillator.onended = () => context.close();
    } catch {}
  }
  function updateWaitingClock() {
    if (!waitingStarted) return;
    const seconds = Math.floor((Date.now() - waitingStarted) / 1000);
    $('waiting-time').textContent = seconds < 5 ? 'ثواني ونبدأ' : seconds < 60 ? `مستنيين بقالنا ${seconds} ثانية` : 'لسه بندور… خليك معانا';
  }
  function startWaitingClock() {
    if (!waitingStarted) waitingStarted = Date.now();
    clearInterval(waitingClock); updateWaitingClock(); waitingClock = setInterval(updateWaitingClock, 1000);
  }
  function stopWaitingClock() { clearInterval(waitingClock); waitingClock = null; waitingStarted = 0; }
  const errors = {
    slow_down: 'واحدة واحدة… استنى شوية وجرب تاني.',
    busy: 'القهوة زحمة دلوقتي، جرّب كمان شوية.',
    conversation_ended: 'المحادثة انتهت. اختار شخص تاني.',
    reporting_unavailable: 'الإبلاغ مش متاح حاليًا. تقدر تحظر الشخص وتنهي القعدة.',
    invalid_message: 'اكتب رسالة من حرف إلى ١٠٠٠ حرف.'
  };
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cafe-theme', theme);
    const dark = theme === 'dark';
    $('theme-toggle').querySelector('span').textContent = dark ? '☀️' : '🌙';
    $('theme-toggle').setAttribute('aria-label', dark ? 'افتح القهوة الصبح' : 'افتح القهوة بالليل');
  }
  async function api(route, data) {
    const response = await fetch(`/api/${route}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(12000), cache: 'no-store'
    });
    let value;
    try { value = await response.json(); } catch { throw new Error('offline'); }
    if (!response.ok) throw new Error(value.error || 'offline');
    return value;
  }
  function empty(text) { $('messages').replaceChildren(); const p = document.createElement('p'); p.className = 'empty'; p.textContent = text; $('messages').append(p); }
  function display(value) {
    const changedRoom = room !== value.room;
    const changedState = currentState !== value.state;
    if (changedRoom) { room = value.room; cursor = 0; $('message').value = ''; if (value.room) peerAlias = cafeAliases[Math.floor(Math.random() * cafeAliases.length)]; }
    currentState = value.state;
    $('conversation').classList.toggle('waiting', currentState === 'waiting');
    $('conversation').classList.toggle('matched', currentState === 'matched');
    if (currentState === 'waiting') startWaitingClock(); else stopWaitingClock();
    const matched = currentState === 'matched';
    if (changedState && matched) playMatchChime();
    $('message').disabled = $('send').disabled = $('sticker-toggle').disabled = !matched || busy;
    $('block').disabled = $('report').disabled = !matched || busy;
    $('report').hidden = !value.reporting;
    $('status-dot').classList.toggle('connected', matched);
    $('status').textContent = matched ? 'القعدة بدأت' : currentState === 'waiting' ? 'بندور على حد متاح…' : 'القعدة انتهت';
    $('hint').textContent = matched ? 'شخص جديد معاك. قول أهلًا ☕' : currentState === 'waiting' ? 'سيب الصفحة مفتوحة، وأول ما حد يدخل هنوصلّكم.' : 'جاهز تقابل حد تاني؟';
    $('next').disabled = busy || currentState === 'waiting';
    if (changedRoom || changedState) {
      empty(matched ? 'كل قعدة بتبدأ بأهلًا. ابدأ الكلام بطريقتك.' : currentState === 'waiting' ? 'الكرسي التاني لسه فاضي… مستنيين حد يدخل.' : 'المحادثة خلصت. تقدر تبدأ قعدة جديدة.');
    }
    for (const message of value.messages) {
      if (message.seq <= cursor) continue;
      $('messages').querySelector('.empty')?.remove();
      const nearBottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 80;
      const item = document.createElement('div'); item.className = `message ${message.mine ? 'mine' : 'peer'}`;
      const label = document.createElement('small'); label.textContent = message.mine ? 'أنت' : peerAlias;
      const stickerMatch = message.text.match(stickerToken);
      if (stickerMatch) {
        item.classList.add('sticker-message');
        const sticker = document.createElement('img'); sticker.className = 'sent-sticker'; sticker.src = stickers[stickerMatch[1]]; sticker.alt = 'ستيكر مضحك';
        item.append(label, sticker);
      } else {
        const text = document.createElement('span'); text.dir = 'auto'; text.textContent = message.text;
        item.append(label, text);
      }
      $('messages').append(item); cursor = message.seq;
      while ($('messages').children.length > 200) $('messages').firstChild.remove();
      if (nearBottom || message.mine) $('messages').scrollTop = $('messages').scrollHeight;
    }
  }
  function schedule() { clearTimeout(pollTimer); if (token) pollTimer = setTimeout(poll, 1000); }
  async function poll() {
    if (busy) return schedule();
    const version = generation;
    try {
      const result = await api(`state?after=${cursor}&room=${encodeURIComponent(room || '')}`);
      if (version !== generation) return;
      failures = 0; $('chat-error').textContent = ''; display(result);
    } catch (error) {
      if (version !== generation) return;
      if (error.message === 'session_expired') { reset(); $('gate-error').textContent = 'الاتصال انتهى. تقدر تدخل من جديد.'; return; }
      failures++;
      $('chat-error').textContent = 'الاتصال انقطع… بنحاول نرجّعه.';
      $('send').disabled = $('message').disabled = true;
    } finally { if (version === generation) schedule(); }
  }
  function reset() { stopWaitingClock(); generation++; clearTimeout(pollTimer); token = room = null; cursor = 0; currentState = 'idle'; busy = false; $('sticker-tray').hidden = true; $('conversation').hidden = true; $('gate').hidden = false; $('join').disabled = false; $('report-dialog').close(); }
  async function action(operation) {
    if (busy) return;
    busy = true; generation++; clearTimeout(pollTimer);
    $('next').disabled = $('send').disabled = $('block').disabled = $('report').disabled = true;
    try { await operation(); }
    catch (error) { $('chat-error').textContent = errors[error.message] || 'الاتصال مش مستقر. جرّب تاني.'; }
    finally { busy = false; if (token) { await poll(); } }
  }
  async function withBreakPoster(operation) {
    if (transitionBusy || busy) return;
    transitionBusy = true;
    const poster = breakPosters[Math.floor(Math.random() * breakPosters.length)];
    $('break-overlay').querySelector('img').src = poster[0];
    $('break-overlay').querySelector('figcaption').textContent = poster[1];
    $('break-overlay').hidden = false;
    try {
      await Promise.all([action(operation), new Promise(resolve => setTimeout(resolve, 2600))]);
    } finally {
      $('break-overlay').hidden = true;
      transitionBusy = false;
    }
  }
  applyTheme(document.documentElement.dataset.theme || 'light');
  $('theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('join-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !$('adult').checked || !$('rules').checked) return;
    busy = true; $('join').disabled = true; $('gate-error').textContent = '';
    try {
      if (!token) token = (await api('session', { adult: true, rules: true })).token;
      const result = await api('queue', {});
      $('gate').hidden = true; $('conversation').hidden = false;
      busy = false; display(result); schedule();
    } catch { $('gate-error').textContent = 'الشات مش متاح دلوقتي. جرّب كمان شوية.'; }
    finally { busy = false; $('join').disabled = false; }
  });
  $('next').addEventListener('click', () => withBreakPoster(async () => {
    await api('leave', {}); cursor = 0; room = null; currentState = 'idle';
    display(await api('queue', {}));
  }));
  $('end').addEventListener('click', () => withBreakPoster(async () => { await api('leave', {}); reset(); }));
  $('block').addEventListener('click', () => action(async () => { await api('block', { room }); display(await api('state')); }));
  $('sticker-toggle').addEventListener('click', () => {
    const opening = $('sticker-tray').hidden;
    $('sticker-tray').hidden = !opening;
    $('sticker-toggle').setAttribute('aria-expanded', String(opening));
  });
  $('sticker-tray').addEventListener('click', event => {
    const button = event.target.closest('[data-sticker]');
    if (!button || !room || busy || failures) return;
    const sentRoom = room, text = `[sticker:${button.dataset.sticker}]`;
    $('sticker-tray').hidden = true; $('sticker-toggle').setAttribute('aria-expanded', 'false');
    action(() => api('message', { room: sentRoom, text, id: crypto.randomUUID() }));
  });
  $('message-form').addEventListener('submit', event => {
    event.preventDefault(); const text = $('message').value.trim(); if (!text || !room || busy || failures) return;
    const sentRoom = room;
    action(async () => {
      await api('message', { room: sentRoom, text, id: crypto.randomUUID() });
      if ($('message').value.trim() === text) $('message').value = '';
    });
  });
  $('report').addEventListener('click', () => $('report-dialog').showModal());
  $('cancel-report').addEventListener('click', () => $('report-dialog').close());
  $('report-form').addEventListener('submit', event => {
    event.preventDefault(); action(async () => { await api('report', { room, reason: $('reason').value }); $('report-dialog').close(); display(await api('state')); });
  });
  window.addEventListener('pagehide', () => {
    if (token) fetch('/api/leave', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}', keepalive: true }).catch(() => {});
  });
})();
