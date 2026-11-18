(() => {
  const { $, $$, el, toast, api, download, setCsrf, rupees, dateTime, confirmBox, busy } = UI;

  const login = $('#login');
  const panel = $('#panel');
  let events = [];
  let currentTab = 'overview';
  let signedIn = false;
  let knownSections = [];
  let statementLimitMb = 5;

  // Any 401 sends the admin back to the sign in form.
  async function call(url, options) {
    try {
      return await api(url, options);
    } catch (err) {
      if (err.status === 401) showLogin(signedIn ? 'Your session has ended. Please sign in again.' : '');
      throw err;
    }
  }
  const guard = (fn) => async (...args) => {
    try { await fn(...args); } catch (err) { if (err.status !== 401) toast(err.message, 'error'); }
  };

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------
  function showLogin(message) {
    signedIn = false;
    setCsrf('');
    $$('dialog[open]').forEach((d) => d.close());
    panel.hidden = true;
    login.hidden = false;
    $('#login-error').hidden = !message;
    $('#login-error').textContent = message || '';
  }

  function showPanel(me) {
    signedIn = true;
    setCsrf(me.csrf);
    $('#who').textContent = me.username;
    login.hidden = true;
    panel.hidden = false;
    openTab(currentTab);
  }

  login.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!$('#username').value.trim() || !$('#password').value) { showLogin('Enter your username and password.'); return; }
    await busy($('#login button[type="submit"]'), 'Signing in...', async () => {
      try {
        const me = await api('/api/admin/login', { method: 'POST', body: { username: $('#username').value, password: $('#password').value } });
        $('#password').value = '';
        showPanel(me);
      } catch (err) {
        showLogin(err.message);
      }
    });
  });

  $('#logout').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    setCsrf('');
    showLogin();
  });

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------
  const loaders = {
    overview: loadOverview, registrations: loadRegistrations, reconcile: async () => {}, events: loadEvents, students: loadStudents,
    settings: loadSettings, activity: loadActivity,
  };

  function openTab(name) {
    currentTab = name;
    $$('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $$('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== name; });
    guard(loaders[name])();
  }
  $('#tabs').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-tab]');
    if (button) openTab(button.dataset.tab);
  });
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-goto]');
    if (link) openTab(link.dataset.goto);
  });

  function showState(reg) {
    const text = { open: 'Registrations open', closed: 'Registrations closed', upcoming: 'Opens soon' }[reg.state];
    const badge = $('#reg-state');
    badge.textContent = text;
    badge.className = `badge ${reg.state === 'open' ? 'approved' : reg.state === 'upcoming' ? 'pending' : 'rejected'}`;
  }

  // -------------------------------------------------------------------------
  // Overview
  // -------------------------------------------------------------------------
  async function loadOverview() {
    const o = await call('/api/admin/overview');
    events = o.events;
    showState(o.registration);
    $('#upi-warning').hidden = o.upiConfigured;
    $('#roster-text').textContent = o.roster.count === 0
      ? 'No student list has been uploaded yet. Without it, anyone can type any roll number and name. Upload the 1st year list to lock registrations to real students.'
      : `${o.roster.count} students are on the list. Only listed students can register: ${o.roster.required ? 'ON' : 'OFF'}. Email verification: ${o.roster.emailVerification ? 'ON' : o.roster.mailConfigured ? 'OFF' : 'not available (email is not set up)'}.`;
    $('#roster-card').classList.toggle('bg-orange', o.roster.count === 0 || !o.roster.required);
    $('#ro-limit').textContent = o.limits.statementMb;
    statementLimitMb = o.limits.statementMb;
    $('#st-limit').textContent = statementLimitMb;
    const scanNote = !o.scanner.configured ? 'Virus scanning is switched off (no scanner configured). Uploads are still checked and re-encoded.'
      : !o.scanner.healthy ? `The virus scanner is not responding. ${o.scanner.required ? 'Uploads are being refused until it is back.' : 'Uploads are accepted and marked "not scanned".'} It can take a few minutes to start after a restart.`
      : o.unscanned ? `${o.unscanned} registration(s) were uploaded while the scanner was unavailable. Their screenshots were still re-encoded as plain images.` : '';
    const cryptNote = o.encryption ? '' : 'Data on this server is NOT encrypted on disk, because no DATA_KEY is set. That is only acceptable on a developer machine. ';
    $('#scan-warning').textContent = cryptNote + scanNote;
    $('#scan-warning').hidden = !(cryptNote + scanNote);
    $('#pending-count').hidden = o.pending.teams === 0;
    $('#pending-count').textContent = o.pending.teams;

    const stat = (cls, label, big, line) =>
      el('div', { className: `card stat ${cls}` }, el('p', { className: 'label' }, label), el('b', {}, String(big)), el('p', {}, line));
    $('#stats').replaceChildren(
      stat('bg-orange', 'Waiting for verification', o.pending.teams, `${o.pending.participants} participants, ${rupees(o.pending.amount)} claimed`),
      stat('bg-green', 'Approved', o.approved.teams, `${o.approved.participants} participants`),
      stat('bg-yellow', 'Verified collection', rupees(o.approved.amount), 'from approved registrations'),
      stat('bg-white', 'Rejected', o.rejected.teams, `${o.rejected.participants} participants`),
    );

    $('#fill').replaceChildren(...(o.events.length ? o.events.map((ev) => {
      const taken = ev.pending + ev.approved;
      const bar = el('div', { className: 'meter' }, el('i'));
      bar.firstChild.style.width = ev.maxTeams ? `${Math.min(100, (taken / ev.maxTeams) * 100)}%` : '0%';
      return el('div', { className: 'fill-row' },
        el('div', { className: 'top' },
          el('span', {}, ev.title, ev.isOpen ? null : el('span', { className: 'badge dark' }, 'Closed')),
          el('span', {}, ev.maxTeams ? `${taken} / ${ev.maxTeams}` : `${taken} (no limit)`)),
        bar,
        el('p', { className: 'small muted' }, `${ev.approved} approved, ${ev.pending} pending, ${ev.participants} participants`));
    }) : [el('p', { className: 'muted' }, 'No events yet.')]));

    const reg = o.registration;
    $('#window-text').textContent =
      reg.state === 'open' ? `Open now${reg.closesAt ? `. Closes on ${dateTime(reg.closesAt)}` : ''}.`
        : reg.state === 'upcoming' ? `Opens on ${dateTime(reg.opensAt)}.`
        : reg.message;
  }

  const setMode = (regMode) => guard(async () => {
    const ok = await confirmBox({
      title: regMode === 'open' ? 'Open registrations?' : 'Close registrations?',
      message: regMode === 'open' ? 'Students can register right away. Any schedule is switched off.' : 'Nobody can register until you open it again. Any schedule is switched off.',
      okText: regMode === 'open' ? 'Open now' : 'Close now',
      danger: regMode === 'closed',
    });
    if (!ok) return;
    await call('/api/admin/settings', { method: 'PUT', body: { regMode } });
    toast(regMode === 'open' ? 'Registrations are open' : 'Registrations are closed');
    await loadOverview();
  });
  $('#open-now').addEventListener('click', setMode('open'));
  $('#close-now').addEventListener('click', setMode('closed'));

  // -------------------------------------------------------------------------
  // Registrations
  // -------------------------------------------------------------------------
  function filterQuery() {
    const params = new URLSearchParams();
    if ($('#f-q').value.trim()) params.set('q', $('#f-q').value.trim());
    if ($('#f-event').value) params.set('event', $('#f-event').value);
    if ($('#f-status').value) params.set('status', $('#f-status').value);
    if ($('#f-section').value) params.set('section', $('#f-section').value);
    return params;
  }

  async function ensureEvents() {
    if (!events.length) events = (await call('/api/admin/events')).events;
    const select = $('#f-event');
    const keep = select.value;
    select.replaceChildren(el('option', { value: '' }, 'All events'), ...events.map((ev) => el('option', { value: String(ev.id) }, ev.title)));
    select.value = keep;
  }

  // The section filter offers the organisers' list plus any other section that is actually in use.
  async function fillSectionFilter(registrations) {
    const select = $('#f-section');
    if (select.options.length === 1) knownSections = (await call('/api/admin/settings')).settings.sections;
    const inUse = registrations.flatMap((r) => r.members.map((m) => m.section)).filter(Boolean);
    const all = [...new Set([...knownSections, ...inUse, select.value].filter(Boolean))].sort();
    const keep = select.value;
    select.replaceChildren(el('option', { value: '' }, 'All sections'), ...all.map((x) => el('option', { value: x }, x)));
    select.value = keep;
  }

  async function loadRegistrations() {
    await ensureEvents();
    const { registrations } = await call(`/api/admin/registrations?${filterQuery()}`);
    const participants = registrations.reduce((sum, r) => sum + r.memberCount, 0);
    $('#reg-count').textContent = `${registrations.length} registration(s), ${participants} participant(s)`;
    $('#reg-empty').hidden = registrations.length > 0;
    await fillSectionFilter(registrations);
    $('#reg-rows').replaceChildren(...registrations.map((r) =>
      el('tr', { className: 'clickable', tabIndex: 0, onclick: () => openDetail(r), onkeydown: (e) => { if (e.key === 'Enter') openDetail(r); } },
        el('td', { className: 'nowrap' }, el('strong', {}, r.code), el('small', {}, dateTime(r.createdAt))),
        el('td', {}, r.eventTitle),
        el('td', {}, r.teamName, r.source === 'admin' ? el('small', {}, 'added by an organiser') : null),
        el('td', {}, r.members[0]?.name || '', el('small', {}, `${r.members[0]?.roll || ''}, ${r.leaderPhone}`)),
        el('td', {}, String(r.memberCount)),
        el('td', { className: 'nowrap' }, rupees(r.amount)),
        el('td', { className: 'mono' }, r.utr || 'none'),
        el('td', {}, el('span', { className: `badge ${r.status}` }, r.status)))));
  }

  let searchTimer;
  $('#f-q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(guard(loadRegistrations), 250); });
  $('#f-event').addEventListener('change', guard(loadRegistrations));
  $('#f-status').addEventListener('change', guard(loadRegistrations));
  $('#f-section').addEventListener('change', guard(loadRegistrations));

  $$('[data-export]').forEach((button) => button.addEventListener('click', guard(async () => {
    const params = filterQuery();
    params.set('format', button.dataset.export);
    params.set('layout', $('#x-layout').value);
    await busy(button, 'Preparing...', async () => {
      try {
        await download(`/api/admin/export?${params}`, `ideathon26.${button.dataset.export}`);
      } catch (err) {
        if (err.status === 401) showLogin('Your session has ended. Please sign in again.');
        throw err;
      }
    });
  })));

  function openDetail(r) {
    const reason = el('input', { type: 'text', id: 'reject-reason', maxLength: 200, placeholder: 'Example: transaction ID not found in the statement' });
    const decide = (status) => guard(async () => {
      await call(`/api/admin/registrations/${r.id}/decision`, { method: 'POST', body: { status, reason: reason.value } });
      toast(`${r.code} marked ${status}`);
      dialog.close();
      await loadRegistrations();
      refreshPendingCount();
    });
    const remove = guard(async () => {
      const ok = await confirmBox({ title: 'Delete registration?', message: `${r.code} (${r.teamName}) and its screenshot will be deleted for good.`, okText: 'Delete', danger: true });
      if (!ok) return;
      await call(`/api/admin/registrations/${r.id}`, { method: 'DELETE' });
      toast(`${r.code} deleted`);
      dialog.close();
      await loadRegistrations();
      refreshPendingCount();
    });

    const shotUrl = `/api/admin/registrations/${r.id}/screenshot`;
    const actions = el('div', { className: 'detail-actions' });
    if (r.status === 'pending') {
      actions.append(
        el('div', { className: 'btn-row' }, el('button', { type: 'button', className: 'btn green', onclick: decide('approved') }, 'Approve payment')),
        el('div', { className: 'field mt' }, el('label', { htmlFor: 'reject-reason' }, 'Or reject, with a reason the team will see'), reason),
        el('div', { className: 'btn-row mt' },
          el('button', { type: 'button', className: 'btn red', onclick: decide('rejected') }, 'Reject'),
          el('button', { type: 'button', className: 'linkbtn', onclick: remove }, 'Delete registration')));
    } else if (r.status === 'approved') {
      actions.append(
        el('p', { className: 'small muted' }, `Approved by ${r.decidedBy || 'admin'} on ${dateTime(r.decidedAt)}.`),
        el('div', { className: 'btn-row' },
          el('button', { type: 'button', className: 'btn white', onclick: decide('pending') }, 'Move back to pending'),
          el('button', { type: 'button', className: 'linkbtn', onclick: remove }, 'Delete registration')));
    } else {
      actions.append(
        el('p', {}, el('strong', {}, 'Rejected: '), r.rejectReason),
        el('p', { className: 'small muted' }, `By ${r.decidedBy || 'admin'} on ${dateTime(r.decidedAt)}. The team can register again; this record is kept for reference.`),
        el('button', { type: 'button', className: 'linkbtn', onclick: remove }, 'Delete registration'));
    }

    if (r.status !== 'rejected') {
      actions.prepend(el('div', { className: 'btn-row ed-open' },
        el('button', { type: 'button', className: 'btn blue', onclick: () => { dialog.close(); openTeamEditor(r); } }, 'Edit team'),
        el('span', { className: 'small muted' }, 'Add or remove members, change the leader, fix details.')));
    }

    const dialog = el('dialog', { className: 'wide' },
      el('div', { className: 'dlg-head' },
        el('h3', {}, `${r.code} `, el('span', { className: `badge ${r.status}` }, r.status)),
        el('button', { type: 'button', className: 'btn sm white', onclick: () => dialog.close() }, 'Close')),
      el('div', { className: 'dlg-body' },
        el('div', { className: 'detail-grid' },
          el('div', {},
            el('dl', { className: 'kv' },
              el('dt', {}, 'Event'), el('dd', {}, r.eventTitle),
              el('dt', {}, 'Team'), el('dd', {}, r.teamName),
              el('dt', {}, 'Amount'), el('dd', {}, `${rupees(r.amount)} for ${r.memberCount} member(s)`),
              el('dt', {}, 'Transaction ID'), el('dd', { className: 'mono' }, r.utr || 'none'),
              r.note ? [el('dt', {}, 'Note'), el('dd', {}, r.note)] : null,
              r.source === 'admin' ? [el('dt', {}, 'Added'), el('dd', {}, 'By an organiser, not through the public form')] : null,
              el('dt', {}, 'Leader'), el('dd', {}, `${r.leaderPhone}, ${r.leaderEmail}`),
              el('dt', {}, 'Registered'), el('dd', {}, dateTime(r.createdAt)),
              el('dt', {}, 'Screenshot'), el('dd', {}, !r.hasScreenshot ? 'None' : r.scanStatus === 'clean' ? 'Virus scan passed, re-encoded' : 'Not virus scanned (scanner was unavailable), re-encoded')),
            el('div', { className: 'card flat table-card' }, el('div', { className: 'table-scroll' },
              el('table', {},
                el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Name'), el('th', {}, 'Roll number'), el('th', {}, 'Branch'), el('th', {}, 'Section'), el('th', {}, 'Phone'))),
                el('tbody', {}, ...r.members.map((m, i) => el('tr', {},
                  el('td', {}, String(i + 1)), el('td', {}, m.name, i === 0 ? el('small', {}, 'Leader') : null),
                  el('td', {}, m.roll), el('td', {}, m.branch), el('td', {}, m.section || ''), el('td', {}, m.phone || '')))))))),
          el('div', {},
            el('p', { className: 'label' }, 'Payment screenshot'),
            r.hasScreenshot ? [
              el('a', { className: 'shot', href: shotUrl, target: '_blank', rel: 'noopener' }, el('img', { src: shotUrl, alt: 'Payment screenshot', onerror: (e) => e.target.replaceWith(el('p', { className: 'empty' }, 'The screenshot could not be loaded.')) })),
              el('p', { className: 'hint' }, 'Click to open full size.'),
            ] : el('p', { className: 'empty' }, 'No screenshot. This registration was added by an organiser.'))),
        actions));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  async function refreshPendingCount() {
    try {
      const o = await call('/api/admin/overview');
      $('#pending-count').hidden = o.pending.teams === 0;
      $('#pending-count').textContent = o.pending.teams;
    } catch { /* not critical */ }
  }

  // -------------------------------------------------------------------------
  // Team editor: add a registration by hand, or edit an existing team
  // -------------------------------------------------------------------------
  async function openTeamEditor(reg) {
    await ensureEvents();
    const isNew = !reg;
    const members = (reg ? reg.members : [{}]).map((m) => ({ name: m.name || '', roll: m.roll || '', branch: m.branch || '', section: m.section || '', phone: m.phone || '', listed: false }));

    const problem = el('div', { className: 'alert error', role: 'alert', hidden: true });
    const eventSelect = el('select', { id: 'ed-eventId', disabled: !isNew },
      isNew ? el('option', { value: '' }, 'Choose an event') : null,
      ...events.map((ev) => el('option', { value: String(ev.id) }, ev.title)));
    if (reg) {
      if (!events.some((ev) => ev.id === reg.eventId)) eventSelect.append(el('option', { value: String(reg.eventId) }, reg.eventTitle));
      eventSelect.value = String(reg.eventId);
    }
    const teamName = el('input', { id: 'ed-teamName', type: 'text', maxLength: 40, value: reg?.teamName || '' });
    const leaderEmail = el('input', { id: 'ed-leaderEmail', type: 'email', maxLength: 120, value: reg?.leaderEmail || '' });
    const utr = el('input', { id: 'ed-utr', type: 'text', inputMode: 'numeric', maxLength: 12, value: reg?.utr || '', placeholder: 'Leave empty if not paid by UPI' });
    const noteInput = el('input', { id: 'ed-note', type: 'text', maxLength: 160, value: reg?.note || '', placeholder: 'For example: paid cash to the coordinator' });
    const status = el('select', { id: 'ed-status' }, el('option', { value: 'approved' }, 'Approved (payment received)'), el('option', { value: 'pending' }, 'Pending (still to be verified)'));
    const list = el('div', { className: 'ed-members' });
    const summary = el('p', { className: 'ed-summary' });
    const addBtn = el('button', { type: 'button', className: 'btn white' }, 'Add a member');
    const saveBtn = el('button', { type: 'submit', className: 'btn green' }, isNew ? 'Add registration' : 'Save changes');
    const teamField = el('div', { className: 'field' }, el('label', { htmlFor: 'ed-teamName' }, 'Team name'), teamName, el('p', { className: 'err', dataset: { err: 'teamName' } }));

    const currentEvent = () => events.find((ev) => String(ev.id) === eventSelect.value) || (reg ? { teamBased: true, minMembers: 1, maxMembers: 60, fee: reg.amount / Math.max(reg.memberCount, 1), title: reg.eventTitle } : null);
    const setError = (key, message) => {
      const slot = form.querySelector(`[data-err="${key}"]`);
      if (slot) slot.textContent = message || '';
      const input = document.getElementById(`ed-${key}`);
      if (input) { if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
    };
    const clearErrors = () => {
      problem.hidden = true;
      $$('[data-err]', form).forEach((n) => { n.textContent = ''; });
      $$('[aria-invalid]', form).forEach((n) => n.removeAttribute('aria-invalid'));
    };

    function refreshSummary() {
      const ev = currentEvent();
      teamField.hidden = !!ev && !ev.teamBased;
      addBtn.hidden = !!ev && !ev.teamBased && members.length >= 1;
      if (!ev) { summary.textContent = 'Choose an event to see the team size and the amount.'; return; }
      const wanted = !ev.teamBased ? 'a solo event' : ev.minMembers === ev.maxMembers ? `needs ${ev.minMembers}` : `needs ${ev.minMembers} to ${ev.maxMembers}`;
      const outside = ev.teamBased && (members.length < ev.minMembers || members.length > ev.maxMembers);
      summary.textContent = `${members.length} member(s); ${ev.title} ${wanted}. Amount: ${members.length} x ${rupees(ev.fee)} = ${rupees(members.length * ev.fee)}.${outside ? ' Outside the usual size: you will be asked to confirm.' : ''}`;
      summary.classList.toggle('warn', outside);
    }

    // Flags a roll number that an earlier member of this team already has, as soon as it is typed.
    // With an index, returns whether that row is free of the problem.
    let repeatedRows = [];
    function markRepeated(index) {
      const firstUse = new Map();
      const found = [];
      members.forEach((m, i) => {
        const roll = m.roll.trim().toUpperCase().replace(/\s/g, '');
        if (!roll) return;
        if (firstUse.has(roll)) found.push([i, firstUse.get(roll)]);
        else firstUse.set(roll, i);
      });
      repeatedRows.filter((i) => !found.some(([row]) => row === i)).forEach((i) => setError(`m${i}-roll`, ''));
      found.forEach(([i, other]) => setError(`m${i}-roll`, `Same roll number as ${other === 0 ? 'the leader' : `member ${other + 1}`}.`));
      repeatedRows = found.map(([i]) => i);
      return index === undefined ? found.length === 0 : !repeatedRows.includes(index);
    }

    // Fills in the name, branch and phone from the student list when the roll number is on it.
    async function lookup(i) {
      const m = members[i];
      if (!m || !m.roll.trim()) return; // the row may have been removed while its field still had focus
      try {
        const r = await call('/api/admin/students/lookup', { method: 'POST', body: { rolls: [m.roll] } });
        if (members[i] !== m) return; // the row moved or was removed meanwhile
        const st = r.students[0];
        m.listed = !!st;
        if (st) {
          m.name = st.name;
          m.branch = st.branch || m.branch;
          m.section = st.section || m.section;
          if (!m.phone && st.phone) m.phone = st.phone;
          if (i === 0 && !leaderEmail.value.trim() && st.email) leaderEmail.value = st.email;
          setError(`m${i}-roll`, '');
        } else if (r.rosterRequired) {
          setError(`m${i}-roll`, 'Not on the student list. Add the student under Student list first.');
          return;
        }
        draw();
      } catch { /* the save will report it */ }
    }

    function draw() {
      list.replaceChildren(...members.map((m, i) => {
        const field = (key, label, props = {}) => {
          const input = el('input', { id: `ed-m${i}-${key}`, type: 'text', value: m[key], ...props });
          if (m.listed && (key === 'name' || key === 'branch')) { input.readOnly = true; input.classList.add('locked'); input.title = 'From the student list. Edit the student to change it.'; }
          input.addEventListener('input', () => {
            m[key] = input.value;
            setError(`m${i}-${key}`, ''); // the old message no longer describes what is typed
            if (key === 'roll') markRepeated();
          });
          if (key === 'roll') {
            input.addEventListener('change', () => {
              m.roll = input.value.trim().toUpperCase().replace(/\s/g, '');
              input.value = m.roll;
              m.listed = false;
              if (markRepeated(i)) lookup(i); // do not fill in details for a repeated roll number
            });
          }
          return el('div', { className: 'field' }, el('label', { htmlFor: input.id }, label), input, el('p', { className: 'err', dataset: { err: `m${i}-${key}` } }));
        };
        return el('div', { className: `ed-member ${i === 0 ? 'lead' : ''}` },
          el('div', { className: 'ed-head' },
            el('strong', {}, i === 0 ? 'Leader' : `Member ${i + 1}`),
            el('span', { className: 'btn-row' },
              i > 0 ? el('button', { type: 'button', className: 'btn sm white', onclick: () => { members.unshift(members.splice(i, 1)[0]); clearErrors(); draw(); } }, 'Make leader') : null,
              members.length > 1 ? el('button', { type: 'button', className: 'btn sm red', onclick: () => { members.splice(i, 1); clearErrors(); draw(); } }, 'Remove') : null)),
          el('div', { className: 'ed-fields' },
            field('roll', 'Roll number', { maxLength: 20, autocapitalize: 'characters', autocomplete: 'off' }),
            field('name', 'Name', { maxLength: 60, autocomplete: 'off' }),
            field('branch', 'Branch', { maxLength: 40, autocomplete: 'off' }),
            field('section', 'Section', { maxLength: 20, autocomplete: 'off', autocapitalize: 'characters' }),
            field('phone', i === 0 ? 'Phone' : 'Phone (optional)', { maxLength: 14, inputMode: 'numeric', autocomplete: 'off' })));
      }));
      repeatedRows = [];
      markRepeated();
      refreshSummary();
    }

    addBtn.addEventListener('click', () => {
      members.push({ name: '', roll: '', branch: '', section: '', phone: '', listed: false });
      draw();
      document.getElementById(`ed-m${members.length - 1}-roll`).focus();
    });
    eventSelect.addEventListener('change', refreshSummary);

    async function save(override) {
      clearErrors();
      const body = {
        eventId: Number(eventSelect.value), teamName: teamName.value, leaderEmail: leaderEmail.value, utr: utr.value, note: noteInput.value,
        status: status.value, override, members: members.map(({ name, roll, branch, section, phone }) => ({ name, roll, branch, section, phone })),
      };
      try {
        const r = await call(isNew ? '/api/admin/registrations' : `/api/admin/registrations/${reg.id}`, { method: isNew ? 'POST' : 'PUT', body });
        dialog.close();
        toast(isNew ? `${r.registration.code} added` : `${r.registration.code} saved`);
        if (!isNew && r.amountBefore !== r.registration.amount) {
          toast(`The amount changed from ${rupees(r.amountBefore)} to ${rupees(r.registration.amount)}. Settle the difference with the team.`, 'error');
        }
        await loadRegistrations();
        refreshPendingCount();
      } catch (err) {
        if (err.status === 401) throw err;
        if (err.data?.needsOverride) {
          const ok = await confirmBox({ title: 'Save anyway?', message: err.message, okText: 'Save anyway' });
          if (ok) await save(true);
          return;
        }
        problem.textContent = err.message;
        problem.hidden = false;
        Object.entries(err.fields || {}).forEach(([key, message]) => setError(key, message));
        const first = form.querySelector('[aria-invalid="true"]');
        (first || problem).scrollIntoView({ block: 'center' });
      }
    }

    const form = el('form', { novalidate: true },
      el('div', { className: 'dlg-head' },
        el('h3', {}, isNew ? 'Add a registration' : `Edit ${reg.code}`),
        el('button', { type: 'button', className: 'btn sm white', onclick: () => dialog.close() }, 'Close')),
      el('div', { className: 'dlg-body' },
        problem,
        isNew
          ? el('p', { className: 'small muted' }, 'This skips the captcha, the email code and the payment screenshot. The same rules about one student per event still apply.')
          : el('p', { className: 'small muted' }, 'Changes are saved together when you press Save. The team is not emailed about edits.'),
        el('div', { className: 'grid2' },
          el('div', { className: 'field' }, el('label', { htmlFor: 'ed-eventId' }, 'Event'), eventSelect, el('p', { className: 'err', dataset: { err: 'eventId' } })),
          teamField,
          el('div', { className: 'field' }, el('label', { htmlFor: 'ed-leaderEmail' }, "Leader's email"), leaderEmail, el('p', { className: 'err', dataset: { err: 'leaderEmail' } })),
          el('div', { className: 'field' }, el('label', { htmlFor: 'ed-utr' }, 'UPI transaction ID'), utr, el('p', { className: 'err', dataset: { err: 'utr' } })),
          el('div', { className: 'field' }, el('label', { htmlFor: 'ed-note' }, 'Note ', el('span', { className: 'opt' }, '(optional, organisers only)')), noteInput),
          isNew ? el('div', { className: 'field' }, el('label', { htmlFor: 'ed-status' }, 'Status'), status) : null),
        el('h3', { className: 'ed-title' }, 'Members'),
        el('p', { className: 'small muted' }, 'The first one is the team leader. Type a roll number and the details fill in from the student list.'),
        list,
        el('p', { className: 'err', dataset: { err: 'members' } }),
        el('div', { className: 'btn-row mt' }, addBtn),
        summary),
      el('div', { className: 'dlg-foot' },
        el('button', { type: 'button', className: 'btn white', onclick: () => dialog.close() }, 'Cancel'),
        saveBtn));
    form.addEventListener('submit', (e) => { e.preventDefault(); busy(saveBtn, 'Saving...', () => save(false)).catch((err) => { if (err.status !== 401) toast(err.message, 'error'); }); });
    // Enter in a field moves on instead of saving half a team.
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
      e.preventDefault();
      const inputs = $$('input:not([readonly]), select:not([disabled])', form);
      (inputs[inputs.indexOf(e.target) + 1] || saveBtn).focus();
    });

    const dialog = el('dialog', { className: 'wide editor' }, form);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    draw();
    dialog.showModal();
    // Mark which existing members come from the student list.
    if (reg) {
      try {
        const r = await call('/api/admin/students/lookup', { method: 'POST', body: { rolls: members.map((m) => m.roll) } });
        r.students.forEach((st, i) => { if (members[i]) members[i].listed = !!st; });
        draw();
      } catch { /* not critical */ }
    }
  }
  $('#reg-add').addEventListener('click', guard(() => openTeamEditor(null)));

  // -------------------------------------------------------------------------
  // One student: add, or correct after a bulk upload
  // -------------------------------------------------------------------------
  function openStudentDialog(student) {
    const isNew = !student;
    const problem = el('div', { className: 'alert error', role: 'alert', hidden: true });
    const input = (key, props = {}) => el('input', { id: `st-${key}`, type: 'text', value: student?.[key] || '', autocomplete: 'off', ...props });
    const fields = {
      roll: input('roll', { maxLength: 20, autocapitalize: 'characters', readOnly: !isNew }),
      name: input('name', { maxLength: 60 }),
      branch: input('branch', { maxLength: 40 }),
      section: input('section', { maxLength: 20, autocapitalize: 'characters' }),
      phone: input('phone', { maxLength: 14, inputMode: 'numeric' }),
      email: input('email', { type: 'email', maxLength: 120 }),
    };
    if (!isNew) fields.roll.classList.add('locked');
    const row = (key, label) => el('div', { className: 'field' }, el('label', { htmlFor: `st-${key}` }, label), fields[key], el('p', { className: 'err', dataset: { err: key } }));
    const saveBtn = el('button', { type: 'submit', className: 'btn green' }, isNew ? 'Add student' : 'Save changes');

    const form = el('form', { novalidate: true },
      el('div', { className: 'dlg-head' }, el('h3', {}, isNew ? 'Add a student' : `Edit ${student.roll}`)),
      el('div', { className: 'dlg-body settings-grid' },
        problem,
        row('roll', isNew ? 'Roll number' : 'Roll number (cannot be changed; remove and add again instead)'),
        row('name', 'Name'),
        el('div', { className: 'grid2' }, row('branch', 'Branch'), row('section', 'Section')),
        row('phone', 'Phone (optional)'),
        row('email', 'Email (needed for email verification)'),
        isNew ? null : el('p', { className: 'hint' }, 'A corrected name, branch or section is also updated in the registrations this student is in.')),
      el('div', { className: 'dlg-foot' },
        el('button', { type: 'button', className: 'btn white', onclick: () => dialog.close() }, 'Cancel'),
        saveBtn));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(saveBtn, 'Saving...', async () => {
        problem.hidden = true;
        $$('[data-err]', form).forEach((n) => { n.textContent = ''; });
        const body = Object.fromEntries(Object.entries(fields).map(([key, node]) => [key, node.value]));
        try {
          const r = isNew
            ? await call('/api/admin/students', { method: 'POST', body })
            : await call(`/api/admin/students/${encodeURIComponent(student.roll)}`, { method: 'PUT', body });
          dialog.close();
          toast(isNew ? `${r.student.roll} added` : `${r.student.roll} saved${r.registrationsUpdated ? `, and updated in ${r.registrationsUpdated} registration(s)` : ''}`);
          await loadStudents();
        } catch (err) {
          if (err.status === 401) return;
          problem.textContent = err.message;
          problem.hidden = false;
          Object.entries(err.fields || {}).forEach(([key, message]) => { const slot = form.querySelector(`[data-err="${key}"]`); if (slot) slot.textContent = message; });
        }
      });
    });

    const dialog = el('dialog', { className: 'narrow' }, form);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    (isNew ? fields.roll : fields.name).focus();
  }
  $('#ro-add').addEventListener('click', () => openStudentDialog(null));

  // -------------------------------------------------------------------------
  // Bank statement
  // -------------------------------------------------------------------------
  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  $('#st-run').addEventListener('click', guard(async () => {
    const file = $('#st-file').files[0];
    const pasted = $('#st-text').value;
    let body;
    if (file) {
      if (file.size === 0) throw new Error('That file is empty.');
      if (file.size > statementLimitMb * 1024 * 1024) throw new Error(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${statementLimitMb} MB. Export a shorter date range.`);
      const name = file.name.toLowerCase();
      if (name.endsWith('.xlsx')) body = { kind: 'xlsx', content: toBase64(await file.arrayBuffer()) };
      else if (name.endsWith('.csv') || name.endsWith('.txt')) body = { kind: 'text', content: await file.text() };
      else throw new Error('Use an .xlsx, .csv or .txt file. For a PDF or old .xls statement, copy its text and paste it instead.');
    } else if (pasted.trim()) {
      body = { kind: 'text', content: pasted };
    } else {
      throw new Error('Choose a statement file or paste the statement text.');
    }

    const button = $('#st-run');
    button.disabled = true;
    button.textContent = 'Matching...';
    try {
      renderMatches(await call('/api/admin/reconcile', { method: 'POST', body }));
    } finally {
      button.disabled = false;
      button.textContent = 'Match payments';
    }
  }));

  function renderMatches(result) {
    const rank = (r) => (r.found && r.amountOk ? 0 : r.found ? 1 : 2);
    const rows = [...result.results].sort((a, b) => rank(a) - rank(b));
    const matched = rows.filter((r) => rank(r) === 0).length;
    const check = rows.filter((r) => rank(r) === 1).length;
    $('#st-summary').textContent =
      `${result.rowsScanned} rows read, ${result.utrsInStatement} transaction IDs seen. ` +
      `${matched} match, ${check} need an amount check, ${rows.length - matched - check} not found.`;
    $('#st-result').hidden = false;
    $('#st-empty').hidden = rows.length > 0;
    $('#st-rows').replaceChildren(...rows.map((r) => {
      const k = rank(r);
      // Found rows can be approved (matches are pre-ticked); not found rows can be ticked for rejection.
      const box = el('label', { className: 'check' }, el('input', { type: 'checkbox', value: String(r.id), checked: k === 0, ariaLabel: `Select ${r.code}`, dataset: { kind: r.found ? 'approve' : 'reject' } }));
      return el('tr', {},
        el('td', {}, box),
        el('td', {}, el('span', { className: `badge ${['approved', 'pending', 'rejected'][k]}` }, ['Match', 'Check amount', 'Not found'][k])),
        el('td', { className: 'nowrap' }, el('strong', {}, r.code)),
        el('td', {}, r.teamName, el('small', {}, r.eventTitle)),
        el('td', { className: 'mono' }, r.utr),
        el('td', { className: 'nowrap' }, rupees(r.amount)),
        el('td', { className: 'line' }, r.line || 'Not in this statement'));
    }));
    $('#st-result').scrollIntoView();
  }

  $('#st-approve').addEventListener('click', guard(async () => {
    const ids = $$('#st-rows input[data-kind="approve"]:checked').map((box) => Number(box.value));
    if (!ids.length) throw new Error('Tick at least one registration marked Match or Check amount.');
    const ok = await confirmBox({ title: 'Approve payments?', message: `${ids.length} registration(s) will be marked as approved.`, okText: 'Approve' });
    if (!ok) return;
    const { approved } = await call('/api/admin/registrations/bulk-approve', { method: 'POST', body: { ids } });
    toast(`${approved} registration(s) approved`);
    $('#st-result').hidden = true;
    $('#st-file').value = '';
    $('#st-text').value = '';
    refreshPendingCount();
  }));

  $('#st-reject').addEventListener('click', guard(async () => {
    const ids = $$('#st-rows input[data-kind="reject"]:checked').map((box) => Number(box.value));
    if (!ids.length) throw new Error('Tick the "Not found" registrations you want to reject.');
    const ok = await confirmBox({
      title: 'Reject these registrations?',
      message: `${ids.length} registration(s) will be rejected because their transaction ID is not in this statement. Make sure the statement covers the dates they paid. Their roll numbers become free again, and a rejection cannot be undone.`,
      okText: 'Reject', danger: true,
    });
    if (!ok) return;
    const { rejected } = await call('/api/admin/registrations/bulk-reject', {
      method: 'POST', body: { ids, reason: 'Transaction ID not found in the bank statement. If you did pay, register again with the correct transaction ID.' },
    });
    toast(`${rejected} registration(s) rejected`);
    $$('#st-rows input[data-kind="reject"]:checked').forEach((box) => box.closest('tr').remove());
    refreshPendingCount();
  }));

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------
  async function loadEvents() {
    events = (await call('/api/admin/events')).events;
    renderEventCards();
  }

  function renderEventCards() {
    $('#ev-list').replaceChildren(...(events.length ? events.map((ev) => {
      const size = !ev.teamBased ? 'Solo' : ev.minMembers === ev.maxMembers ? `Team of ${ev.minMembers}` : `Team of ${ev.minMembers} to ${ev.maxMembers}`;
      const unit = ev.teamBased ? 'teams' : 'participants';
      return el('div', { className: 'card' },
        el('h3', {}, ev.title),
        el('p', { className: 'small' }, ev.description),
        el('div', { className: 'meta' },
          el('span', { className: `badge ${ev.isOpen ? 'approved' : 'rejected'}` }, ev.isOpen ? 'Open' : 'Closed'),
          el('span', { className: 'badge' }, size),
          el('span', { className: 'badge' }, ev.maxTeams ? `Max ${ev.maxTeams} ${unit}` : 'No limit'),
          el('span', { className: 'badge' }, `${rupees(ev.fee)} per head`)),
        el('p', { className: 'small muted' }, `${ev.approved} approved, ${ev.pending} pending, ${ev.participants} participants`),
        el('div', { className: 'btn-row' },
          el('button', { type: 'button', className: 'btn sm', onclick: () => editEvent(ev) }, 'Edit'),
          el('button', { type: 'button', className: 'btn sm white', onclick: guard(async () => {
            events = (await call(`/api/admin/events/${ev.id}`, { method: 'PUT', body: { ...ev, isOpen: !ev.isOpen } })).events;
            renderEventCards();
            toast(`${ev.title} is now ${ev.isOpen ? 'closed' : 'open'}`);
          }) }, ev.isOpen ? 'Close entries' : 'Open entries'),
          el('button', { type: 'button', className: 'linkbtn', onclick: guard(async () => {
            const has = ev.approved + ev.pending + ev.rejected > 0;
            const ok = await confirmBox({
              title: 'Remove event?',
              message: has ? `${ev.title} has registrations. It will be hidden from the site, and its registrations stay in the records.` : `${ev.title} will be deleted.`,
              okText: 'Remove', danger: true,
            });
            if (!ok) return;
            events = (await call(`/api/admin/events/${ev.id}`, { method: 'DELETE' })).events;
            renderEventCards();
          }) }, 'Remove')));
    }) : [el('p', { className: 'muted' }, 'No events yet. Add the first one.')]));
  }

  function editEvent(ev) {
    const isNew = !ev;
    const v = ev || { title: '', description: '', teamBased: true, minMembers: 5, maxMembers: 6, maxTeams: 15, fee: 50, isOpen: true, sort: events.length + 1 };
    const field = (id, label, input, hint) => el('div', { className: 'field' }, el('label', { htmlFor: id }, label), input, hint ? el('p', { className: 'hint' }, hint) : null);
    const num = (id, value, min, max) => el('input', { id, type: 'number', min: String(min), max: String(max), step: '1', value: String(value), inputMode: 'numeric' });

    const title = el('input', { id: 'e-title', type: 'text', maxLength: 60, value: v.title });
    const description = el('input', { id: 'e-desc', type: 'text', maxLength: 240, value: v.description });
    const teamBased = el('input', { id: 'e-team', type: 'checkbox', checked: v.teamBased });
    const minMembers = num('e-min', v.minMembers, 1, 50);
    const maxMembers = num('e-max', v.maxMembers, 1, 50);
    const maxTeams = num('e-cap', v.maxTeams, 0, 10000);
    const fee = num('e-fee', v.fee, 0, 100000);
    const sort = num('e-sort', v.sort, 0, 9999);
    const isOpen = el('input', { id: 'e-open', type: 'checkbox', checked: v.isOpen });
    const sizeRow = el('div', { className: 'grid2' },
      field('e-min', 'Minimum team size', minMembers), field('e-max', 'Maximum team size', maxMembers));
    const capLabel = el('span', {});
    const sync = () => {
      sizeRow.hidden = !teamBased.checked;
      capLabel.textContent = teamBased.checked ? 'Maximum number of teams' : 'Maximum number of participants';
    };
    teamBased.addEventListener('change', sync);
    sync();
    const error = el('div', { className: 'alert error', role: 'alert', hidden: true });

    const form = el('form', { novalidate: true },
      el('div', { className: 'dlg-head' }, el('h3', {}, isNew ? 'Add event' : 'Edit event')),
      el('div', { className: 'dlg-body settings-grid' },
        error,
        field('e-title', 'Title', title),
        field('e-desc', 'Short description', description),
        el('label', { className: 'check' }, teamBased, el('span', {}, 'Team event (untick for a solo event)')),
        sizeRow,
        el('div', { className: 'grid2' },
          el('div', { className: 'field' }, el('label', { htmlFor: 'e-cap' }, capLabel), maxTeams, el('p', { className: 'hint' }, '0 means no limit. Entries stop automatically when this is reached.')),
          field('e-fee', 'Fee per participant (rupees)', fee)),
        el('div', { className: 'grid2' },
          field('e-sort', 'Position in the list', sort, 'Lower numbers show first.'),
          el('label', { className: 'check' }, isOpen, el('span', {}, 'Accepting entries')))),
      el('div', { className: 'dlg-foot' },
        el('button', { type: 'button', className: 'btn white', onclick: () => dialog.close() }, 'Cancel'),
        el('button', { type: 'submit', className: 'btn' }, isNew ? 'Add event' : 'Save changes')));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        title: title.value, description: description.value, teamBased: teamBased.checked,
        minMembers: Number(minMembers.value), maxMembers: Number(maxMembers.value), maxTeams: Number(maxTeams.value),
        fee: Number(fee.value), sort: Number(sort.value), isOpen: isOpen.checked,
      };
      try {
        events = (await call(isNew ? '/api/admin/events' : `/api/admin/events/${ev.id}`, { method: isNew ? 'POST' : 'PUT', body })).events;
        dialog.close();
        renderEventCards();
        toast(isNew ? 'Event added' : 'Event saved');
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    });

    const dialog = el('dialog', {}, form);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }
  $('#ev-add').addEventListener('click', () => editEvent(null));

  // -------------------------------------------------------------------------
  // Student list
  // -------------------------------------------------------------------------
  function renderRoster(r) {
    const stat = (cls, label, big, line) =>
      el('div', { className: `card stat ${cls}` }, el('p', { className: 'label' }, label), el('b', {}, String(big)), el('p', {}, line));
    $('#ro-stats').replaceChildren(
      stat('bg-white', 'Students on the list', r.count, `${r.withSection} with a section, ${r.withPhone} with a phone, ${r.withEmail} with an email`),
      stat(r.rosterRequired ? 'bg-green' : 'bg-orange', 'Registration check', r.rosterRequired ? 'ON' : 'OFF',
        r.rosterRequired ? 'Only listed students can register' : 'Anyone can type any roll number'));
    $('#ro-required').checked = r.rosterRequired;
    $('#ro-required').disabled = r.count === 0;
    $('#ro-phone').checked = r.matchLeaderPhone;
    $('#ro-verify').checked = r.emailVerification;
    $('#ro-verify').disabled = !r.mail.configured;
    $('#ro-test').disabled = !r.mail.configured;
    $('#ro-check').disabled = !r.mail.configured;
    $('#ro-mail').textContent = r.mail.configured
      ? `Email is set up: sending as ${r.mail.from} through ${r.mail.host}. Sent today: ${r.mail.sentToday} of ${r.mail.dailyLimit}.${r.emailVerification && r.count && r.withEmail < r.count ? ` Note: ${r.count - r.withEmail} student(s) on the list have no email, so their code goes to the email they type.` : ''}`
      : 'Email is not set up. Add SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM to the .env file and restart to use email verification.';
    if (!r.students) return;
    $('#ro-empty').hidden = r.students.length > 0;
    $('#ro-more').textContent = r.students.length >= 200 ? 'Showing the first 200. Use the search box to find a student.' : '';
    $('#ro-rows').replaceChildren(...r.students.map((s) => el('tr', {},
      el('td', { className: 'nowrap' }, el('strong', {}, s.roll)), el('td', {}, s.name), el('td', {}, s.branch), el('td', {}, s.section), el('td', {}, s.phone), el('td', {}, s.email),
      el('td', { className: 'nowrap' }, el('button', { type: 'button', className: 'btn sm', onclick: () => openStudentDialog(s) }, 'Edit'), ' ', el('button', { type: 'button', className: 'btn sm white', onclick: guard(async () => {
        const ok = await confirmBox({ title: 'Remove student?', message: `${s.name} (${s.roll}) will be taken off the list and will not be able to register.`, okText: 'Remove', danger: true });
        if (!ok) return;
        await call(`/api/admin/students/${encodeURIComponent(s.roll)}`, { method: 'DELETE' });
        await loadStudents();
      }) }, 'Remove')))));
  }

  async function loadStudents() {
    renderRoster(await call(`/api/admin/students?q=${encodeURIComponent($('#ro-q').value.trim())}`));
  }
  let rosterTimer;
  $('#ro-q').addEventListener('input', () => { clearTimeout(rosterTimer); rosterTimer = setTimeout(guard(loadStudents), 250); });

  $('#ro-import').addEventListener('click', guard(async () => {
    const file = $('#ro-file').files[0];
    const pasted = $('#ro-text').value;
    const mode = $('input[name="ro-mode"]:checked').value;
    let body;
    if (file) {
      if (file.size === 0) throw new Error('That file is empty.');
      if (file.size > statementLimitMb * 1024 * 1024) throw new Error(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${statementLimitMb} MB.`);
      const name = file.name.toLowerCase();
      if (name.endsWith('.xlsx')) body = { kind: 'xlsx', content: toBase64(await file.arrayBuffer()), mode };
      else if (name.endsWith('.csv') || name.endsWith('.txt')) body = { kind: 'text', content: await file.text(), mode };
      else throw new Error('Use an .xlsx or .csv file. Old .xls files need to be saved as .xlsx first.');
    } else if (pasted.trim()) {
      body = { kind: 'text', content: pasted, mode };
    } else {
      throw new Error('Choose a file or paste the rows.');
    }
    if (mode === 'replace') {
      const ok = await confirmBox({ title: 'Replace the student list?', message: 'The current list is replaced by this file. Existing registrations are not changed.', okText: 'Replace' });
      if (!ok) return;
    }
    const out = $('#ro-result');
    await busy($('#ro-import'), 'Uploading...', async () => {
      try {
        const r = await call('/api/admin/students/import', { method: 'POST', body, timeout: 120000 });
        out.replaceChildren(el('div', { className: `alert ${r.skipped ? 'warn' : 'ok'}` },
          el('p', {}, `${r.imported} students loaded. The list now has ${r.total}.${r.skipped ? ` ${r.skipped} row(s) were skipped:` : ''}`),
          r.problems.length ? el('ul', {}, ...r.problems.map((p) => el('li', {}, p))) : null,
          !r.rosterRequired ? el('p', {}, 'Tick "Only students on this list can register" to start using it.') : null));
        $('#ro-file').value = '';
        $('#ro-text').value = '';
        await loadStudents();
      } catch (err) {
        if (err.status === 401) throw err;
        out.replaceChildren(el('div', { className: 'alert error' }, el('p', {}, err.message),
          err.data?.problems?.length ? el('ul', {}, ...err.data.problems.map((p) => el('li', {}, p))) : null));
      }
    });
  }));

  const rosterSetting = (key, input) => input.addEventListener('change', guard(async () => {
    try {
      await call('/api/admin/settings', { method: 'PUT', body: { [key]: input.checked } });
      toast('Saved');
    } finally {
      await loadStudents();
    }
  }));
  rosterSetting('rosterRequired', $('#ro-required'));
  rosterSetting('matchLeaderPhone', $('#ro-phone'));
  rosterSetting('emailVerification', $('#ro-verify'));

  $('#ro-check').addEventListener('click', guard(async () => {
    await busy($('#ro-check'), 'Checking...', async () => {
      await call('/api/admin/mail/check', { method: 'POST', timeout: 45000 });
      toast('The mail server accepted the connection and the login. Nothing was sent.');
    });
  }));

  $('#ro-test').addEventListener('click', guard(async () => {
    const to = $('#ro-test-to').value.trim();
    if (!to) throw new Error('Enter an email address to send the test to.');
    await busy($('#ro-test'), 'Sending...', async () => {
      await call('/api/admin/mail/test', { method: 'POST', body: { to }, timeout: 45000 });
      toast(`Test email sent to ${to}. Check the inbox and the Spam folder.`);
    });
    await loadStudents();
  }));

  $('#ro-clear').addEventListener('click', guard(async () => {
    const ok = await confirmBox({ title: 'Delete the whole student list?', message: 'Every student is removed and the registration check is switched off. Existing registrations are not changed.', okText: 'Delete list', danger: true });
    if (!ok) return;
    await call('/api/admin/students', { method: 'DELETE' });
    $('#ro-result').replaceChildren();
    await loadStudents();
  }));

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------
  const toLocalInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const fromLocalInput = (value) => (value ? new Date(value).toISOString() : '');
  const TEXT_SETTINGS = ['upiId', 'upiName', 'eventName', 'eventDate', 'contactName', 'contactPhone', 'notice'];

  function syncSchedule() {
    $('#schedule-fields').hidden = $('input[name="regMode"]:checked')?.value !== 'scheduled';
  }
  $$('input[name="regMode"]').forEach((radio) => radio.addEventListener('change', syncSchedule));

  function fillSettings({ settings, registration }) {
    showState(registration);
    $$('input[name="regMode"]').forEach((radio) => { radio.checked = radio.value === settings.regMode; });
    $('#opensAt').value = toLocalInput(settings.opensAt);
    $('#closesAt').value = toLocalInput(settings.closesAt);
    TEXT_SETTINGS.forEach((key) => { $(`#${key}`).value = settings[key] ?? ''; });
    $('#allowMultiEvent').checked = settings.allowMultiEvent;
    $('#branches').value = settings.branches.join('\n');
    $('#sections').value = settings.sections.join('\n');
    knownSections = settings.sections;
    syncSchedule();
  }

  async function loadSettings() {
    fillSettings(await call('/api/admin/settings'));
    await loadOrganisers();
  }

  // ----- organiser accounts -----
  async function loadOrganisers() {
    const o = await call('/api/admin/organisers');
    const row = (name, role, added, action) => el('tr', {},
      el('td', {}, el('strong', {}, name), name === o.you ? el('small', {}, 'you') : null),
      el('td', {}, role), el('td', {}, added), el('td', {}, action));
    $('#org-rows').replaceChildren(
      row(o.owner, 'Owner', 'set in the server settings', null),
      ...o.organisers.map((a) => row(a.username, 'Organiser', `${dateTime(a.createdAt)} by ${a.createdBy}`,
        o.youAreOwner ? el('button', { type: 'button', className: 'btn sm white', onclick: guard(async () => {
          const ok = await confirmBox({ title: 'Remove organiser?', message: `${a.username} is signed out at once and can no longer sign in.`, okText: 'Remove', danger: true });
          if (!ok) return;
          await call(`/api/admin/organisers/${encodeURIComponent(a.username)}`, { method: 'DELETE' });
          toast(`${a.username} removed`);
          await loadOrganisers();
        }) }, 'Remove') : null)));
    $('#org-form').hidden = !o.youAreOwner;
    $('#org-note').textContent = o.youAreOwner
      ? 'Tell the person their password privately. They can change it themselves after signing in. The owner password is set in the .env file on the server.'
      : 'Only the owner account can add or remove organisers.';
    $('#pw-card').hidden = o.youAreOwner;
  }

  $('#org-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await call('/api/admin/organisers', { method: 'POST', body: { username: $('#org-user').value, password: $('#org-pass').value } });
    toast(`Organiser ${$('#org-user').value.trim().toLowerCase()} added`);
    $('#org-user').value = '';
    $('#org-pass').value = '';
    await loadOrganisers();
  }));

  $('#pw-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await call('/api/admin/password', { method: 'POST', body: { current: $('#pw-current').value, next: $('#pw-next').value } });
    $('#pw-current').value = '';
    $('#pw-next').value = '';
    toast('Password changed');
  }));

  $('#settings').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const body = {
      regMode: $('input[name="regMode"]:checked')?.value || 'closed',
      opensAt: fromLocalInput($('#opensAt').value),
      closesAt: fromLocalInput($('#closesAt').value),
      allowMultiEvent: $('#allowMultiEvent').checked,
      branches: $('#branches').value.split('\n'),
      sections: $('#sections').value.split('\n'),
    };
    TEXT_SETTINGS.forEach((key) => { body[key] = $(`#${key}`).value; });
    fillSettings(await call('/api/admin/settings', { method: 'PUT', body }));
    toast('Settings saved');
  }));

  // -------------------------------------------------------------------------
  // Activity
  // -------------------------------------------------------------------------
  async function loadActivity() {
    const { entries } = await call('/api/admin/audit');
    $('#audit-rows').replaceChildren(...entries.map((a) =>
      el('tr', {}, el('td', { className: 'nowrap' }, dateTime(a.at)), el('td', {}, a.actor), el('td', { className: 'nowrap' }, a.action), el('td', {}, a.detail))));
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  // Another tab may have signed out, or the session may have expired: check when the tab is looked at again.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && signedIn) call('/api/admin/me').catch(() => {});
  });

  api('/api/admin/me').then(showPanel).catch((err) => showLogin(err.status === 401 ? '' : err.message));
})();
