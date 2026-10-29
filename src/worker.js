// NPI - Secret Santa: API para Cloudflare Workers + D1. Un solo Worker sirve la app y la API.
import { SEED } from './seed.js';

const SLOTS = 10, MIN = 5;
const MAX_IMG_B64 = 210000;
const DEFAULTS = { year: '2026', first_friday: '2026-10-30', weeks: '6' };
let ready = false;

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      console.error('Error:', e && e.stack || e);
      return json({ error: 'Error interno. Intenta de nuevo.' }, 500);
    }
  },
};

/* ---------- utilidades ---------- */
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
}
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim(); }
function fromB64(str) {
  const bin = atob(str), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const salt = env => env.HASH_SALT || 'sal-de-desarrollo-cambiala';

/* ---------- base de datos: se crea sola ---------- */
async function ensureReady(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL, pw_hash TEXT NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS lists (person_id TEXT PRIMARY KEY, candies TEXT NOT NULL, weeks TEXT NOT NULL DEFAULT \'{}\', updated INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS photos (person_id TEXT NOT NULL, slot INTEGER NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (person_id, slot))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS fails (ip_hash TEXT NOT NULL, ts INTEGER NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_fails ON fails(ip_hash, ts)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS archives (year INTEGER PRIMARY KEY, archived_at INTEGER NOT NULL, settings TEXT NOT NULL, people TEXT NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS archive_lists (year INTEGER NOT NULL, person_id TEXT NOT NULL, candies TEXT NOT NULL, weeks TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (year, person_id))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS archive_photos (year INTEGER NOT NULL, person_id TEXT NOT NULL, slot INTEGER NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (year, person_id, slot))'),
  ]);
  await env.DB.batch(Object.keys(DEFAULTS).map(k => env.DB.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)').bind(k, DEFAULTS[k])));
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM people').first();
  if (!n.n) {
    const stmts = [];
    for (const p of SEED) {
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO people (id,name,pw_hash) VALUES (?,?,?)').bind(p.id, p.n, p.h));
      if (p.c && p.c.length) {
        const c = Array.from({ length: SLOTS }, (_, i) => p.c[i] || '');
        stmts.push(env.DB.prepare('INSERT OR IGNORE INTO lists (person_id,candies,weeks,updated) VALUES (?,?,?,?)').bind(p.id, JSON.stringify(c), '{}', 1));
      }
    }
    await env.DB.batch(stmts);
  }
  ready = true;
}

/* ---------- ajustes de la edición ---------- */
async function getSettings(env) {
  const rows = await env.DB.prepare('SELECT key,value FROM settings').all();
  const s = { ...DEFAULTS };
  for (const r of rows.results) s[r.key] = r.value;
  return { year: Number(s.year), firstFriday: s.first_friday, weeks: Number(s.weeks) };
}
function weekOpen(s, i) { return Date.parse(s.firstFriday + 'T00:00:00-06:00') + i * 7 * 864e5; }
function parseSettings(b) {
  const year = Number(b && b.year), weeks = Number(b && b.weeks), d = String((b && (b.firstFriday || b.first_friday)) || '');
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return { error: 'El año debe estar entre 2000 y 2100.' };
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 10) return { error: 'Las semanas deben ser de 1 a 10.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d + 'T12:00:00-06:00'))) return { error: 'Indica la fecha del primer viernes.' };
  if (new Date(Date.parse(d + 'T12:00:00-06:00')).getUTCDay() !== 5) return { error: 'La fecha del primer regalo debe ser un viernes.' };
  return { year, weeks, firstFriday: d };
}
function slug(name) { return norm(name).replace(/[^a-z0-9]/g, '').slice(0, 24) || 'amigo'; }

/* ---------- autenticación ---------- */
async function authorize(request, env, id, { allowAdmin = true } = {}) {
  const authz = request.headers.get('Authorization') || '';
  if (allowAdmin && env.ADMIN_TOKEN && safeEqual(authz, 'Bearer ' + env.ADMIN_TOKEN)) return { ok: true, admin: true };
  const pw = (request.headers.get('X-Password') || '').trim();
  if (!pw) return { ok: false, status: 401, error: 'Escribe tu contraseña.' };
  const ipH = await sha256(salt(env) + '|ip|' + (request.headers.get('CF-Connecting-IP') || ''));
  const since = Date.now() - 15 * 60 * 1000;
  const f = await env.DB.prepare('SELECT COUNT(*) AS n FROM fails WHERE ip_hash=? AND ts>?').bind(ipH, since).first();
  if (f.n >= 10) return { ok: false, status: 429, error: 'Demasiados intentos fallidos. Espera unos minutos.' };
  const p = await env.DB.prepare('SELECT pw_hash FROM people WHERE id=?').bind(id).first();
  if (!p) return { ok: false, status: 404, error: 'Esa persona no existe.' };
  const h = await sha256(id + ':' + pw + ':npi-ss');
  if (!safeEqual(h, p.pw_hash)) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO fails (ip_hash,ts) VALUES (?,?)').bind(ipH, Date.now()),
      env.DB.prepare('DELETE FROM fails WHERE ts<?').bind(Date.now() - 24 * 3600 * 1000),
    ]);
    return { ok: false, status: 401, error: 'La contraseña no coincide con ese nombre.' };
  }
  return { ok: true, admin: false };
}

/* ---------- rutas ---------- */
async function route(request, env) {
  const url = new URL(request.url), path = url.pathname, m = request.method;
  if (!path.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('No encontrado', { status: 404 });
  await ensureReady(env);
  let mm;

  if (m === 'GET' && path === '/api/state') return state(env);
  if (m === 'GET' && path === '/api/archives') return archivesList(env);
  if (m === 'GET' && (mm = path.match(/^\/api\/archive\/(\d{4})$/))) return archiveState(env, Number(mm[1]));
  if (m === 'GET' && (mm = path.match(/^\/api\/archive\/(\d{4})\/photo\/([a-z0-9]+)\/(\d)$/))) return archivePhoto(env, Number(mm[1]), mm[2], Number(mm[3]));
  if (m === 'GET' && (mm = path.match(/^\/api\/photo\/([a-z0-9]+)\/(\d)$/))) return photo(env, mm[1], Number(mm[2]));
  if (m === 'POST' && (mm = path.match(/^\/api\/auth\/([a-z0-9]+)$/))) {
    const a = await authorize(request, env, mm[1]);
    return a.ok ? json({ ok: true, admin: a.admin }) : json({ error: a.error }, a.status);
  }
  if (m === 'PUT' && (mm = path.match(/^\/api\/list\/([a-z0-9]+)$/))) return saveList(request, env, mm[1]);
  if (m === 'POST' && (mm = path.match(/^\/api\/weeks\/([a-z0-9]+)$/))) return saveWeek(request, env, mm[1]);

  // Solo organizador
  if (path.startsWith('/api/admin/') || (m === 'DELETE' && path.startsWith('/api/list/'))) {
    if (!env.ADMIN_TOKEN) return json({ error: 'Falta configurar ADMIN_TOKEN.' }, 503);
    if (!safeEqual(request.headers.get('Authorization') || '', 'Bearer ' + env.ADMIN_TOKEN)) return json({ error: 'Clave de organizador incorrecta.' }, 401);
    if (m === 'GET' && path === '/api/admin/ping') return json({ ok: true });
    if (m === 'GET' && path === '/api/admin/export') {
      const s = await (await state(env)).json();
      return new Response(JSON.stringify(s, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="secret-santa-respaldo.json"', 'cache-control': 'no-store' } });
    }
    if (m === 'DELETE' && (mm = path.match(/^\/api\/list\/([a-z0-9]+)$/))) {
      await env.DB.batch([env.DB.prepare('DELETE FROM photos WHERE person_id=?').bind(mm[1]), env.DB.prepare('DELETE FROM lists WHERE person_id=?').bind(mm[1])]);
      return json({ ok: true });
    }
    if (m === 'POST' && path === '/api/admin/password') {
      const b = await request.json().catch(() => ({}));
      const pw = String(b.password || '').trim();
      if (!/^[a-z0-9]+$/.test(String(b.id || '')) || pw.length < 3 || pw.length > 40) return json({ error: 'Indica la persona y una contraseña de 3 a 40 caracteres.' }, 400);
      const r = await env.DB.prepare('UPDATE people SET pw_hash=? WHERE id=?').bind(await sha256(b.id + ':' + pw + ':npi-ss'), b.id).run();
      return json({ ok: true, changed: r.meta && r.meta.changes });
    }
    if (m === 'PUT' && path === '/api/admin/settings') return adminSettings(request, env);
    if (m === 'POST' && path === '/api/admin/people') return adminAddPerson(request, env);
    if (m === 'PUT' && (mm = path.match(/^\/api\/admin\/people\/([a-z0-9]+)$/))) return adminRename(request, env, mm[1]);
    if (m === 'DELETE' && (mm = path.match(/^\/api\/admin\/people\/([a-z0-9]+)$/))) return adminRemove(env, mm[1]);
    if (m === 'POST' && path === '/api/admin/new-year') return adminNewYear(request, env);
  }
  return json({ error: 'No encontrado.' }, 404);
}

async function state(env) {
  const [people, lists, photos] = await env.DB.batch([
    env.DB.prepare('SELECT id,name FROM people ORDER BY name COLLATE NOCASE'),
    env.DB.prepare('SELECT person_id,candies,weeks,updated FROM lists'),
    env.DB.prepare('SELECT person_id,slot,updated FROM photos'),
  ]);
  return json({ people: people.results, lists: shapeLists(lists.results, photos.results), settings: await getSettings(env), now: Date.now() });
}
function shapeLists(listRows, photoRows) {
  const out = {};
  for (const l of listRows) {
    let candies = [], weeks = {};
    try { candies = JSON.parse(l.candies); } catch (e) { /* vacío */ }
    try { weeks = JSON.parse(l.weeks); } catch (e) { /* vacío */ }
    out[l.person_id] = { candies, weeks, updated: l.updated, photos: {} };
  }
  for (const p of photoRows) if (out[p.person_id]) out[p.person_id].photos[String(p.slot)] = p.updated;
  return out;
}

/* ---------- ediciones anteriores (solo lectura) ---------- */
async function archivesList(env) {
  const { results } = await env.DB.prepare('SELECT year, archived_at FROM archives ORDER BY year DESC').all();
  return json({ items: results });
}
async function archiveState(env, year) {
  const a = await env.DB.prepare('SELECT settings, people FROM archives WHERE year=?').bind(year).first();
  if (!a) return json({ error: 'No hay copia de ese año.' }, 404);
  const [lists, photos] = await env.DB.batch([
    env.DB.prepare('SELECT person_id,candies,weeks,updated FROM archive_lists WHERE year=?').bind(year),
    env.DB.prepare('SELECT person_id,slot,updated FROM archive_photos WHERE year=?').bind(year),
  ]);
  let people = [], settings = {};
  try { people = JSON.parse(a.people); } catch (e) { /* vacío */ }
  try { settings = JSON.parse(a.settings); } catch (e) { /* vacío */ }
  return json({ year, people, lists: shapeLists(lists.results, photos.results), settings, readOnly: true });
}
async function archivePhoto(env, year, id, slot) {
  const row = await env.DB.prepare('SELECT data FROM archive_photos WHERE year=? AND person_id=? AND slot=?').bind(year, id, slot).first();
  if (!row) return json({ error: 'Sin foto.' }, 404);
  return new Response(fromB64(row.data), { headers: { 'content-type': 'image/jpeg', 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=86400' } });
}

/* ---------- administración de la edición y de los nombres ---------- */
const putSetting = (env, k, v) => env.DB.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(k, String(v));
async function adminSettings(request, env) {
  const s = parseSettings(await request.json().catch(() => ({})));
  if (s.error) return json({ error: s.error }, 400);
  await env.DB.batch([putSetting(env, 'year', s.year), putSetting(env, 'first_friday', s.firstFriday), putSetting(env, 'weeks', s.weeks)]);
  return json({ ok: true, settings: s });
}
function cleanName(v) { return String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40); }
async function adminAddPerson(request, env) {
  const b = await request.json().catch(() => ({}));
  const name = cleanName(b.name), pw = String(b.password || '').trim();
  if (!name) return json({ error: 'Escribe el nombre.' }, 400);
  if (pw.length < 3 || pw.length > 40) return json({ error: 'La contraseña debe tener de 3 a 40 caracteres.' }, 400);
  const taken = await env.DB.prepare('SELECT id FROM people').all();
  const ids = new Set(taken.results.map(r => r.id));
  let id = slug(name), n = 2;
  while (ids.has(id)) id = slug(name).slice(0, 22) + n++;
  await env.DB.prepare('INSERT INTO people (id,name,pw_hash) VALUES (?,?,?)').bind(id, name, await sha256(id + ':' + pw + ':npi-ss')).run();
  return json({ ok: true, id });
}
async function adminRename(request, env, id) {
  const b = await request.json().catch(() => ({}));
  const name = cleanName(b.name);
  if (!name) return json({ error: 'Escribe el nombre.' }, 400);
  const r = await env.DB.prepare('UPDATE people SET name=? WHERE id=?').bind(name, id).run();
  if (!(r.meta && r.meta.changes)) return json({ error: 'Esa persona no existe.' }, 404);
  return json({ ok: true });
}
async function adminRemove(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM photos WHERE person_id=?').bind(id),
    env.DB.prepare('DELETE FROM lists WHERE person_id=?').bind(id),
    env.DB.prepare('DELETE FROM people WHERE id=?').bind(id),
  ]);
  return json({ ok: true });
}
// Archiva la edición actual (nombres, dulces, marcas y fotos) y empieza una nueva, todo en una sola operación.
async function adminNewYear(request, env) {
  const b = await request.json().catch(() => ({}));
  const cur = await getSettings(env), ns = parseSettings(b);
  if (ns.error) return json({ error: ns.error }, 400);
  if (String(b.confirm || '').trim().toUpperCase() !== 'ARCHIVAR ' + cur.year) return json({ error: 'Escribe ARCHIVAR ' + cur.year + ' para confirmar.' }, 400);
  if (ns.year === cur.year) return json({ error: 'El año nuevo debe ser distinto al actual (' + cur.year + ').' }, 400);
  const clash = await env.DB.prepare('SELECT year FROM archives WHERE year IN (?,?)').bind(cur.year, ns.year).all();
  if (clash.results.length) return json({ error: 'Ya existe una copia del año ' + clash.results[0].year + '. Revisa los años antes de continuar.' }, 400);
  const people = await env.DB.prepare('SELECT id,name FROM people ORDER BY name COLLATE NOCASE').all();
  const now = Date.now();
  const stmts = [
    env.DB.prepare('INSERT INTO archives (year,archived_at,settings,people) VALUES (?,?,?,?)').bind(cur.year, now, JSON.stringify(cur), JSON.stringify(people.results)),
    env.DB.prepare('INSERT INTO archive_lists (year,person_id,candies,weeks,updated) SELECT ?,person_id,candies,weeks,updated FROM lists').bind(cur.year),
    env.DB.prepare('INSERT INTO archive_photos (year,person_id,slot,data,updated) SELECT ?,person_id,slot,data,updated FROM photos').bind(cur.year),
    env.DB.prepare('DELETE FROM photos'),
    b.copyCandies ? env.DB.prepare("UPDATE lists SET weeks='{}', updated=?").bind(now) : env.DB.prepare('DELETE FROM lists'),
    putSetting(env, 'year', ns.year), putSetting(env, 'first_friday', ns.firstFriday), putSetting(env, 'weeks', ns.weeks),
  ];
  await env.DB.batch(stmts);
  return json({ ok: true, archivedYear: cur.year, settings: ns });
}

async function photo(env, id, slot) {
  const row = await env.DB.prepare('SELECT data FROM photos WHERE person_id=? AND slot=?').bind(id, slot).first();
  if (!row) return json({ error: 'Sin foto.' }, 404);
  return new Response(fromB64(row.data), { headers: { 'content-type': 'image/jpeg', 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=86400' } });
}

async function saveList(request, env, id) {
  const a = await authorize(request, env, id);
  if (!a.ok) return json({ error: a.error }, a.status);
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.candies)) return json({ error: 'Datos inválidos.' }, 400);

  const texts = Array.from({ length: SLOTS }, (_, i) => String(body.candies[i] || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90));
  const filled = texts.filter(Boolean);
  if (filled.length < MIN) return json({ error: 'Registra al menos 5 dulces.' }, 400);
  const low = filled.map(norm);
  if (low.some((x, i) => low.indexOf(x) !== i)) return json({ error: 'Los dulces deben ser diferentes.' }, 400);

  const changes = body.photos && typeof body.photos === 'object' ? body.photos : {};
  const have = await env.DB.prepare('SELECT slot FROM photos WHERE person_id=?').bind(id).all();
  const final = new Set(have.results.map(r => r.slot));
  const stmts = [], now = Date.now();
  for (const key of Object.keys(changes)) {
    const k = Number(key);
    if (!Number.isInteger(k) || k < 0 || k >= SLOTS) return json({ error: 'Foto con posición inválida.' }, 400);
    const v = changes[key];
    if (v === null) { final.delete(k); stmts.push(env.DB.prepare('DELETE FROM photos WHERE person_id=? AND slot=?').bind(id, k)); }
    else if (typeof v === 'string') {
      const pre = 'data:image/jpeg;base64,';
      if (!v.startsWith(pre)) return json({ error: 'Las fotos deben ser JPEG.' }, 400);
      const b64 = v.slice(pre.length);
      if (b64.length > MAX_IMG_B64 || !b64.startsWith('/9j/')) return json({ error: 'La foto es muy grande o no es válida.' }, 400);
      final.add(k);
      stmts.push(env.DB.prepare('INSERT INTO photos (person_id,slot,data,updated) VALUES (?,?,?,?) ON CONFLICT(person_id,slot) DO UPDATE SET data=excluded.data, updated=excluded.updated').bind(id, k, b64, now));
    }
  }
  for (const k of final) if (!texts[k]) return json({ error: 'El dulce ' + (k + 1) + ' tiene foto pero no nombre: escríbele un nombre o quítale la foto.' }, 400);

  stmts.push(env.DB.prepare('INSERT INTO lists (person_id,candies,weeks,updated) VALUES (?,?,\'{}\',?) ON CONFLICT(person_id) DO UPDATE SET candies=excluded.candies, updated=excluded.updated').bind(id, JSON.stringify(texts), now));
  await env.DB.batch(stmts);
  return json({ ok: true, updated: now });
}

async function saveWeek(request, env, id) {
  const a = await authorize(request, env, id, { allowAdmin: false });
  if (!a.ok) return json({ error: a.error }, a.status);
  const b = await request.json().catch(() => ({}));
  const s = await getSettings(env), week = Number(b.week), st = String(b.state || '');
  if (!Number.isInteger(week) || week < 1 || week > s.weeks || !['', 'ok', 'alt', 'no'].includes(st)) return json({ error: 'Datos inválidos.' }, 400);
  if (Date.now() < weekOpen(s, week - 1)) return json({ error: 'Aún no es viernes de esa semana.' }, 403);
  const l = await env.DB.prepare('SELECT weeks FROM lists WHERE person_id=?').bind(id).first();
  if (!l) return json({ error: 'Primero registra tus dulces.' }, 400);
  let weeks = {};
  try { weeks = JSON.parse(l.weeks); } catch (e) { /* vacío */ }
  if (st) weeks[String(week)] = st; else delete weeks[String(week)];
  await env.DB.prepare('UPDATE lists SET weeks=? WHERE person_id=?').bind(JSON.stringify(weeks), id).run();
  return json({ ok: true, weeks });
}
