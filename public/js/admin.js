(() => {
  const { $, $$, el, toast, api, download, setCsrf, rupees, dateTime, confirmBox, busy } = UI;

  const login = $('#login');
  const panel = $('#panel');
  let events = [];
  let currentTab = 'overview';
  let signedIn = false;
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
    statementLimitMb = o.limits.statementMb;
    $('#st-limit').textContent = statementLimitMb;
    const scanNote = !o.scanner.configured ? 'Virus scanning is switched off (no scanner configured). Uploads are still checked and re-encoded.'
      : !o.scanner.healthy ? `The virus scanner is not responding. ${o.scanner.required ? 'Uploads are being refused until it is back.' : 'Uploads are accepted and marked "not scanned".'} It can take a few minutes to start after a restart.`
      : o.unscanned ? `${o.unscanned} registration(s) were uploaded while the scanner was unavailable. Their screenshots were still re-encoded as plain images.` : '';
    $('#scan-warning').textContent = scanNote;
    $('#scan-warning').hidden = !scanNote;
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
    return params;
  }

  async function ensureEvents() {
    if (!events.length) events = (await call('/api/admin/events')).events;
    const select = $('#f-event');
    const keep = select.value;
    select.replaceChildren(el('option', { value: '' }, 'All events'), ...events.map((ev) => el('option', { value: String(ev.id) }, ev.title)));
    select.value = keep;
  }

  async function loadRegistrations() {
    await ensureEvents();
    const { registrations } = await call(`/api/admin/registrations?${filterQuery()}`);
    const participants = registrations.reduce((sum, r) => sum + r.memberCount, 0);
    $('#reg-count').textContent = `${registrations.length} registration(s), ${participants} participant(s)`;
    $('#reg-empty').hidden = registrations.length > 0;
    $('#reg-rows').replaceChildren(...registrations.map((r) =>
      el('tr', { className: 'clickable', tabIndex: 0, onclick: () => openDetail(r), onkeydown: (e) => { if (e.key === 'Enter') openDetail(r); } },
        el('td', { className: 'nowrap' }, el('strong', {}, r.code), el('small', {}, dateTime(r.createdAt))),
        el('td', {}, r.eventTitle),
        el('td', {}, r.teamName),
        el('td', {}, r.members[0]?.name || '', el('small', {}, `${r.members[0]?.roll || ''}, ${r.leaderPhone}`)),
        el('td', {}, String(r.memberCount)),
        el('td', { className: 'nowrap' }, rupees(r.amount)),
        el('td', { className: 'mono' }, r.utr),
        el('td', {}, el('span', { className: `badge ${r.status}` }, r.status)))));
  }

  let searchTimer;
  $('#f-q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(guard(loadRegistrations), 250); });
  $('#f-event').addEventListener('change', guard(loadRegistrations));
  $('#f-status').addEventListener('change', guard(loadRegistrations));

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
              el('dt', {}, 'Transaction ID'), el('dd', { className: 'mono' }, r.utr),
              el('dt', {}, 'Leader'), el('dd', {}, `${r.leaderPhone}, ${r.leaderEmail}`),
              el('dt', {}, 'Registered'), el('dd', {}, dateTime(r.createdAt)),
              el('dt', {}, 'Screenshot'), el('dd', {}, r.scanStatus === 'clean' ? 'Virus scan passed, re-encoded' : 'Not virus scanned (scanner was unavailable), re-encoded')),
            el('div', { className: 'card flat table-card' }, el('div', { className: 'table-scroll' },
              el('table', {},
                el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Name'), el('th', {}, 'Roll number'), el('th', {}, 'Branch'), el('th', {}, 'Phone'))),
                el('tbody', {}, ...r.members.map((m, i) => el('tr', {},
                  el('td', {}, String(i + 1)), el('td', {}, m.name, i === 0 ? el('small', {}, 'Leader') : null),
                  el('td', {}, m.roll), el('td', {}, m.branch), el('td', {}, m.phone || '')))))))),
          el('div', {},
            el('p', { className: 'label' }, 'Payment screenshot'),
            el('a', { className: 'shot', href: shotUrl, target: '_blank', rel: 'noopener' }, el('img', { src: shotUrl, alt: 'Payment screenshot', onerror: (e) => e.target.replaceWith(el('p', { className: 'empty' }, 'The screenshot could not be loaded.')) })),
            el('p', { className: 'hint' }, 'Click to open full size.'))),
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
      stat('bg-white', 'Students on the list', r.count, `${r.withPhone} with a phone, ${r.withEmail} with an email`),
      stat(r.rosterRequired ? 'bg-green' : 'bg-orange', 'Registration check', r.rosterRequired ? 'ON' : 'OFF',
        r.rosterRequired ? 'Only listed students can register' : 'Anyone can type any roll number'));
    $('#ro-required').checked = r.rosterRequired;
    $('#ro-required').disabled = r.count === 0;
    $('#ro-phone').checked = r.matchLeaderPhone;
    $('#ro-verify').checked = r.emailVerification;
    $('#ro-verify').disabled = !r.mail.configured;
    $('#ro-test').disabled = !r.mail.configured;
    $('#ro-mail').textContent = r.mail.configured
      ? `Email is set up: sending as ${r.mail.from} through ${r.mail.host}. Sent today: ${r.mail.sentToday} of ${r.mail.dailyLimit}.${r.emailVerification && r.count && r.withEmail < r.count ? ` Note: ${r.count - r.withEmail} student(s) on the list have no email, so their code goes to the email they type.` : ''}`
      : 'Email is not set up. Add SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM to the .env file and restart to use email verification.';
    if (!r.students) return;
    $('#ro-empty').hidden = r.students.length > 0;
    $('#ro-more').textContent = r.students.length >= 200 ? 'Showing the first 200. Use the search box to find a student.' : '';
    $('#ro-rows').replaceChildren(...r.students.map((s) => el('tr', {},
      el('td', { className: 'nowrap' }, el('strong', {}, s.roll)), el('td', {}, s.name), el('td', {}, s.branch), el('td', {}, s.phone), el('td', {}, s.email),
      el('td', {}, el('button', { type: 'button', className: 'btn sm white', onclick: guard(async () => {
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
    syncSchedule();
  }

  async function loadSettings() {
    fillSettings(await call('/api/admin/settings'));
  }

  $('#settings').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const body = {
      regMode: $('input[name="regMode"]:checked')?.value || 'closed',
      opensAt: fromLocalInput($('#opensAt').value),
      closesAt: fromLocalInput($('#closesAt').value),
      allowMultiEvent: $('#allowMultiEvent').checked,
      branches: $('#branches').value.split('\n'),
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
