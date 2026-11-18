(() => {
  const { $, $$, el, toast, api, rupees, dateTime, busy } = UI;

  const COLORS = ['bg-yellow', 'bg-pink', 'bg-blue', 'bg-green', 'bg-orange', 'bg-purple'];
  const DRAFT_KEY = 'idt26.draft';
  const TICKETS_KEY = 'idt26.tickets';
  const STATUS_TEXT = { pending: 'Payment verification pending', approved: 'Confirmed', rejected: 'Rejected' };

  const wizard = $('#wizard');
  const formError = $('#form-error');
  let info = null;        // /api/public payload
  let event = null;       // selected event
  let members = [];       // [{ name, roll, branch, phone }]
  let screenshot = '';    // data URL
  let step = 1;
  let qrAmount = 0;
  let booted = false;     // true once the first load has succeeded
  let captchaId = '';     // id of the captcha image currently shown
  let liveKeys = [];      // fields currently flagged by the live "already registered" check
  let liveSeq = 0;
  let repeatedKeys = [];  // roll fields currently flagged as repeated within the team
  let emailFromList = false; // the leader's email is supplied by the student list
  let verifyToken = '';      // proof from the server that the leader's email was verified
  let verifiedFor = '';      // which leader + email that proof belongs to

  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
    del(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } },
  };

  const teamSizeText = (ev) =>
    !ev.teamBased ? 'Solo' : ev.minMembers === ev.maxMembers ? `Team of ${ev.minMembers}` : `Team of ${ev.minMembers} to ${ev.maxMembers}`;
  const slotsLeft = (ev) => (ev.maxTeams > 0 ? Math.max(ev.maxTeams - ev.taken, 0) : null);
  const canRegister = (ev) => ev.isOpen && !ev.full;
  const blank = () => ({ name: '', roll: '', branch: '', section: '', phone: '', sectionFromList: false });

  // -------------------------------------------------------------------------
  // Page content
  // -------------------------------------------------------------------------
  function renderStatic() {
    const date = new Date(`${info.eventDate}T00:00:00`);
    if (!Number.isNaN(date.getTime())) {
      $('#hero-date').textContent = date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    }
    if (info.notice) {
      $('#notice').textContent = info.notice;
      $('#notice').hidden = false;
    }
    if (info.contactName || info.contactPhone) {
      $('#contact').textContent = `Questions? Contact ${[info.contactName, info.contactPhone].filter(Boolean).join(', ')}.`;
      $('#contact').hidden = false;
    }
    const multi = info.allowMultiEvent;
    $('#rule-step').textContent = multi ? 'One registration covers one team in one event.' : 'Each student can take part in one event, so choose well.';
    $('#rule-hint').textContent = multi
      ? 'Want to join more than one event? Finish this registration, then start another.'
      : 'Each student can take part in one event only. Check with your teammates that none of them is in another team.';
    $('#t-again').textContent = multi ? 'Register for another event' : 'Register another team';
    $('#how-team').textContent = info.emailVerification
      ? 'The team leader adds every member by roll number, then confirms their email with a code we send.'
      : "The team leader fills in every member's name, roll number and section.";
    const titles = info.events.map((ev) => ev.title);
    const run = [...titles, ...titles, ...titles, ...titles];
    $('#marquee').replaceChildren(...[...run, ...run].map((t) => el('span', {}, t)));
  }

  function renderEvents() {
    const list = $('#event-list');
    if (!info.events.length) {
      list.replaceChildren(el('p', { className: 'muted' }, 'Events will be announced soon.'));
      return;
    }
    list.replaceChildren(...info.events.map((ev, i) => {
      const left = slotsLeft(ev);
      const unit = ev.teamBased ? 'team' : 'seat';
      const meter = el('div', { className: 'meter', role: 'img', ariaLabel: left == null ? '' : `${ev.taken} of ${ev.maxTeams} ${unit}s taken` }, el('i'));
      if (left != null) meter.firstChild.style.width = `${Math.min(100, (ev.taken / ev.maxTeams) * 100)}%`;

      let action;
      if (!ev.isOpen) action = el('span', { className: 'badge dark' }, 'Closed');
      else if (ev.full) action = el('span', { className: 'badge dark' }, 'Full');
      else action = el('a', { className: 'btn sm dark', href: '#register', onclick: () => chooseEvent(ev.id) }, 'Register');

      return el('article', { className: `card event ${COLORS[i % COLORS.length]}` },
        el('span', { className: 'no', ariaHidden: 'true' }, String(i + 1).padStart(2, '0')),
        el('h3', {}, ev.title),
        el('p', {}, ev.description),
        el('div', { className: 'meta' },
          el('span', { className: 'badge' }, teamSizeText(ev)),
          el('span', { className: 'badge' }, `${rupees(ev.fee)} per head`)),
        el('div', { className: 'foot' },
          left == null
            ? el('span', { className: 'slots' }, 'Open entry')
            : el('div', {}, el('span', { className: 'slots' }, left === 0 ? `No ${unit}s left` : `${left} of ${ev.maxTeams} ${unit}s left`), meter),
          action));
    }));
  }

  // -------------------------------------------------------------------------
  // Registration window
  // -------------------------------------------------------------------------
  let countdownTimer;
  function renderWindow() {
    const reg = info.registration;
    const closed = $('#reg-closed');
    clearInterval(countdownTimer);
    if (reg.state === 'open') {
      closed.hidden = true;
      if ($('#ticket').hidden) wizard.hidden = false;
      return;
    }
    wizard.hidden = true;
    closed.hidden = false;
    $('#countdown').hidden = true;
    if (reg.state === 'upcoming') {
      $('#reg-closed-title').textContent = 'Registrations open soon';
      $('#reg-closed-text').textContent = `Opens on ${dateTime(reg.opensAt)}. Get your team and roll numbers ready.`;
      const tick = () => {
        const ms = Date.parse(reg.opensAt) - Date.now();
        if (ms <= 0) { clearInterval(countdownTimer); load(); return; }
        const s = Math.floor(ms / 1000);
        const parts = [Math.floor(s / 86400), Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, s % 60];
        $('#countdown').textContent = `${parts[0]}d ${String(parts[1]).padStart(2, '0')}h ${String(parts[2]).padStart(2, '0')}m ${String(parts[3]).padStart(2, '0')}s`;
        $('#countdown').hidden = false;
      };
      tick();
      countdownTimer = setInterval(tick, 1000);
    } else {
      $('#reg-closed-title').textContent = 'Registrations are closed';
      $('#reg-closed-text').textContent = reg.message;
    }
  }

  // -------------------------------------------------------------------------
  // Wizard
  // -------------------------------------------------------------------------
  function renderPick() {
    $('#pick').replaceChildren(...info.events.map((ev) => {
      const left = slotsLeft(ev);
      const input = el('input', { type: 'radio', name: 'event', value: String(ev.id), disabled: !canRegister(ev), checked: event?.id === ev.id });
      input.addEventListener('change', () => chooseEvent(ev.id, false));
      return el('label', { className: 'pick-item check' }, input,
        el('span', {},
          el('strong', {}, ev.title),
          ev.description,
          el('span', { className: 'meta' },
            el('span', { className: 'badge' }, teamSizeText(ev)),
            el('span', { className: 'badge' }, `${rupees(ev.fee)} per head`),
            !ev.isOpen ? el('span', { className: 'badge dark' }, 'Closed')
              : ev.full ? el('span', { className: 'badge dark' }, 'Full')
              : left != null ? el('span', { className: 'badge yellow' }, `${left} left`) : null)));
    }));
  }

  function chooseEvent(id, jump = true) {
    const ev = info.events.find((e) => e.id === id);
    if (!ev || !canRegister(ev)) return;
    event = ev;
    while (members.length < ev.minMembers) members.push(blank());
    members.length = Math.min(members.length, ev.maxMembers);
    renderPick();
    renderTeam();
    saveDraft();
    if (jump && info.registration.state === 'open' && $('#ticket').hidden) showStep(2);
  }

  function memberField(i, key, label, props = {}) {
    const id = `m${i}-${key}`;
    let input;
    const locked = info.rosterRequired && (key === 'name' || key === 'branch');
    if (key === 'branch' && !info.rosterRequired) {
      input = el('select', { id }, el('option', { value: '' }, 'Select'), ...info.branches.map((b) => el('option', { value: b }, b)));
    } else if (key === 'section') {
      const options = [...info.sections];
      if (members[i].section && !options.includes(members[i].section)) options.push(members[i].section);
      input = el('select', { id }, el('option', { value: '' }, 'Select'), ...options.map((s) => el('option', { value: s }, s)));
      if (members[i].sectionFromList) { input.disabled = true; input.classList.add('locked'); }
    } else {
      input = el('input', { id, type: 'text', ...props });
    }
    if (locked) {
      input.readOnly = true;
      input.tabIndex = -1;
      input.placeholder = 'Filled in from the roll number';
      input.classList.add('locked');
    }
    input.value = members[i][key];
    input.addEventListener('input', () => {
      members[i][key] = input.value;
      saveDraft();
      setFieldError(id, ''); // the old message no longer describes what is typed
      if (key === 'roll') markRepeatedRolls();
    });
    if (key === 'roll') {
      input.addEventListener('change', () => {
        // Show the roll number the way it will be stored: capitals, no spaces.
        members[i].roll = tidyRoll(input.value);
        input.value = members[i].roll;
        markRepeatedRolls();
        liveCheck();
      });
    }
    const err = el('p', { className: 'err' });
    err.dataset.err = id;
    return el('div', { className: 'field' }, el('label', { htmlFor: id }, ...[label].flat()), input, err);
  }

  function renderTeam() {
    if (!event) return;
    const solo = !event.teamBased;
    $('#team-title').textContent = solo ? 'Your details' : 'Your team';
    $('#team-rule').textContent = solo
      ? `${event.title} is a solo event.`
      : `${event.title} needs ${event.minMembers === event.maxMembers ? event.minMembers : `${event.minMembers} to ${event.maxMembers}`} members, including the leader. The leader is the contact person for the team.`;
    $('#team-name-field').hidden = solo;
    if (info.rosterRequired) {
      $('#team-rule').textContent += ' Type each roll number and the name is filled in from the college student list. Names are partly hidden for privacy; check that the visible letters match your teammate.';
    }

    $('#members').replaceChildren(...members.map((m, i) => {
      const removable = i > 0 && members.length > event.minMembers;
      return el('div', { className: `member ${i === 0 ? 'lead' : ''}` },
        el('div', { className: 'member-head' },
          el('strong', {}, solo ? 'Participant' : i === 0 ? 'Team leader' : `Member ${i + 1}`),
          removable && el('button', { type: 'button', className: 'btn sm red', onclick: () => { members.splice(i, 1); liveKeys = []; renderTeam(); saveDraft(); liveCheck(); } }, 'Remove')),
        el('div', { className: 'grid2' },
          memberField(i, 'roll', 'Roll number', { maxLength: 20, autocapitalize: 'characters', autocomplete: 'off' }),
          memberField(i, 'name', 'Full name', { maxLength: 60, autocomplete: i === 0 ? 'name' : 'off' }),
          memberField(i, 'branch', 'Branch'),
          memberField(i, 'section', 'Section'),
          memberField(i, 'phone', i === 0 ? 'Phone' : ['Phone ', el('span', { className: 'opt' }, '(optional)')],
            { type: 'tel', inputMode: 'numeric', maxLength: 14, autocomplete: i === 0 ? 'tel-national' : 'off', placeholder: '10 digit number' })));
    }));

    const add = $('#add-member');
    add.hidden = solo;
    add.disabled = members.length >= event.maxMembers;
    repeatedKeys = []; // the rows were rebuilt, so their messages are gone
    markRepeatedRolls();
    add.textContent = members.length >= event.maxMembers ? `Team is full (${event.maxMembers})` : `Add member (${members.length} of ${event.maxMembers})`;
    $('#total-calc').textContent = `${members.length} x ${rupees(event.fee)} =`;
    $('#total').textContent = rupees(members.length * event.fee);
  }

  const tidyRoll = (value) => String(value || '').trim().toUpperCase().replace(/\s/g, '');

  /**
   * Flags a roll number that is already used by an earlier member of this same team, the moment it
   * is typed, and clears the flag the moment it is fixed. Returns true when there are none.
   */
  function markRepeatedRolls() {
    const firstUse = new Map();
    const found = [];
    members.forEach((m, i) => {
      const roll = tidyRoll(m.roll);
      if (!roll) return;
      if (firstUse.has(roll)) found.push([`m${i}-roll`, firstUse.get(roll)]);
      else firstUse.set(roll, i);
    });
    repeatedKeys.filter((key) => !found.some(([k]) => k === key)).forEach((key) => setFieldError(key, ''));
    found.forEach(([key, other]) => setFieldError(key,
      `This is the same roll number as ${other === 0 ? 'the team leader' : `member ${other + 1}`}. Each member needs their own roll number.`));
    repeatedKeys = found.map(([key]) => key);
    return found.length === 0;
  }

  // Runs when a roll number or the team name changes: flags anyone who is already registered,
  // and a team name that is taken, right in the field instead of at the end.
  async function liveCheck() {
    if (!event || info.registration.state !== 'open') return;
    const seq = ++liveSeq;
    let fields = {};
    let students = null;
    try {
      students = (await api('/api/precheck', { method: 'POST', body: { eventId: event.id, teamName: $('#teamName').value, rolls: members.map((m) => m.roll) } })).students;
    } catch (err) {
      if (err.status !== 409) return; // connection trouble: the check runs again at Continue
      fields = err.fields || {};
      students = err.data?.students;
    }
    if (seq !== liveSeq) return; // a newer check is already on its way
    applyStudents(students);
    liveKeys.filter((key) => !(key in fields)).forEach((key) => setFieldError(key, ''));
    liveKeys = Object.keys(fields).filter((key) => key === 'teamName' || /^m\d+-roll$/.test(key));
    liveKeys.forEach((key) => setFieldError(key, fields[key]));
    markRepeatedRolls();
  }
  $('#teamName').addEventListener('change', liveCheck);

  // A section from the student list is shown and locked; without one the student picks it.
  function setSection(i, fromList) {
    const m = members[i];
    const select = $(`#m${i}-section`);
    if (fromList) {
      m.section = fromList;
      m.sectionFromList = true;
    } else if (m.sectionFromList) {
      m.section = ''; // it belonged to the previous roll number
      m.sectionFromList = false;
    }
    if (!select) return;
    if (m.section && ![...select.options].some((o) => o.value === m.section)) select.append(el('option', { value: m.section }, m.section));
    select.value = m.section;
    select.disabled = m.sectionFromList;
    select.classList.toggle('locked', m.sectionFromList);
    if (m.section) setFieldError(`m${i}-section`, '');
  }

  // With the student list on, the server tells us who each roll number belongs to.
  function applyStudents(students) {
    if (!info.rosterRequired || !Array.isArray(students)) return;
    // Leader's email: when the college has one on file it is used as is, shown masked.
    const listedEmail = students[0]?.email || '';
    const emailInput = $('#email');
    if (listedEmail) {
      emailFromList = true;
      emailInput.value = listedEmail;
      emailInput.readOnly = true;
      emailInput.classList.add('locked');
      setFieldError('email', '');
      $('#email-hint').textContent = 'This is the email the college has for the team leader. Updates about this registration go there.';
    } else if (emailFromList) {
      emailFromList = false;
      emailInput.value = '';
      emailInput.readOnly = false;
      emailInput.classList.remove('locked');
      $('#email-hint').textContent = '';
    }
    students.forEach((student, i) => {
      if (!members[i]) return;
      members[i].name = student?.name || '';
      members[i].branch = student?.branch || '';
      setSection(i, student?.section || '');
      const name = $(`#m${i}-name`);
      const branch = $(`#m${i}-branch`);
      if (name) name.value = members[i].name;
      if (branch) branch.value = members[i].branch;
      if (student) { setFieldError(`m${i}-name`, ''); setFieldError(`m${i}-branch`, ''); }
    });
    saveDraft();
  }

  $('#add-member').addEventListener('click', () => {
    if (!event || members.length >= event.maxMembers) return;
    members.push(blank());
    renderTeam();
    saveDraft();
    $(`#m${members.length - 1}-name`).focus();
  });

  async function renderPayment() {
    const amount = members.length * event.fee;
    $('#pay-amount').textContent = rupees(amount);
    if (qrAmount === amount) return;
    try {
      const pay = await api(`/api/qr?amount=${amount}`);
      $('#qr').src = pay.qr;
      $('#upi-id').textContent = pay.upiId;
      $('#upi-name').textContent = pay.payee;
      $('#upi-open').href = pay.upiLink;
      qrAmount = amount;
    } catch (err) {
      qrAmount = 0;
      $('#qr').removeAttribute('src');
      formError.replaceChildren(`Could not load the payment QR. ${err.message} `,
        el('button', { type: 'button', className: 'linkbtn', onclick: () => { formError.hidden = true; renderPayment(); } }, 'Try again'));
      formError.hidden = false;
    }
  }

  $('#upi-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#upi-id').textContent);
      toast('UPI ID copied');
    } catch {
      toast('Could not copy. Long press the UPI ID to copy it.', 'error');
    }
  });

  // Screenshots are resized in the browser, which keeps uploads small and strips photo metadata.
  async function readScreenshot(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Use a JPG, PNG or WebP image.');
    if (file.size === 0) throw new Error('That file is empty. Pick the screenshot again.');
    if (file.size > 10 * 1024 * 1024) throw new Error(`That image is ${(file.size / 1048576).toFixed(1)} MB. The limit is 10 MB.`);
    let bitmap;
    try {
      bitmap = 'createImageBitmap' in window ? await createImageBitmap(file) : await loadImage(file);
    } catch {
      throw new Error('That file could not be opened as an image. Take the screenshot again and retry.');
    }
    if (!bitmap.width || !bitmap.height) throw new Error('That image is empty. Try another one.');
    if (bitmap.width < 200 || bitmap.height < 200) throw new Error('That image is too small to read. Upload the full payment screenshot.');
    if (bitmap.width > 10000 || bitmap.height > 10000) throw new Error('That image is too big in pixels. Upload a normal screenshot.');
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = el('canvas', { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    if (!dataUrl.startsWith('data:image/jpeg') || dataUrl.length > (info?.maxScreenshotMb || 3) * 1024 * 1024 * 1.33) {
      throw new Error('That image could not be prepared. Try a smaller screenshot.');
    }
    return dataUrl;
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }

  $('#screenshot').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    setFieldError('screenshot', '');
    if (!file) return;
    try {
      screenshot = await readScreenshot(file);
      $('#shot-preview').src = screenshot;
      $('#shot-preview').hidden = false;
    } catch (err) {
      screenshot = '';
      e.target.value = '';
      $('#shot-preview').hidden = true;
      setFieldError('screenshot', err.message || 'Could not read that image. Try another one.');
    }
  });

  // ----- email verification -----
  const cleanRoll = (value) => value.trim().toUpperCase().replace(/\s/g, '');
  const leaderKey = () => `${cleanRoll(members[0].roll)}|${emailFromList ? 'list' : $('#email').value.trim().toLowerCase()}`;

  /** Opens the verification box. Resolves true once the leader's email is verified, false if it is closed. */
  function verifyEmail() {
    return new Promise((resolve) => {
      const shownEmail = $('#email').value.trim();
      const who = () => ({ roll: members[0].roll, email: emailFromList ? '' : $('#email').value });
      let captcha = '';
      let timer;
      let verified = false;

      const note = el('div', { className: 'alert error', role: 'alert', hidden: true });
      const say = (text, kind = 'error') => { note.className = `alert ${kind}`; note.textContent = text; note.hidden = !text; };

      // Stage 1: captcha, then send
      const capImg = el('img', { alt: 'Security check: an image showing five digits', width: 260, height: 90 });
      const capInput = el('input', { id: 'v-captcha', type: 'text', inputMode: 'numeric', maxLength: 5, autocomplete: 'off', placeholder: '5 digits' });
      const sendBtn = el('button', { type: 'submit', className: 'btn block' }, 'Email me the code');
      const loadCap = async () => {
        captcha = '';
        capInput.value = '';
        try {
          const c = await api('/api/captcha');
          captcha = c.id;
          capImg.src = c.image;
        } catch (err) {
          say(`Could not load the security check. ${err.message}`);
        }
      };
      const stageSend = el('form', { novalidate: true, className: 'v-stage' },
        el('p', {}, 'To confirm it is really you, we will email a 6 digit code to ', el('strong', {}, shownEmail), '.'),
        emailFromList
          ? el('p', { className: 'hint' }, 'This is the email the college has for this roll number. Not your email any more? Contact the coordinator.')
          : el('p', { className: 'hint' }, 'Wrong address? Close this box and correct it.'),
        el('div', { className: 'captcha-img' }, capImg, el('button', { type: 'button', className: 'btn sm white', onclick: () => { say(''); loadCap(); } }, 'New image')),
        el('div', { className: 'field' }, el('label', { htmlFor: 'v-captcha' }, 'Type the 5 digits you see'), capInput),
        sendBtn);

      // Stage 2: enter the code, or resend
      const codeInput = el('input', { id: 'v-code', type: 'text', inputMode: 'numeric', maxLength: 6, autocomplete: 'one-time-code', placeholder: '6 digit code' });
      const sentLine = el('p', {});
      const verifyBtn = el('button', { type: 'submit', className: 'btn green block' }, 'Verify');
      const resendBtn = el('button', { type: 'button', className: 'btn white block', disabled: true }, 'Resend code');
      const stageCode = el('form', { novalidate: true, className: 'v-stage', hidden: true },
        sentLine,
        el('div', { className: 'alert info' },
          el('strong', {}, 'No email after a minute? '),
          'Look in your Spam or Junk folder. If it is there, mark it as "Not spam" so the next emails reach your inbox.'),
        el('div', { className: 'field' }, el('label', { htmlFor: 'v-code' }, 'Enter the code from the email'), codeInput),
        verifyBtn,
        resendBtn,
        el('p', { className: 'hint' }, 'The code works for 10 minutes. Only the newest code works.'));

      const showStage = (which) => {
        stageSend.hidden = which !== 'send';
        stageCode.hidden = which !== 'code';
        (which === 'send' ? capInput : codeInput).focus();
      };
      const countdown = (seconds) => {
        clearInterval(timer);
        let left = seconds;
        const tick = () => {
          resendBtn.disabled = left > 0;
          resendBtn.textContent = left > 0 ? `Resend code in ${left}s` : 'Resend code';
          if (left <= 0) clearInterval(timer);
          left -= 1;
        };
        tick();
        timer = setInterval(tick, 1000);
      };

      const send = async (button, label) => {
        say('');
        await busy(button, label, async () => {
          try {
            const r = await api('/api/verify/send', { method: 'POST', timeout: 45000, body: { ...who(), captchaId: captcha, captchaAnswer: capInput.value.trim() } });
            captcha = '';
            sentLine.replaceChildren('We sent a code to ', el('strong', {}, r.sentTo), '.');
            codeInput.value = '';
            showStage('code');
            countdown(r.resendIn);
          } catch (err) {
            say(err.message);
            if (err.data?.captcha === 'retry') { await loadCap(); showStage('send'); }
            if (err.data?.resendIn) countdown(err.data.resendIn);
          }
        });
      };

      stageSend.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!/^\d{5}$/.test(capInput.value.trim())) { say('Type the 5 digits shown in the image.'); return; }
        send(sendBtn, 'Sending...');
      });
      resendBtn.addEventListener('click', () => send(resendBtn, 'Sending...'));
      stageCode.addEventListener('submit', async (e) => {
        e.preventDefault();
        say('');
        if (!/^\d{6}$/.test(codeInput.value.trim())) { say('Enter the 6 digit code from the email.'); return; }
        await busy(verifyBtn, 'Checking...', async () => {
          try {
            const r = await api('/api/verify/check', { method: 'POST', body: { ...who(), code: codeInput.value.trim() } });
            verifyToken = r.token;
            verifiedFor = leaderKey();
            verified = true;
            dialog.close();
            toast('Email verified');
          } catch (err) {
            say(err.message);
            codeInput.select();
            if (err.data?.expired) { await loadCap(); showStage('send'); }
          }
        });
      });

      const dialog = el('dialog', { className: 'narrow verify' },
        el('div', { className: 'dlg-head' }, el('h3', {}, 'Verify your email'),
          el('button', { type: 'button', className: 'btn sm white', onclick: () => dialog.close() }, 'Close')),
        el('div', { className: 'dlg-body' }, note, stageSend, stageCode));
      dialog.addEventListener('close', () => { clearInterval(timer); dialog.remove(); resolve(verified); });
      document.body.append(dialog);
      dialog.showModal();
      loadCap().then(() => capInput.focus());
    });
  }

  async function loadCaptcha(focus = false) {
    const img = $('#captcha-img');
    const button = $('#captcha-new');
    $('#captcha').value = '';
    captchaId = '';
    button.disabled = true;
    try {
      const c = await api('/api/captcha');
      captchaId = c.id;
      img.src = c.image;
      if (focus) $('#captcha').focus();
    } catch (err) {
      img.removeAttribute('src');
      setFieldError('captcha', `Could not load the security check. ${err.message}`);
    } finally {
      button.disabled = false;
    }
  }
  $('#captcha-new').addEventListener('click', () => { setFieldError('captcha', ''); loadCaptcha(true); });

  function renderReview() {
    const row = (term, ...value) => [el('dt', {}, term), el('dd', {}, ...value)];
    $('#review').replaceChildren(
      ...row('Event', event.title),
      ...(event.teamBased ? row('Team', $('#teamName').value.trim()) : []),
      ...row(event.teamBased ? 'Members' : 'Participant',
        el('ol', {}, ...members.map((m) => el('li', {}, `${m.name.trim()} (${[m.roll.trim().toUpperCase(), m.branch, m.section && `Section ${m.section}`].filter(Boolean).join(', ')})`)))),
      ...row('Contact', `${members[0].phone.trim()}, ${$('#email').value.trim()}`),
      ...row('Amount paid', rupees(members.length * event.fee)),
      ...row('Transaction ID', $('#utr').value.trim()),
    );
  }

  // ----- validation (the server checks everything again) -----
  function setFieldError(key, message) {
    const slot = $(`[data-err="${key}"]`);
    if (slot) slot.textContent = message;
    const input = document.getElementById(key);
    if (input) {
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  }

  function clearErrors() {
    formError.hidden = true;
    $$('[data-err]', wizard).forEach((n) => { n.textContent = ''; });
    $$('[aria-invalid]', wizard).forEach((n) => n.removeAttribute('aria-invalid'));
  }

  function stepOf(key) {
    if (key === 'event') return 1;
    if (key === 'utr' || key === 'screenshot') return 3;
    if (key.startsWith('consent') || key === 'captcha') return 4;
    return 2;
  }

  function showErrors(message, fields = {}) {
    const keys = Object.keys(fields);
    if (keys.length) showStep(Math.min(...keys.map(stepOf)), false);
    formError.textContent = message;
    formError.hidden = false;
    keys.forEach((key) => setFieldError(key, fields[key]));
    const first = keys.map((k) => document.getElementById(k)).find((n) => n && n.offsetParent !== null);
    (first || formError).scrollIntoView({ block: 'center' });
    if (first) first.focus({ preventScroll: true });
  }

  function validateStep(n) {
    const errors = {};
    if (n === 1 && !event) errors.event = 'Pick an event to continue.';
    if (n === 2) {
      if (event.teamBased && $('#teamName').value.trim().length < 2) errors.teamName = 'Enter a team name.';
      if (!emailFromList && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test($('#email').value.trim())) errors.email = 'Enter a valid email address.';
      const rolls = new Set();
      members.forEach((m, i) => {
        const roll = m.roll.trim().toUpperCase().replace(/\s/g, '');
        const phone = m.phone.replace(/[\s-]/g, '').replace(/^(\+91|0)/, '');
        if (m.name.trim().length < 2 && !info.rosterRequired) errors[`m${i}-name`] = 'Enter the full name.';
        if (!/^[A-Z0-9][A-Z0-9/-]{2,19}$/.test(roll)) errors[`m${i}-roll`] = 'Enter a valid roll number.';
        else if (rolls.has(roll)) errors[`m${i}-roll`] = 'This roll number is repeated in your team. Each member needs their own roll number.';
        rolls.add(roll);
        if (!m.branch && !info.rosterRequired) errors[`m${i}-branch`] = 'Select a branch.';
        if (!m.section) errors[`m${i}-section`] = 'Select the section.';
        if ((i === 0 || phone) && !/^[6-9]\d{9}$/.test(phone)) errors[`m${i}-phone`] = 'Enter a valid 10 digit mobile number.';
      });
    }
    if (n === 3) {
      if (!/^\d{12}$/.test($('#utr').value.trim())) errors.utr = 'Enter the 12 digit UPI transaction ID.';
      if (!screenshot) errors.screenshot = 'Attach your payment screenshot.';
    }
    if (n === 4) {
      if (!$('#consentFirstYear').checked) errors.consentFirstYear = 'Please confirm this.';
      if (!$('#consentPrivacy').checked) errors.consentPrivacy = 'You need to accept the privacy policy.';
      if (info.emailVerification) { /* the leader's email was verified instead of a captcha */ }
      else if (!captchaId) errors.captcha = 'The security check has not loaded. Press "New image".';
      else if (!/^\d{5}$/.test($('#captcha').value.trim())) errors.captcha = 'Type the 5 digits shown in the image.';
    }
    if (Object.keys(errors).length) {
      showErrors('Some details need fixing. Check the highlighted fields.', errors);
      return false;
    }
    return true;
  }

  function showStep(n, scroll = true) {
    step = n;
    $$('.step', wizard).forEach((s) => { s.hidden = Number(s.dataset.step) !== n; });
    $$('#stepper li').forEach((li, i) => {
      li.className = i + 1 < n ? 'done' : i + 1 === n ? 'now' : '';
      if (i + 1 === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    $('#back').hidden = n === 1;
    $('#next').hidden = n === 4;
    $('#submit').hidden = n !== 4;
    if (n === 3) renderPayment();
    if (n === 4) {
      renderReview();
      $('#captcha-block').hidden = info.emailVerification;
      if (!info.emailVerification && !captchaId) loadCaptcha();
    }
    if (scroll) $('#register').scrollIntoView();
  }

  // Typing in a field clears the message under it (member fields handle this themselves).
  wizard.addEventListener('input', (e) => {
    const id = e.target.id;
    if (id && !/^m\d+-/.test(id) && id !== 'screenshot') setFieldError(id, '');
  });

  $('#next').addEventListener('click', async () => {
    clearErrors();
    if (step === 2 && info.rosterRequired) await liveCheck(); // make sure names are filled in before checking
    if (!validateStep(step)) return;
    if (step !== 2) { showStep(step + 1); return; }
    // Before anyone pays: make sure the team name is free and no member is already in another team or event.
    await busy($('#next'), 'Checking team...', async () => {
      try {
        const check = await api('/api/precheck', {
          method: 'POST',
          body: { eventId: event.id, teamName: $('#teamName').value, rolls: members.map((m) => m.roll) },
        });
        applyStudents(check.students);
        if (info.emailVerification && verifiedFor !== leaderKey()) {
          if (!(await verifyEmail())) return; // closed without verifying: stay on this step
        }
        showStep(3);
      } catch (err) {
        applyStudents(err.data?.students);
        showErrors(err.status === 0 ? `${err.message} We need to check your team before you pay.` : err.message, err.fields);
        if ([400, 403].includes(err.status) || err.fields?.event) load(false);
      }
    });
  });
  $('#back').addEventListener('click', () => { clearErrors(); showStep(step - 1); });

  // Enter inside a field must not submit the whole form from an early step. It behaves like
  // "next field" instead, and on the last field of a step it moves to the Continue button.
  // (Leaving the roll number field this way also runs the "already registered" check.)
  wizard.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || step === 4) return;
    const field = e.target;
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) return;
    if (['checkbox', 'radio', 'file', 'button', 'submit'].includes(field.type)) return;
    e.preventDefault();
    const current = $(`.step[data-step="${step}"]`, wizard);
    const fields = $$('input, select', current).filter((n) => !n.readOnly && !n.disabled && n.type !== 'file' && n.offsetParent !== null);
    const next = fields[fields.indexOf(field) + 1];
    (next || $('#next')).focus();
  });

  wizard.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (step !== 4) return; // only the last step may submit, whatever triggered it
    clearErrors();
    for (const n of [1, 2, 3, 4]) if (!validateStep(n)) return;

    await busy($('#submit'), 'Submitting...', async () => {
    try {
      const result = await api('/api/register', {
        method: 'POST',
        timeout: 90000,
        body: {
          eventId: event.id,
          teamName: $('#teamName').value,
          email: $('#email').value,
          members,
          utr: $('#utr').value,
          screenshot,
          consentPrivacy: $('#consentPrivacy').checked,
          consentFirstYear: $('#consentFirstYear').checked,
          captchaId,
          captchaAnswer: $('#captcha').value.trim(),
          verifyToken,
        },
      });
      captchaId = '';
      const phone = members[0].phone.replace(/[\s-]/g, '').replace(/^(\+91|0)/, '');
      store.set(TICKETS_KEY, [{ code: result.code, phone, label: `${result.eventTitle}: ${result.teamName}` }, ...store.get(TICKETS_KEY, [])].slice(0, 10));
      store.del(DRAFT_KEY);
      showTicket(result);
      renderSaved();
      load(false); // refresh slot counts
    } catch (err) {
      const retryable = err.status === 0 || err.status >= 500;
      showErrors(retryable
        ? `${err.message} Your details are still here. It is safe to press Submit again; you will not be registered twice.`
        : err.message, err.fields);
      if ([400, 403, 409].includes(err.status)) load(false);
      // A captcha works for one attempt only, so every failed submit gets a fresh image.
      const captchaError = err.fields?.captcha;
      if (!info.emailVerification) await loadCaptcha();
      if (captchaError) setFieldError('captcha', captchaError);
      if (err.data?.verify === 'required') { verifyToken = ''; verifiedFor = ''; } // Continue on the team step verifies again
    }
    });
  });

  function showTicket(t) {
    $('#t-code').textContent = t.code;
    const rows = [['Event', t.eventTitle], [t.teamBased ? 'Team' : 'Participant', t.teamName], ['Members', t.memberCount], ['Amount', rupees(t.amount)]];
    $('#t-rows').replaceChildren(...rows.flatMap(([k, v]) => [el('span', {}, k), el('span', {}, String(v))]));
    wizard.hidden = true;
    const ticket = $('#ticket');
    ticket.hidden = false;
    ticket.scrollIntoView({ block: 'center' });
    ticket.focus({ preventScroll: true });
  }

  $('#t-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#t-code').textContent); toast('Registration ID copied'); }
    catch { toast('Could not copy. Please write the ID down.', 'error'); }
  });

  $('#t-again').addEventListener('click', () => {
    // Keep the people, clear the event, payment and consent.
    event = null;
    screenshot = '';
    qrAmount = 0;
    $('#utr').value = '';
    $('#screenshot').value = '';
    $('#shot-preview').hidden = true;
    $('#consentPrivacy').checked = false;
    $('#consentFirstYear').checked = false;
    captchaId = '';
    verifyToken = '';
    verifiedFor = '';
    $('#captcha').value = '';
    $('#ticket').hidden = true;
    renderPick();
    renderWindow();
    showStep(1);
  });

  // ----- draft: text fields survive a refresh, the screenshot does not -----
  let draftTimer;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      store.set(DRAFT_KEY, { eventId: event?.id ?? null, teamName: $('#teamName').value, email: emailFromList ? '' : $('#email').value, members, utr: $('#utr').value });
    }, 300);
  }
  ['#teamName', '#email', '#utr'].forEach((sel) => $(sel).addEventListener('input', saveDraft));

  function restoreDraft() {
    const draft = store.get(DRAFT_KEY, null);
    if (!draft) return;
    $('#teamName').value = draft.teamName || '';
    $('#email').value = draft.email || '';
    $('#utr').value = draft.utr || '';
    if (Array.isArray(draft.members)) {
      members = draft.members.slice(0, 50).map((m) => ({
        name: String(m?.name || ''), roll: String(m?.roll || ''), phone: String(m?.phone || ''),
        branch: info.branches.includes(m?.branch) ? m.branch : '',
        section: info.sections.includes(m?.section) ? m.section : '', sectionFromList: false,
      }));
    }
    const ev = info.events.find((e) => e.id === draft.eventId);
    if (ev && canRegister(ev)) chooseEvent(ev.id, false);
  }

  // -------------------------------------------------------------------------
  // Status check
  // -------------------------------------------------------------------------
  function renderSaved() {
    const tickets = store.get(TICKETS_KEY, []);
    const box = $('#saved');
    box.hidden = !tickets.length;
    box.replaceChildren(
      el('span', { className: 'label' }, 'Registered from this device:'),
      ...tickets.map((t) => el('button', { type: 'button', className: 'btn sm white', onclick: () => {
        $('#s-code').value = t.code;
        $('#s-phone').value = t.phone;
        checkStatus();
      } }, t.label || t.code)));
  }

  async function checkStatus() {
    const out = $('#status-result');
    const code = $('#s-code').value.trim().toUpperCase();
    const phone = $('#s-phone').value.replace(/[\s-]/g, '').replace(/^(\+91|0)/, '');
    if (!/^IDT26-[A-Z0-9]{6}$/.test(code)) {
      out.replaceChildren(el('div', { className: 'alert error' }, 'Enter the registration ID exactly as shown on your ticket, for example IDT26-K7M2QX.'));
      return;
    }
    if (!/^[6-9]\d{9}$/.test(phone)) {
      out.replaceChildren(el('div', { className: 'alert error' }, "Enter the team leader's 10 digit phone number."));
      return;
    }
    await busy($('#s-submit'), 'Checking...', async () => {
    try {
      const s = await api('/api/status', { method: 'POST', body: { code, phone } });
      const tone = { pending: 'warn', approved: 'ok', rejected: 'error' }[s.status];
      const note = {
        pending: 'The organisers have not verified your payment yet. Check again later.',
        approved: 'You are in. Show this registration ID at the venue on the event day.',
        rejected: `Reason: ${s.rejectReason || 'not given'}. You can register again with the correct details.`,
      }[s.status];
      out.replaceChildren(el('div', { className: `alert ${tone}` },
        el('p', {}, el('span', { className: `badge ${s.status}` }, STATUS_TEXT[s.status])),
        el('p', {}, el('strong', {}, `${s.code}: ${s.eventTitle}`), `, ${s.teamName}, ${s.memberCount} member(s), ${rupees(s.amount)}`),
        el('p', {}, note),
        el('p', { className: 'small' }, `Registered on ${dateTime(s.createdAt)}`)));
    } catch (err) {
      out.replaceChildren(el('div', { className: 'alert error' }, err.message));
    }
    });
  }
  $('#status-form').addEventListener('submit', (e) => { e.preventDefault(); checkStatus(); });

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  async function load(first = true) {
    try {
      info = await api('/api/public');
    } catch (err) {
      if (!info) {
        $('#event-list').replaceChildren(el('p', { className: 'muted' }, 'Events could not be loaded.'));
        $('#load-error-text').textContent = err.message;
        $('#load-error').hidden = false;
      }
      return;
    }
    $('#load-error').hidden = true;
    let lostEvent = '';
    if (event) {
      const fresh = info.events.find((e) => e.id === event.id);
      if (fresh && canRegister(fresh)) {
        event = fresh;
      } else {
        // The chosen event was closed, filled up or removed while the form was open.
        lostEvent = event.title;
        event = null;
      }
    }
    renderStatic();
    renderEvents();
    renderPick();
    if (first) {
      booted = true;
      restoreDraft();
      renderSaved();
      showStep(1, false);
    } else if (event) {
      // Team size limits may have been changed by the organisers.
      while (members.length < event.minMembers) members.push(blank());
      members.length = Math.min(members.length, event.maxMembers);
      renderTeam();
    }
    renderWindow();
    if (lostEvent && !wizard.hidden) {
      showStep(1, false);
      showErrors(`${lostEvent} is no longer taking entries. Pick another event.`);
    }
  }

  $('#load-retry').addEventListener('click', (e) => busy(e.currentTarget, 'Loading...', () => load(!booted)));

  // Slots fill up while the page is open: refresh when the tab is looked at again.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && booted) load(false); });

  load();
})();
