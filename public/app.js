const $ = s => document.querySelector(s);
const api = async (url, method = 'GET', body) => {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Erreur réseau.'); e.status = r.status; throw e; }
  return d;
};
const initial = n => (n || '?').trim()[0].toUpperCase();
const hour = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

let me = null, peer = null, stream = null, mode = 'login';

// ---------- Auth ----------
function setMode(m) {
  mode = m;
  $('#tab-login').classList.toggle('on', m === 'login');
  $('#tab-register').classList.toggle('on', m === 'register');
  $('#a-name').hidden = m === 'login';
  $('#a-submit').textContent = m === 'login' ? 'Se connecter' : 'Créer mon compte';
  $('#a-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('#a-error').textContent = '';
}
$('#tab-login').onclick = () => setMode('login');
$('#tab-register').onclick = () => setMode('register');

async function submitAuth() {
  try {
    const body = { email: $('#a-email').value, password: $('#a-pass').value };
    if (mode === 'register') body.name = $('#a-name').value;
    me = await api(mode === 'login' ? '/api/login' : '/api/register', 'POST', body);
    $('#a-pass').value = '';
    startApp();
  } catch (e) { $('#a-error').textContent = e.message; }
}
$('#a-submit').onclick = submitAuth;
['#a-email', '#a-pass', '#a-name'].forEach(s => $(s).addEventListener('keydown', e => e.key === 'Enter' && submitAuth()));

$('#btn-logout').onclick = async () => {
  await api('/api/logout', 'POST');
  stream?.close(); me = peer = null;
  $('#app').hidden = true; $('#auth').hidden = false;
};
$('#btn-profile').onclick = async () => {
  const name = prompt('Nouveau nom affiché :', me.name);
  if (!name || !name.trim()) return;
  try { me = await api('/api/me', 'PATCH', { name }); renderMe(); } catch (e) { alert(e.message); }
};

// ---------- App ----------
function renderMe() {
  $('#me-name').textContent = me.name;
  $('#me-email').textContent = me.email;
  $('#me-avatar').textContent = initial(me.name);
}

function startApp() {
  $('#auth').hidden = true; $('#app').hidden = false;
  renderMe(); loadList();
  stream?.close();
  stream = new EventSource('/api/stream');
  stream.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (peer && (m.sender_id === peer.id || m.recipient_id === peer.id)) addMsg(m);
    if (!$('#search').value) loadList();
  };
}

function row(u, sub) {
  const li = document.createElement('li');
  if (peer && peer.id === u.id) li.className = 'on';
  li.innerHTML = '<div class="avatar"></div><div class="meta"><strong></strong><span></span></div>';
  li.querySelector('.avatar').textContent = initial(u.name);
  li.querySelector('strong').textContent = u.name;
  li.querySelector('span').textContent = sub;
  li.onclick = () => openChat(u);
  return li;
}

async function loadList() {
  const q = $('#search').value.trim();
  const items = await api(q ? '/api/users?q=' + encodeURIComponent(q) : '/api/conversations');
  const ul = $('#list'); ul.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = q ? 'Aucune personne trouvée.' : 'Aucune conversation pour l’instant. Cherche quelqu’un ci-dessus.';
    ul.append(li); return;
  }
  items.forEach(u => ul.append(row(u, q ? u.email : (u.sender_id === me.id ? 'Toi : ' : '') + u.body)));
}
let timer;
$('#search').oninput = () => { clearTimeout(timer); timer = setTimeout(loadList, 200); };

async function openChat(u) {
  peer = u;
  $('#peer-name').textContent = u.name;
  $('#empty').hidden = true; $('#composer').hidden = false;
  $('#app').classList.add('in-chat');
  $('#msgs').innerHTML = '';
  (await api('/api/messages/' + u.id)).forEach(addMsg);
  $('#text').focus(); loadList();
}
$('#btn-back').onclick = () => { $('#app').classList.remove('in-chat'); peer = null; loadList(); };

function addMsg(m) {
  const box = $('#msgs');
  if (box.querySelector(`[data-id="${m.id}"]`)) return;
  const d = document.createElement('div');
  d.className = 'msg' + (m.sender_id === me.id ? ' me' : '');
  d.dataset.id = m.id;
  const p = document.createElement('span'); p.textContent = m.body;
  const t = document.createElement('time'); t.textContent = hour(m.created_at);
  d.append(p, t); box.append(d); box.scrollTop = box.scrollHeight;
}

$('#composer').onsubmit = async e => {
  e.preventDefault();
  const body = $('#text').value.trim();
  if (!body || !peer) return;
  $('#text').value = '';
  try { await api('/api/messages', 'POST', { to: peer.id, body }); } catch (err) { alert(err.message); }
};

// ---------- Démarrage : session existante ? ----------
(async () => {
  try { me = await api('/api/me'); startApp(); }
  catch { $('#auth').hidden = false; }
})();

