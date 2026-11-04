'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'datos');
const PUBLIC = path.join(__dirname, 'public');
const COOKIE_SEGURA = process.env.COOKIE_SEGURA === '1';
const DURACION_SESION = 12 * 3600 * 1000;
const TZ = 'America/Argentina/Buenos_Aires';

const CATEGORIAS = {
  sanitaria: { nombre: 'Sanitaria', extra: 'Lugar de atención' },
  personal: { nombre: 'De personal', extra: 'Motivo' },
  aula: { nombre: 'De aula / instrucción', extra: 'Materia o actividad' },
  general: { nombre: 'General', extra: 'Lugar' },
  otra: { nombre: 'Otra', extra: 'Referencia' },
};
const ESTADOS = ['Informada', 'En seguimiento', 'Finalizada'];
const ROLES = ['jefe', 'supervisor', 'admin'];

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'sigen.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nombre TEXT NOT NULL,
  clave TEXT NOT NULL,
  rol TEXT NOT NULL,
  dependencia TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  debe_cambiar INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS novedades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT NOT NULL UNIQUE,
  categoria TEXT NOT NULL,
  dependencia TEXT NOT NULL,
  fecha TEXT NOT NULL,
  hora TEXT NOT NULL,
  extra TEXT NOT NULL,
  personal TEXT NOT NULL,
  descripcion TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'Informada',
  autor_id INTEGER NOT NULL REFERENCES usuarios(id),
  creado TEXT NOT NULL,
  actualizado TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS historial (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novedad_id INTEGER NOT NULL REFERENCES novedades(id),
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  fecha TEXT NOT NULL,
  accion TEXT NOT NULL,
  detalle TEXT
);
CREATE INDEX IF NOT EXISTS ix_novedades_fecha ON novedades(fecha);
CREATE INDEX IF NOT EXISTS ix_historial_novedad ON historial(novedad_id);
`);

const ahora = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const txt = (v, max) => String(v ?? '').trim().slice(0, max);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

function hashClave(clave) {
  const sal = crypto.randomBytes(16);
  return sal.toString('hex') + ':' + crypto.scryptSync(clave, sal, 64).toString('hex');
}
function verificarClave(clave, guardado) {
  const [sal, h] = String(guardado).split(':');
  const calculado = crypto.scryptSync(String(clave ?? ''), Buffer.from(sal, 'hex'), 64);
  return crypto.timingSafeEqual(calculado, Buffer.from(h, 'hex'));
}
function validarClave(c) {
  if (c.length < 8 || !/[A-Za-z]/.test(c) || !/\d/.test(c)) fail(400, 'La contraseña debe tener al menos 8 caracteres, con letras y números');
}

if (!db.prepare('SELECT 1 FROM usuarios LIMIT 1').get()) {
  const inicial = process.env.ADMIN_CLAVE || crypto.randomBytes(6).toString('hex');
  db.prepare("INSERT INTO usuarios (usuario, nombre, clave, rol) VALUES ('admin', 'Administrador', ?, 'admin')").run(hashClave(inicial));
  console.log(`Usuario inicial: admin / ${inicial}  (se pedirá cambiar la contraseña al ingresar)`);
}

const pub = (u) => ({ id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol, dependencia: u.dependencia, debe_cambiar: u.debe_cambiar });

function leer(req) {
  return new Promise((ok, no) => {
    const partes = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n <= 100000) partes.push(c); });
    req.on('end', () => {
      if (n > 100000) return no(Object.assign(new Error('Solicitud demasiado grande'), { status: 413 }));
      try { ok(partes.length ? JSON.parse(Buffer.concat(partes)) : {}); }
      catch { no(Object.assign(new Error('Solicitud inválida'), { status: 400 })); }
    });
    req.on('error', no);
  });
}
function enviar(res, status, data, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(data));
}

const cookieSid = (req) => /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
const setCookie = (v, max) => `sid=${v}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${max}${COOKIE_SEGURA ? '; Secure' : ''}`;

function sesion(req) {
  const tok = cookieSid(req);
  const u = tok && db.prepare(
    'SELECT u.* FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token = ? AND s.expira > ? AND u.activo = 1'
  ).get(sha(tok), Date.now());
  if (!u) fail(401, 'Sesión no iniciada o vencida');
  return u;
}

const fallos = new Map();
const VENTANA = 10 * 60 * 1000;
function controlarIntentos(clave) {
  const f = fallos.get(clave);
  if (f && f.n >= 5 && Date.now() - f.t < VENTANA) fail(429, 'Demasiados intentos fallidos. Esperá 10 minutos.');
}
function registrarFallo(clave) {
  const f = fallos.get(clave);
  if (f && Date.now() - f.t < VENTANA) { f.n++; f.t = Date.now(); } else fallos.set(clave, { n: 1, t: Date.now() });
}

function consulta(u, q) {
  const w = [], p = [];
  if (u.rol === 'jefe') { w.push('n.dependencia = ?'); p.push(u.dependencia); }
  else if (q.dependencia) { w.push('n.dependencia LIKE ?'); p.push('%' + q.dependencia + '%'); }
  if (FECHA.test(q.desde || '')) { w.push('n.fecha >= ?'); p.push(q.desde); }
  if (FECHA.test(q.hasta || '')) { w.push('n.fecha <= ?'); p.push(q.hasta); }
  if (CATEGORIAS[q.categoria]) { w.push('n.categoria = ?'); p.push(q.categoria); }
  if (ESTADOS.includes(q.estado)) { w.push('n.estado = ?'); p.push(q.estado); }
  if (q.q) { w.push('(n.numero LIKE ? OR n.personal LIKE ? OR n.descripcion LIKE ?)'); const l = '%' + q.q + '%'; p.push(l, l, l); }
  const sql = `SELECT n.*, a.nombre AS autor FROM novedades n JOIN usuarios a ON a.id = n.autor_id
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY n.fecha DESC, n.hora DESC, n.id DESC LIMIT 1000`;
  return db.prepare(sql).all(...p);
}
function novedadPara(u, id) {
  const n = db.prepare('SELECT n.*, a.nombre AS autor FROM novedades n JOIN usuarios a ON a.id = n.autor_id WHERE n.id = ?').get(id);
  if (!n || (u.rol === 'jefe' && n.dependencia !== u.dependencia)) fail(404, 'Novedad no encontrada');
  return n;
}
const celda = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
};
function transaccion(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

async function api(req, res, url) {
  const r = url.pathname.split('/').slice(2).filter(Boolean);
  const m = req.method;
  const q = Object.fromEntries(url.searchParams);
  if (m !== 'GET' && !(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'Tipo de contenido no admitido');

  if (r[0] === 'login' && m === 'POST') {
    const b = await leer(req);
    const clave = (req.socket.remoteAddress || '') + '|' + String(b.usuario || '').toLowerCase();
    controlarIntentos(clave);
    const u = db.prepare('SELECT * FROM usuarios WHERE usuario = ? AND activo = 1').get(String(b.usuario || ''));
    if (!u || !verificarClave(b.clave, u.clave)) { registrarFallo(clave); fail(401, 'Usuario o contraseña incorrectos'); }
    fallos.delete(clave);
    const tok = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sesiones (token, usuario_id, expira) VALUES (?, ?, ?)').run(sha(tok), u.id, Date.now() + DURACION_SESION);
    return enviar(res, 200, pub(u), { 'Set-Cookie': setCookie(tok, DURACION_SESION / 1000) });
  }

  const u = sesion(req);

  if (r[0] === 'logout' && m === 'POST') {
    db.prepare('DELETE FROM sesiones WHERE token = ?').run(sha(cookieSid(req)));
    return enviar(res, 200, { ok: true }, { 'Set-Cookie': setCookie('', 0) });
  }
  if (r[0] === 'yo' && m === 'GET') return enviar(res, 200, { usuario: pub(u), categorias: CATEGORIAS, estados: ESTADOS });
  if (r[0] === 'clave' && m === 'POST') {
    const b = await leer(req);
    if (!verificarClave(b.actual, u.clave)) fail(400, 'La contraseña actual no es correcta');
    const nueva = String(b.nueva || '');
    validarClave(nueva);
    if (nueva === b.actual) fail(400, 'La nueva contraseña debe ser distinta de la actual');
    db.prepare('UPDATE usuarios SET clave = ?, debe_cambiar = 0 WHERE id = ?').run(hashClave(nueva), u.id);
    db.prepare('DELETE FROM sesiones WHERE usuario_id = ? AND token <> ?').run(u.id, sha(cookieSid(req)));
    return enviar(res, 200, { ok: true });
  }
  if (u.debe_cambiar) fail(403, 'Debés cambiar tu contraseña antes de continuar');

  if (r[0] === 'novedades') {
    if (!r[1] && m === 'GET') return enviar(res, 200, consulta(u, q));
    if (!r[1] && m === 'POST') {
      if (u.rol === 'supervisor') fail(403, 'Tu rol no permite cargar novedades');
      const b = await leer(req);
      if (!CATEGORIAS[b.categoria]) fail(400, 'Categoría inválida');
      const dependencia = u.rol === 'jefe' ? u.dependencia : txt(b.dependencia, 80);
      const extra = txt(b.extra, 300), personal = txt(b.personal, 500), descripcion = txt(b.descripcion, 4000);
      if (!dependencia || !extra || !personal || !descripcion) fail(400, 'Completá todos los campos obligatorios');
      if (!FECHA.test(b.fecha || '') || !/^\d{2}:\d{2}$/.test(b.hora || '')) fail(400, 'Fecha u hora inválidas');
      const t = ahora();
      const anio = new Date().toLocaleDateString('sv-SE', { timeZone: TZ }).slice(0, 4);
      const res2 = transaccion(() => {
        const c = db.prepare('SELECT COUNT(*) AS c FROM novedades WHERE numero LIKE ?').get(anio + '-%').c;
        const numero = `${anio}-${String(c + 1).padStart(5, '0')}`;
        const info = db.prepare(`INSERT INTO novedades (numero, categoria, dependencia, fecha, hora, extra, personal, descripcion, autor_id, creado, actualizado)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(numero, b.categoria, dependencia, b.fecha, b.hora, extra, personal, descripcion, u.id, t, t);
        db.prepare('INSERT INTO historial (novedad_id, usuario_id, fecha, accion) VALUES (?, ?, ?, ?)').run(info.lastInsertRowid, u.id, t, 'Novedad registrada');
        return { id: Number(info.lastInsertRowid), numero };
      });
      return enviar(res, 201, res2);
    }
    const id = Number(r[1]);
    if (!Number.isInteger(id)) fail(404, 'No encontrado');
    const n = novedadPara(u, id);
    if (m === 'GET') {
      const historial = db.prepare(`SELECT h.fecha, h.accion, h.detalle, s.nombre AS usuario FROM historial h
        JOIN usuarios s ON s.id = h.usuario_id WHERE h.novedad_id = ? ORDER BY h.id`).all(id);
      return enviar(res, 200, { ...n, historial });
    }
    if (m === 'PATCH') {
      const b = await leer(req);
      const nota = txt(b.nota, 2000);
      const estado = b.estado || n.estado;
      if (!ESTADOS.includes(estado)) fail(400, 'Estado inválido');
      if (estado === n.estado && !nota) fail(400, 'No hay cambios para guardar');
      const t = ahora();
      transaccion(() => {
        db.prepare('UPDATE novedades SET estado = ?, actualizado = ? WHERE id = ?').run(estado, t, id);
        db.prepare('INSERT INTO historial (novedad_id, usuario_id, fecha, accion, detalle) VALUES (?, ?, ?, ?, ?)')
          .run(id, u.id, t, estado !== n.estado ? `Estado: ${n.estado} a ${estado}` : 'Actuación registrada', nota || null);
      });
      return enviar(res, 200, { ok: true });
    }
    fail(405, 'Método no permitido');
  }

  if (r[0] === 'exportar' && m === 'GET') {
    const cab = ['Número', 'Fecha', 'Hora', 'Dependencia', 'Categoría', 'Detalle de categoría', 'Personal involucrado', 'Descripción', 'Estado', 'Informada por', 'Registrada el'];
    const filas = consulta(u, q).map((n) => [n.numero, n.fecha, n.hora, n.dependencia, CATEGORIAS[n.categoria]?.nombre, n.extra, n.personal, n.descripcion, n.estado, n.autor, n.creado]);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="novedades.csv"', 'Cache-Control': 'no-store' });
    return res.end('\uFEFF' + [cab, ...filas].map((f) => f.map(celda).join(';')).join('\r\n'));
  }

  if (u.rol !== 'admin') fail(403, 'Acceso restringido a administradores');

  if (r[0] === 'respaldo' && m === 'GET') {
    const tmp = path.join(DATA_DIR, `respaldo-${Date.now()}.tmp`);
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const datos = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    const dia = new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="sigen-respaldo-${dia}.db"`, 'Cache-Control': 'no-store' });
    return res.end(datos);
  }

  if (r[0] === 'usuarios') {
    if (!r[1] && m === 'GET') return enviar(res, 200, db.prepare('SELECT id, usuario, nombre, rol, dependencia, activo FROM usuarios ORDER BY usuario').all());
    if (!r[1] && m === 'POST') {
      const b = await leer(req);
      const usuario = txt(b.usuario, 30), nombre = txt(b.nombre, 80), dependencia = txt(b.dependencia, 80) || null, clave = String(b.clave || '');
      if (!/^[a-z0-9._-]{3,30}$/i.test(usuario)) fail(400, 'Usuario inválido: 3 a 30 caracteres entre letras, números, punto, guion y guion bajo');
      if (!nombre || !ROLES.includes(b.rol)) fail(400, 'Nombre o rol inválido');
      if (b.rol === 'jefe' && !dependencia) fail(400, 'El jefe de escuadrón debe tener una dependencia asignada');
      validarClave(clave);
      try {
        db.prepare('INSERT INTO usuarios (usuario, nombre, clave, rol, dependencia) VALUES (?, ?, ?, ?, ?)').run(usuario, nombre, hashClave(clave), b.rol, dependencia);
      } catch { fail(409, 'Ese nombre de usuario ya existe'); }
      return enviar(res, 201, { ok: true });
    }
    const id = Number(r[1]);
    const t = Number.isInteger(id) && db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    if (!t) fail(404, 'Usuario no encontrado');
    if (m === 'PATCH') {
      const b = await leer(req);
      const activo = b.activo === undefined ? t.activo : (b.activo ? 1 : 0);
      const rol = b.rol ?? t.rol;
      const dependencia = b.dependencia === undefined ? t.dependencia : (txt(b.dependencia, 80) || null);
      if (id === u.id && (!activo || rol !== t.rol)) fail(400, 'No podés desactivarte ni cambiar tu propio rol');
      if (!ROLES.includes(rol)) fail(400, 'Rol inválido');
      if (rol === 'jefe' && !dependencia) fail(400, 'El jefe de escuadrón debe tener una dependencia asignada');
      db.prepare('UPDATE usuarios SET activo = ?, rol = ?, dependencia = ? WHERE id = ?').run(activo, rol, dependencia, id);
      if (b.clave) {
        validarClave(String(b.clave));
        db.prepare('UPDATE usuarios SET clave = ?, debe_cambiar = 1 WHERE id = ?').run(hashClave(String(b.clave)), id);
      }
      if (!activo || b.clave) db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(id);
      return enviar(res, 200, { ok: true });
    }
  }
  fail(404, 'No encontrado');
}

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
function estatico(res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const f = path.join(PUBLIC, path.normalize(p));
  if (!f.startsWith(PUBLIC + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('No encontrado'); }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}

const servidor = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (COOKIE_SEGURA) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else estatico(res, url);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) enviar(res, e.status || 500, { error: e.status ? e.message : 'Error interno del servidor' });
  }
});

setInterval(() => db.prepare('DELETE FROM sesiones WHERE expira < ?').run(Date.now()), 3600 * 1000).unref();
servidor.listen(PORT, () => console.log(`SIGEN en funcionamiento: http://localhost:${PORT}`));
process.on('SIGTERM', () => servidor.close(() => { db.close(); process.exit(0); }));
