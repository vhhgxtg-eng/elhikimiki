(() => {
  const $ = id => document.getElementById(id);
  let token = null, room = null, cursor = 0, pollTimer, busy = false, generation = 0, failures = 0;
  let currentState = 'idle';
  let waitingStarted = 0, waitingClock = null, soundEnabled = false, audioContext = null;
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
  function playCafeChime() {
    if (!soundEnabled) return;
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const now = audioContext.currentTime;
    [523.25, 659.25].forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator(); const gain = audioContext.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + index * .12); gain.gain.exponentialRampToValueAtTime(.08, now + index * .12 + .02); gain.gain.exponentialRampToValueAtTime(.0001, now + index * .12 + .32);
      oscillator.connect(gain).connect(audioContext.destination); oscillator.start(now + index * .12); oscillator.stop(now + index * .12 + .34);
    });
  }

  const errors = {
    slow_down: 'واحدة واحدة… استنى شوية وجرب تاني.',
    busy: 'القهوة زحمة دلوقتي، جرّب كمان شوية.',
    conversation_ended: 'المحادثة انتهت. اختار شخص تاني.',
    reporting_unavailable: 'الإبلاغ مش متاح حاليًا. تقدر تحظر الشخص وتنهي القعدة.',
    invalid_message: 'اكتب رسالة من حرف إلى ١٠٠٠ حرف.'
  };
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
    if (changedRoom) { room = value.room; cursor = 0; $('message').value = ''; }
    const previousState = currentState;
    currentState = value.state;
    $('conversation').classList.toggle('waiting', currentState === 'waiting');
    $('conversation').classList.toggle('matched', currentState === 'matched');
    if (currentState === 'waiting') startWaitingClock(); else stopWaitingClock();
    if (currentState === 'matched' && previousState !== 'matched') playCafeChime();
    const matched = currentState === 'matched';
    $('message').disabled = $('send').disabled = !matched || busy;
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
      const label = document.createElement('small'); label.textContent = message.mine ? 'أنت' : 'الطرف التاني';
      const text = document.createElement('span'); text.dir = 'auto'; text.textContent = message.text;
      item.append(label, text); $('messages').append(item); cursor = message.seq;
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
  function reset() { stopWaitingClock(); generation++; clearTimeout(pollTimer); token = room = null; cursor = 0; currentState = 'idle'; busy = false; $('conversation').hidden = true; $('gate').hidden = false; $('join').disabled = false; $('report-dialog').close(); }
  async function action(operation) {
    if (busy) return;
    busy = true; generation++; clearTimeout(pollTimer);
    $('next').disabled = $('send').disabled = $('block').disabled = $('report').disabled = true;
    try { await operation(); }
    catch (error) { $('chat-error').textContent = errors[error.message] || 'الاتصال مش مستقر. جرّب تاني.'; }
    finally { busy = false; if (token) { await poll(); } }
  }
  $('sound-toggle').addEventListener('click', async () => {
    soundEnabled = !soundEnabled;
    $('sound-toggle').setAttribute('aria-pressed', String(soundEnabled));
    $('sound-toggle').querySelector('span').textContent = soundEnabled ? '🔊' : '🔇';
    $('sound-toggle').setAttribute('aria-label', soundEnabled ? 'إيقاف المؤثرات الصوتية' : 'تشغيل المؤثرات الصوتية');
    if (soundEnabled) { audioContext ||= new (window.AudioContext || window.webkitAudioContext)(); await audioContext.resume(); playCafeChime(); }
  });
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
  $('next').addEventListener('click', () => action(async () => {
    await api('leave', {}); cursor = 0; room = null; currentState = 'idle';
    display(await api('queue', {}));
  }));
  $('end').addEventListener('click', () => action(async () => { await api('leave', {}); reset(); }));
  $('block').addEventListener('click', () => action(async () => { await api('block', { room }); display(await api('state')); }));
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
