(() => {
  const config = window.CONTEST_SUPABASE_CONFIG;
  if (!config?.url || !config.publishableKey || !window.supabase?.createClient) return;

  const client = window.supabase.createClient(config.url, config.publishableKey);
  const app = document.querySelector('#app');
  const judgeTokenStorageKey = `jury-vote-issued-links:${config.url}`;
  const loadIssuedTokens = () => {
    try { return new Map(Object.entries(JSON.parse(sessionStorage.getItem(judgeTokenStorageKey) || '{}'))); }
    catch { return new Map(); }
  };
  const cloud = {
    mode: 'starting',
    user: null,
    organization: null,
    competitions: [],
    competitionId: null,
    knownJudgeIds: new Set(),
    issuedJudgeTokens: loadIssuedTokens(),
    savedSetup: '',
    saveQueue: Promise.resolve(),
    channel: null,
    savedJudgeScores: new Map(),
  };
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const showMessage = (message) => {
    let toast = document.querySelector('#cloud-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'cloud-toast';
      toast.className = 'toast';
      toast.setAttribute('role', 'status');
      document.body.append(toast);
    }
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(cloud.toastTimer);
    cloud.toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
  };
  const persistIssuedTokens = () => {
    try { sessionStorage.setItem(judgeTokenStorageKey, JSON.stringify(Object.fromEntries(cloud.issuedJudgeTokens))); }
    catch { showMessage('Скопируйте ссылку сейчас: браузер не разрешил временное хранение.'); }
  };
  const isJudgeRoute = () => new URLSearchParams(location.hash.slice(1)).has('judge');
  const isPlatformAdminRoute = () => location.pathname.replace(/\/$/, '').endsWith('/admin') || new URLSearchParams(location.hash.slice(1)).has('admin') || new URLSearchParams(location.search).has('admin');
  const judgeToken = () => new URLSearchParams(location.hash.slice(1)).get('judge');
  const makeToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const handleError = (error, fallback = 'Не удалось выполнить запрос') => {
    if (error) {
      console.error(error);
      showMessage(fallback);
      return true;
    }
    return false;
  };

  function authView(message = '') {
    cloud.mode = 'auth';
    app.innerHTML = `<main class="judge-shell"><header class="judge-top"><div class="judge-logo"><span class="brand-mark">Ж</span><span>ЖЮРИ / CONTEST</span></div><small>ОБЛАЧНАЯ ВЕРСИЯ</small></header><section class="judge-heading"><p class="eyebrow">Рабочее пространство</p><h1>Вход организатора</h1><p>Войдите или создайте аккаунт, чтобы управлять конкурсами.</p></section><section class="panel" style="max-width:480px"><div class="panel-body"><form id="cloud-auth-form" class="form-grid"><div class="field full"><label for="cloud-email">Электронная почта</label><input id="cloud-email" name="email" type="email" autocomplete="email" required></div><div class="field full"><label for="cloud-password">Пароль</label><input id="cloud-password" name="password" type="password" autocomplete="current-password" minlength="8" required></div><div class="field full"><p class="form-hint" id="cloud-auth-message">${escapeHtml(message)}</p></div><div class="field full" style="display:flex;gap:8px;flex-wrap:wrap"><button class="button" type="submit" data-auth-mode="sign-in">Войти</button><button class="button secondary" type="submit" data-auth-mode="sign-up">Создать аккаунт</button></div></form></div></section></main>`;
  }

  function organizationView(message = '') {
    cloud.mode = 'organization';
    app.innerHTML = `<main class="judge-shell"><header class="judge-top"><div class="judge-logo"><span class="brand-mark">Ж</span><span>ЖЮРИ / CONTEST</span></div><button class="button secondary small" type="button" data-cloud-action="sign-out">Выйти</button></header><section class="judge-heading"><p class="eyebrow">Первый запуск</p><h1>Создайте организацию</h1><p>В организации будут храниться ваши конкурсы и команда.</p></section><section class="panel" style="max-width:480px"><div class="panel-body"><form id="organization-form" class="form-grid"><div class="field full"><label for="organization-name">Название организации</label><input id="organization-name" name="name" maxlength="120" placeholder="Например, Студия моделей" required></div><div class="field full"><p class="form-hint">${escapeHtml(message)}</p></div><div class="field full"><button class="button" type="submit">Создать организацию</button></div></form></div></section></main>`;
  }

  function firstCompetitionView(message = '') {
    cloud.mode = 'competition-setup';
    app.innerHTML = `<main class="judge-shell"><header class="judge-top"><div class="judge-logo"><span class="brand-mark">Ж</span><span>ЖЮРИ / CONTEST</span></div><button class="button secondary small" type="button" data-cloud-action="sign-out">Выйти</button></header><section class="judge-heading"><p class="eyebrow">${escapeHtml(cloud.organization?.name || 'Организация')}</p><h1>Создайте конкурс</h1><p>Добавьте первый конкурс, затем настройте участниц, категории и жюри.</p></section><section class="panel" style="max-width:480px"><div class="panel-body"><form id="new-competition-form" class="form-grid"><div class="field full"><label for="new-competition-title">Название конкурса</label><input id="new-competition-title" name="title" maxlength="160" placeholder="Конкурс моделей 2026" required></div><div class="field full"><p class="form-hint">${escapeHtml(message)}</p></div><div class="field full"><button class="button" type="submit">Создать конкурс</button></div></form></div></section></main>`;
  }

  async function start() {
    if (isJudgeRoute()) {
      await loadJudge(judgeToken());
      return;
    }
    const { data: { session }, error } = await client.auth.getSession();
    if (error) { authView('Не удалось проверить сессию. Обновите страницу.'); return; }
    cloud.user = session?.user || null;
    if (!cloud.user) { authView(); return; }
    if (isPlatformAdminRoute()) { await loadPlatformAdmin(); return; }
    await loadOrganization();
  }

  async function callPlatformAdmin(action, payload = {}) {
    const { data: { session } } = await client.auth.getSession();
    if (!session?.access_token) throw new Error('Сессия завершилась. Войдите снова.');
    const response = await fetch(`${config.url}/functions/v1/account-admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.publishableKey, Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ action, ...payload }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Не удалось выполнить запрос администратора.');
    return result;
  }

  async function loadPlatformAdmin(message = '') {
    cloud.mode = 'platform-admin-loading';
    app.innerHTML = '<main class="judge-shell"><p>Загрузка панели администратора…</p></main>';
    try {
      const { users } = await callPlatformAdmin('list');
      cloud.mode = 'platform-admin';
      app.innerHTML = `<main class="judge-shell" style="max-width:1100px"><header class="judge-top"><div class="judge-logo"><span class="brand-mark">Ж</span><span>ЖЮРИ / ПЛАТФОРМА</span></div><div style="display:flex;gap:8px"><a class="button secondary small" href="${escapeHtml(location.pathname)}">К конкурсам</a><button class="button secondary small" type="button" data-cloud-action="sign-out">Выйти</button></div></header><section class="judge-heading"><p class="eyebrow">Платформенное управление</p><h1>Аккаунты</h1><p>Блокировка запрещает доступ к рабочим данным. Удаление аккаунта необратимо удалит его организации и конкурсы.</p></section>${message ? `<p class="form-hint" role="status">${escapeHtml(message)}</p>` : ''}<section class="panel"><div class="panel-body"><div class="table-wrap"><table><thead><tr><th>Пользователь</th><th>Дата регистрации</th><th>Организации</th><th>Конкурсы</th><th>Статус</th><th>Действия</th></tr></thead><tbody>${users.map((user) => `<tr><td>${escapeHtml(user.email || 'Без email')}</td><td>${user.created_at ? new Date(user.created_at).toLocaleDateString('ru-RU') : '—'}</td><td>${user.organization_count}</td><td>${user.competition_count}</td><td><span class="badge ${user.status === 'blocked' ? 'pending' : ''}">${user.status === 'blocked' ? 'Заблокирован' : 'Активен'}</span></td><td><div class="row-actions">${user.id === cloud.user.id ? '<span class="form-hint">Вы</span>' : `<button class="button secondary small" data-admin-action="${user.status === 'blocked' ? 'unblock' : 'block'}" data-user-id="${user.id}">${user.status === 'blocked' ? 'Разблокировать' : 'Заблокировать'}</button><button class="button danger small" data-admin-action="delete" data-user-id="${user.id}">Удалить</button>`}</div></td></tr>`).join('') || '<tr><td colspan="6" class="empty">Аккаунтов пока нет</td></tr>'}</tbody></table></div></div></section></main>`;
    } catch (error) {
      if (/administrator|admin access|not authorized/i.test(error.message)) {
        cloud.mode = 'platform-admin-denied';
        app.innerHTML = `<main class="judge-shell"><header class="judge-top"><div class="judge-logo"><span class="brand-mark">Ж</span><span>ЖЮРИ / CONTEST</span></div><button class="button secondary small" data-cloud-action="sign-out">Выйти</button></header><section class="not-found"><h1>Нет доступа</h1><p>Эта учётная запись не назначена администратором платформы.</p><a class="button secondary" href="${escapeHtml(location.pathname)}">Перейти к конкурсам</a></section></main>`;
      } else authView(error.message);
    }
  }

  app.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-admin-action]');
    if (!button || cloud.mode !== 'platform-admin') return;
    const id = button.dataset.userId;
    try {
      if (button.dataset.adminAction === 'block') {
        const reason = prompt('Причина блокировки (необязательно):') || '';
        if (!confirm('Заблокировать аккаунт? Доступ к организациям и конкурсам будет закрыт.')) return;
        await callPlatformAdmin('block', { user_id: id, reason });
      } else if (button.dataset.adminAction === 'unblock') {
        if (!confirm('Восстановить доступ этому аккаунту?')) return;
        await callPlatformAdmin('unblock', { user_id: id });
      } else {
        const preview = await callPlatformAdmin('preview_delete', { user_id: id });
        if (!confirm(`Удалить аккаунт ${preview.email || ''}? Будут удалены ${preview.organization_count} организаций, ${preview.competition_count} конкурсов и связанные данные. Это действие нельзя отменить.`)) return;
        await callPlatformAdmin('delete', { user_id: id });
      }
      await loadPlatformAdmin('Изменения сохранены.');
    } catch (error) { showMessage(error.message); }
  });

  async function loadOrganization() {
    try { cloud.platformAdmin = Boolean((await callPlatformAdmin('is_admin')).is_admin); }
    catch { cloud.platformAdmin = false; }
    const { data, error } = await client.from('organization_members').select('organization_id, role').eq('user_id', cloud.user.id);
    if (error) { authView('Не удалось загрузить организацию. Проверьте, что миграция базы уже применена.'); return; }
    if (!data?.length) { organizationView(); return; }
    const { data: organizations, error: organizationError } = await client.from('organizations').select('id, name').in('id', data.map((row) => row.organization_id));
    if (organizationError || !organizations?.length) { organizationView('Не удалось найти организацию.'); return; }
    cloud.organization = organizations[0];
    const { data: competitions, error: competitionsError } = await client.from('competitions').select('id, title, status, created_at').eq('organization_id', cloud.organization.id).order('created_at', { ascending: true });
    if (competitionsError) { organizationView('Не удалось загрузить конкурсы. Проверьте миграцию и политики доступа.'); return; }
    cloud.competitions = competitions || [];
    if (!cloud.competitions.length) { firstCompetitionView(); return; }
    const requestedId = new URLSearchParams(location.hash.slice(1)).get('competition');
    const selectedId = cloud.competitions.some((item) => item.id === requestedId) ? requestedId : cloud.competitions.at(-1).id;
    await loadCompetition(selectedId);
  }

  async function loadCompetition(id) {
    cloud.mode = 'loading';
    const [competitionResult, categoriesResult, participantsResult, judgesResult, votesResult] = await Promise.all([
      client.from('competitions').select('*').eq('id', id).single(),
      client.from('categories').select('id, name, position').eq('competition_id', id).order('position'),
      client.from('participants').select('id, surname, given_name, age, position').eq('competition_id', id).order('position'),
      client.from('judges').select('id, name, submitted_at').eq('competition_id', id).order('created_at'),
      client.from('votes').select('judge_id, participant_id, category_id, score').eq('competition_id', id),
    ]);
    const error = competitionResult.error || categoriesResult.error || participantsResult.error || judgesResult.error || votesResult.error;
    if (error) { showMessage('Не удалось загрузить конкурс. Проверьте, что миграция применена.'); authView(error.message); return; }
    const competition = competitionResult.data;
    cloud.competitionId = id;
    cloud.knownJudgeIds = new Set((judgesResult.data || []).map((judge) => judge.id));
    const votes = {};
    for (const judge of judgesResult.data || []) votes[judge.id] = { submitted: Boolean(judge.submitted_at) };
    for (const vote of votesResult.data || []) {
      votes[vote.judge_id] ||= {};
      votes[vote.judge_id][vote.participant_id] ||= {};
      votes[vote.judge_id][vote.participant_id][vote.category_id] = vote.score;
    }
    const oldState = window.ContestApp.getState();
    const nextState = {
      ...oldState,
      title: competition.title,
      minScore: competition.min_score,
      maxScore: competition.max_score,
      isActive: competition.status === 'open',
      categories: categoriesResult.data || [],
      participants: (participantsResult.data || []).map((person) => ({ ...person, name: person.given_name })),
      judges: (judgesResult.data || []).map((judge) => ({ id: judge.id, name: judge.name, token: cloud.issuedJudgeTokens.get(judge.id) })),
      votes,
    };
    cloud.savedSetup = setupSnapshot(nextState);
    cloud.mode = 'admin';
    window.ContestApp.setState(nextState);
    if (cloud.channel) await client.removeChannel(cloud.channel);
    cloud.channel = client.channel(`competition-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'votes', filter: `competition_id=eq.${id}` }, () => refreshLiveData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'judges', filter: `competition_id=eq.${id}` }, () => refreshLiveData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'categories', filter: `competition_id=eq.${id}` }, () => refreshLiveData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'participants', filter: `competition_id=eq.${id}` }, () => refreshLiveData())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'competitions', filter: `id=eq.${id}` }, () => refreshLiveData())
      .subscribe();
  }

  async function refreshLiveData() {
    if (cloud.mode !== 'admin' || !cloud.competitionId) return;
    const [{ data: judges }, { data: voteRows }, { data: competition }] = await Promise.all([
      client.from('judges').select('id, name, submitted_at').eq('competition_id', cloud.competitionId),
      client.from('votes').select('judge_id, participant_id, category_id, score').eq('competition_id', cloud.competitionId),
      client.from('competitions').select('status, title, min_score, max_score').eq('id', cloud.competitionId).single(),
    ]);
    const [{ data: categories }, { data: participants }] = await Promise.all([
      client.from('categories').select('id, name, position').eq('competition_id', cloud.competitionId).order('position'),
      client.from('participants').select('id, surname, given_name, age, position').eq('competition_id', cloud.competitionId).order('position'),
    ]);
    if (!judges || !voteRows || !competition || !categories || !participants) return;
    const current = window.ContestApp.getState();
    const votes = {};
    for (const judge of judges) votes[judge.id] = { submitted: Boolean(judge.submitted_at) };
    for (const vote of voteRows) {
      votes[vote.judge_id] ||= {};
      votes[vote.judge_id][vote.participant_id] ||= {};
      votes[vote.judge_id][vote.participant_id][vote.category_id] = vote.score;
    }
    cloud.knownJudgeIds = new Set(judges.map((judge) => judge.id));
    for (const judge of current.judges) {
      if (judge.token) cloud.issuedJudgeTokens.set(judge.id, judge.token);
    }
    persistIssuedTokens();
    window.ContestApp.setState({
      ...current,
      votes,
      judges: judges.map((judge) => ({ id: judge.id, name: judge.name, token: cloud.issuedJudgeTokens.get(judge.id) })),
      categories,
      participants: participants.map((person) => ({ ...person, name: person.given_name })),
      title: competition.title,
      minScore: competition.min_score,
      maxScore: competition.max_score,
      isActive: competition.status === 'open',
    });
  }

  function setupSnapshot(state) {
    return JSON.stringify({
      title: state.title,
      minScore: state.minScore,
      maxScore: state.maxScore,
      status: state.isActive ? 'open' : 'paused',
      categories: state.categories.map((item, index) => ({ id: item.id, name: item.name, position: index + 1 })),
      participants: state.participants.map((item, index) => ({ id: item.id, surname: item.surname, given_name: item.name, age: Number(item.age), position: index + 1 })),
    });
  }

  function persistState(state) {
    if (cloud.mode === 'admin' && cloud.competitionId) {
      const nextJudgeIds = new Set(state.judges.map((judge) => judge.id));
      const removed = [...cloud.knownJudgeIds].filter((judgeId) => !nextJudgeIds.has(judgeId));
      for (const judgeId of removed) {
        client.from('judges').delete().eq('id', judgeId).then(({ error }) => {
          if (handleError(error, 'Не удалось удалить судью')) cloud.knownJudgeIds.add(judgeId);
        });
        cloud.knownJudgeIds.delete(judgeId);
        cloud.issuedJudgeTokens.delete(judgeId);
      }
      if (removed.length) persistIssuedTokens();
      const snapshot = setupSnapshot(state);
      if (snapshot !== cloud.savedSetup) {
        cloud.saveQueue = cloud.saveQueue.then(async () => {
          const latestState = window.ContestApp.getState();
          const latestSnapshot = setupSnapshot(latestState);
          if (latestSnapshot === cloud.savedSetup) return;
          const setup = JSON.parse(latestSnapshot);
          const { error } = await client.rpc('save_competition_setup', {
            p_competition_id: cloud.competitionId,
            p_title: setup.title,
            p_min_score: setup.minScore,
            p_max_score: setup.maxScore,
            p_status: setup.status,
            p_categories: setup.categories,
            p_participants: setup.participants,
          });
          if (handleError(error, 'Не удалось сохранить конкурс')) return;
          cloud.savedSetup = latestSnapshot;
        });
      }
    }
    if (cloud.mode === 'judge') saveChangedJudgeScores(state);
  }

  async function saveChangedJudgeScores(state) {
    const token = judgeToken();
    const ballot = state.votes[token] || {};
    for (const participant of state.participants) {
      for (const category of state.categories) {
        const score = ballot[participant.id]?.[category.id];
        if (score === undefined) continue;
        const key = `${participant.id}:${category.id}`;
        if (cloud.savedJudgeScores.get(key) === score) continue;
        cloud.savedJudgeScores.set(key, score);
        const { error } = await client.rpc('save_judge_score', {
          p_token: token,
          p_participant_id: participant.id,
          p_category_id: category.id,
          p_score: score,
        });
        if (handleError(error, 'Не удалось сохранить оценку')) cloud.savedJudgeScores.delete(key);
      }
    }
  }

  async function loadJudge(token) {
    cloud.mode = 'judge-loading';
    const { data, error } = await client.rpc('read_judge_ballot', { p_token: token });
    if (error || !data) {
      app.innerHTML = `<main class="judge-shell"><div class="not-found"><h1>Ссылка не найдена</h1><p>Попросите администратора выдать актуальную ссылку для голосования.</p></div></main>`;
      return;
    }
    cloud.mode = 'judge';
    cloud.savedJudgeScores.clear();
    const votes = { [token]: { submitted: data.judge.submitted } };
    for (const score of data.scores) {
      votes[token][score.participant_id] ||= {};
      votes[token][score.participant_id][score.category_id] = score.score;
      cloud.savedJudgeScores.set(`${score.participant_id}:${score.category_id}`, score.score);
    }
    window.ContestApp.setState({
      ...window.ContestApp.getState(),
      title: data.competition.title,
      minScore: data.competition.min_score,
      maxScore: data.competition.max_score,
      isActive: data.competition.status === 'open',
      participants: data.participants.map((item) => ({ ...item, name: item.name })),
      categories: data.categories,
      judges: [{ id: token, name: data.judge.name }],
      votes,
    });
  }

  async function createJudge(name) {
    const token = makeToken();
    const { data, error } = await client.rpc('create_judge_link', {
      p_competition_id: cloud.competitionId,
      p_name: name,
      p_token: token,
    });
    if (error) throw error;
    cloud.knownJudgeIds.add(data);
    cloud.issuedJudgeTokens.set(data, token);
    persistIssuedTokens();
    return { id: data, name, token };
  }

  async function rotateJudge(id) {
    if (!confirm('Выдать новую ссылку? Предыдущая ссылка станет недействительной, а этот судейский бюллетень очистится.')) return;
    const { data: token, error } = await client.rpc('rotate_judge_link', { p_judge_id: id });
    if (error) { showMessage('Не удалось создать ссылку'); return; }
    cloud.issuedJudgeTokens.set(id, token);
    persistIssuedTokens();
    const state = window.ContestApp.getState();
    state.judges = state.judges.map((judge) => judge.id === id ? { ...judge, token } : judge);
    delete state.votes[id];
    window.ContestApp.persist();
    window.ContestApp.render();
    showMessage('Новая ссылка создана');
  }

  async function createCompetition(title) {
    const { data, error } = await client.from('competitions').insert({
      organization_id: cloud.organization.id,
      title: title.trim(), min_score: 1, max_score: 5, status: 'draft',
    }).select('id, title, status, created_at').single();
    if (error) throw error;
    if (cloud.competitionId) {
      const { error: pauseError } = await client.from('competitions').update({ status: 'paused' }).eq('id', cloud.competitionId).eq('status', 'open');
      if (pauseError) handleError(pauseError, 'Новый конкурс создан, но предыдущий не удалось остановить');
    }
    cloud.competitions.push(data);
    await loadCompetition(data.id);
  }

  async function newCompetition() {
    try { await createCompetition(`Конкурс ${new Date().toLocaleDateString('ru-RU')}`); }
    catch (error) { handleError(error, 'Не удалось создать конкурс'); }
  }

  async function handleAuth(event) {
    const button = event.submitter;
    const mode = button?.dataset.authMode;
    if (!mode) return;
    event.preventDefault();
    const form = event.target;
    const message = form.querySelector('#cloud-auth-message');
    const email = new FormData(form).get('email').trim();
    const password = new FormData(form).get('password');
    button.disabled = true;
    const result = mode === 'sign-in'
      ? await client.auth.signInWithPassword({ email, password })
      : await client.auth.signUp({ email, password });
    button.disabled = false;
    if (result.error) { message.textContent = result.error.message; return; }
    if (mode === 'sign-up' && !result.data.session) {
      message.textContent = 'Проверьте почту и подтвердите адрес, затем войдите.';
      return;
    }
    cloud.user = result.data.user;
    if (isPlatformAdminRoute()) await loadPlatformAdmin();
    else await loadOrganization();
  }

  async function handleOrganization(event) {
    event.preventDefault();
    const name = new FormData(event.target).get('name').trim();
    const { data: organizationId, error } = await client.rpc('create_organization', { p_name: name });
    if (error) { organizationView(error.message); return; }
    cloud.organization = { id: organizationId, name };
    firstCompetitionView();
    document.querySelector('#new-competition-title').value = `Конкурс ${new Date().toLocaleDateString('ru-RU')}`;
  }

  async function handleCompetition(event) {
    event.preventDefault();
    const title = new FormData(event.target).get('title').trim();
    try { await createCompetition(title); }
    catch (error) { firstCompetitionView(error.message); }
  }

  async function switchCompetition(id) {
    if (!id || id === cloud.competitionId) return;
    location.hash = `competition=${encodeURIComponent(id)}`;
    await loadCompetition(id);
  }

  function decorateAdmin() {
    if (cloud.mode !== 'admin') return;
    app.querySelector('.notice')?.remove();
    app.querySelector('.side-bottom')?.remove();
    const crumb = app.querySelector('.crumb');
    if (crumb && !crumb.querySelector('#cloud-competition-switch')) {
      crumb.innerHTML = `<span>Организация: ${escapeHtml(cloud.organization?.name || '')}</span><select class="select" id="cloud-competition-switch" aria-label="Выбрать конкурс">${cloud.competitions.map((item) => `<option value="${item.id}" ${item.id === cloud.competitionId ? 'selected' : ''}>${escapeHtml(item.title)}</option>`).join('')}</select>`;
      crumb.querySelector('select').addEventListener('change', (event) => switchCompetition(event.target.value));
    }
    const adminPill = app.querySelector('.admin-pill');
    if (adminPill && !adminPill.querySelector('[data-cloud-action="sign-out"]')) {
      adminPill.innerHTML = `<span class="avatar">${escapeHtml((cloud.user?.email || 'A').slice(0, 1).toUpperCase())}</span><span>${escapeHtml(cloud.user?.email || 'Организатор')}</span><button class="button secondary small" type="button" data-cloud-action="sign-out">Выйти</button>`;
    }
    if (adminPill && cloud.platformAdmin && !adminPill.querySelector('[data-platform-admin-link]')) {
      const link = document.createElement('a');
      link.href = `${location.pathname}#admin`;
      link.className = 'button secondary small';
      link.dataset.platformAdminLink = '';
      link.textContent = 'Аккаунты';
      adminPill.prepend(link);
    }
    app.querySelectorAll('.top-actions > .demo-label:not([data-cloud-sync])').forEach((label) => label.remove());
    const demoButton = app.querySelector('[data-action="load-demo"]');
    if (demoButton) demoButton.style.display = 'none';
    app.querySelectorAll('[data-action="copy-link"]').forEach((button) => {
      const judge = window.ContestApp.getState().judges.find((item) => item.id === button.dataset.id);
      if (!judge?.token) {
        button.textContent = 'Перевыпустить ссылку';
        button.dataset.action = 'rotate-judge-link';
        button.title = 'Старая ссылка станет недействительной, бюллетень очистится';
        button.setAttribute('aria-label', `Перевыпустить ссылку для ${judge?.name || 'судьи'}`);
        const linkBox = button.closest('.list-row')?.querySelector('.link-box');
        if (linkBox) linkBox.textContent = 'Ссылка недоступна в этой вкладке. Перевыпустите её, чтобы получить новую.';
      }
    });
    if (!app.querySelector('[data-cloud-sync]')) {
      const status = document.createElement('span');
      status.dataset.cloudSync = '';
      status.className = 'demo-label';
      status.textContent = 'ОБЛАКО · REALTIME';
      app.querySelector('.top-actions')?.prepend(status);
    }
  }

  app.addEventListener('click', async (event) => {
    const signOut = event.target.closest('[data-cloud-action="sign-out"]');
    if (signOut) {
      if (cloud.channel) await client.removeChannel(cloud.channel);
      cloud.channel = null; cloud.competitionId = null; cloud.competitions = []; cloud.organization = null;
      cloud.issuedJudgeTokens.clear();
      persistIssuedTokens();
      await client.auth.signOut(); cloud.user = null; authView(); return;
    }
    const rotate = event.target.closest('[data-action="rotate-judge-link"]');
    if (rotate) { event.stopImmediatePropagation(); await rotateJudge(rotate.dataset.id); return; }
    if (event.target.closest('[data-action="load-demo"]') && cloud.mode === 'admin') {
      event.stopImmediatePropagation();
      showMessage('Демо-кнопка доступна только в локальном режиме. Для тестирования создайте отдельный конкурс.');
    }
    if (event.target.closest('[data-action="reset-contest"]') && cloud.mode === 'admin') {
      event.stopImmediatePropagation();
      if (!confirm('Создать отдельный пустой конкурс? Текущий конкурс и его голоса сохранятся.')) return;
      await newCompetition();
    }
  }, true);

  app.addEventListener('click', async (event) => {
    const scoreButton = event.target.closest('[data-score]');
    if (!scoreButton || cloud.mode !== 'judge') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const token = judgeToken();
    const state = window.ContestApp.getState();
    state.votes[token] ||= {};
    state.votes[token][scoreButton.dataset.person] ||= {};
    state.votes[token][scoreButton.dataset.person][scoreButton.dataset.category] = Number(scoreButton.dataset.score);
    window.ContestApp.renderJudge(token);
    persistState(state);
  }, true);

  app.addEventListener('submit', async (event) => {
    if (event.target.id !== 'ballot-form' || cloud.mode !== 'judge') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const token = judgeToken();
    const state = window.ContestApp.getState();
    const ballot = state.votes[token] || {};
    const complete = state.participants.every((person) => state.categories.every((category) => ballot[person.id]?.[category.id] !== undefined));
    if (!complete) { showMessage('Поставьте оценку в каждой категории для всех участниц'); return; }
    if (!confirm('Отправить бюллетень? После отправки изменить оценки нельзя.')) return;
    const scores = state.participants.flatMap((person) => state.categories.map((category) => ({
      participant_id: person.id,
      category_id: category.id,
      score: ballot[person.id][category.id],
    })));
    const { error } = await client.rpc('submit_judge_ballot', { p_token: token, p_scores: scores });
    if (handleError(error, 'Не удалось отправить бюллетень')) return;
    ballot.submitted = true;
    window.ContestApp.renderJudge(token);
    showMessage('Бюллетень отправлен');
  }, true);

  document.addEventListener('submit', (event) => {
    if (event.target.id === 'cloud-auth-form') handleAuth(event);
    if (event.target.id === 'organization-form') handleOrganization(event);
    if (event.target.id === 'new-competition-form') handleCompetition(event);
  }, true);

  window.addEventListener('hashchange', () => {
    if (cloud.mode === 'starting' || cloud.mode === 'auth') return;
    if (isJudgeRoute()) loadJudge(judgeToken());
    else if (cloud.user && isPlatformAdminRoute()) loadPlatformAdmin();
    else if (cloud.user) loadOrganization();
  });
  client.auth.onAuthStateChange((_event, session) => {
    if (_event === 'SIGNED_OUT') { cloud.user = null; authView(); }
  });

  window.ContestCloud = {
    isConnected: () => cloud.mode === 'admin' || cloud.mode === 'judge',
    isAdmin: () => cloud.mode === 'admin',
    decorate: decorateAdmin,
    persistState,
    createJudge,
  };
  start();
})();
