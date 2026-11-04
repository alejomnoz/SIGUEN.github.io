'use strict';
const $ = (s) => document.querySelector(s);
const TZ = 'America/Argentina/Buenos_Aires';
const ROLES = { jefe: 'Jefe de escuadrón', supervisor: 'Supervisor', admin: 'Administrador' };
const S = { user: null, cats: {}, estados: [], vista: 'cargar', recargar: null };

function h(tag, attrs = {}, ...hijos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...hijos.flat(Infinity).filter((x) => x != null && x !== false));
  return e;
}
const campo = (etiqueta, control, clase = '') => h('label', { class: 'campo ' + clase }, h('span', {}, etiqueta), control);
const badge = (estado) => h('span', { class: 'badge b-' + estado.replace(/\s/g, '-') }, estado);
const fechaAR = (iso) => (iso ? new Date(iso).toLocaleString('es-AR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }) : '');
const dmy = (f) => f.split('-').reverse().join('/');
const hoy = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
const horaAhora = () => new Date().toLocaleTimeString('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const puedeCargar = () => S.user && S.user.rol !== 'supervisor';

function aviso(msg, tipo = 'error') {
  const e = $('#aviso');
  e.textContent = msg;
  e.className = 'visible ' + tipo;
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => (e.className = ''), 5000);
}

async function api(ruta, op = {}) {
  const r = await fetch('/api/' + ruta, {
    method: op.method || (op.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: op.body ? JSON.stringify(op.body) : undefined,
    credentials: 'same-origin',
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && !['login', 'yo'].includes(ruta)) { S.user = null; render(); throw new Error('La sesión venció. Ingresá nuevamente.'); }
  if (!r.ok) throw new Error(d.error || 'No se pudo completar la operación');
  return d;
}

async function iniciar() {
  try {
    const d = await api('yo');
    S.user = d.usuario; S.cats = d.categorias; S.estados = d.estados;
  } catch { S.user = null; }
}

function render() {
  const app = $('#app');
  app.replaceChildren();
  S.recargar = null;
  if (!S.user) return app.append(vistaLogin());
  if (S.user.debe_cambiar) return app.append(h('div', { class: 'centro' }, vistaClave(true)));
  if (S.vista === 'usuarios' && S.user.rol !== 'admin') S.vista = 'novedades';
  if (S.vista === 'cargar' && !puedeCargar()) S.vista = 'novedades';
  app.append(cabecera(), h('main', {}, VISTAS[S.vista]()));
}

async function salir() {
  try { await api('logout', { body: {} }); } catch { /* sin acción */ }
  S.user = null;
  render();
}

function vistaLogin() {
  const f = h('form', {
    class: 'tarjeta login',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api('login', { body: Object.fromEntries(new FormData(f)) });
        await iniciar();
        S.vista = puedeCargar() ? 'cargar' : 'novedades';
        render();
      } catch (x) { aviso(x.message); }
    },
  },
  h('h1', {}, 'SIGEN'), h('p', { class: 'sub' }, 'Sistema de Gestión de Novedades'),
  campo('Usuario', h('input', { name: 'usuario', autocomplete: 'username', required: true, autofocus: true })),
  campo('Contraseña', h('input', { name: 'clave', type: 'password', autocomplete: 'current-password', required: true })),
  h('button', { class: 'btn', type: 'submit' }, 'Ingresar'));
  return h('div', { class: 'centro' }, f);
}

function vistaClave(forzada) {
  const f = h('form', {
    class: 'tarjeta' + (forzada ? ' login' : ''),
    onsubmit: async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      if (d.nueva !== d.repetir) return aviso('Las contraseñas nuevas no coinciden');
      try {
        await api('clave', { body: { actual: d.actual, nueva: d.nueva } });
        aviso('Contraseña actualizada', 'ok');
        await iniciar();
        S.vista = puedeCargar() ? 'cargar' : 'novedades';
        render();
      } catch (x) { aviso(x.message); }
    },
  },
  h('h2', {}, forzada ? 'Elegí tu contraseña' : 'Cambiar contraseña'),
  forzada ? h('p', { class: 'nota' }, 'Es tu primer ingreso o un administrador restableció tu contraseña. Para continuar, definí una nueva.') : null,
  campo('Contraseña actual', h('input', { name: 'actual', type: 'password', autocomplete: 'current-password', required: true })),
  campo('Contraseña nueva (8 caracteres o más, con letras y números)', h('input', { name: 'nueva', type: 'password', autocomplete: 'new-password', minlength: 8, required: true })),
  campo('Repetir contraseña nueva', h('input', { name: 'repetir', type: 'password', autocomplete: 'new-password', required: true })),
  h('div', { class: 'acciones' }, forzada ? h('button', { class: 'btn sec', type: 'button', onclick: salir }, 'Salir') : null, h('button', { class: 'btn', type: 'submit' }, 'Guardar contraseña')));
  return f;
}

function cabecera() {
  const tabs = [['cargar', 'Cargar novedad', puedeCargar()], ['novedades', 'Novedades', true], ['diaria', 'Minuta diaria', true], ['usuarios', 'Usuarios', S.user.rol === 'admin'], ['cuenta', 'Mi cuenta', true]];
  return h('header', {},
    h('div', { class: 'marca' }, h('strong', {}, 'SIGEN'), h('span', {}, 'Gestión de Novedades')),
    h('nav', {}, tabs.filter((t) => t[2]).map(([k, t]) => h('button', { class: 'tab' + (S.vista === k ? ' activa' : ''), onclick: () => { S.vista = k; render(); } }, t))),
    h('div', { class: 'usuario' }, h('span', {}, `${S.user.nombre} (${ROLES[S.user.rol]}${S.user.dependencia ? ', ' + S.user.dependencia : ''})`), h('button', { class: 'btn sec chico', onclick: salir }, 'Salir')));
}

function vistaCargar() {
  const cat = h('select', { name: 'categoria', required: true }, Object.entries(S.cats).map(([k, c]) => h('option', { value: k }, c.nombre)));
  const etiqueta = h('span', {});
  const sincronizar = () => { etiqueta.textContent = S.cats[cat.value].extra + ' *'; };
  cat.addEventListener('change', sincronizar);
  sincronizar();
  const dep = S.user.rol === 'jefe'
    ? h('input', { name: 'dependencia', value: S.user.dependencia, readonly: true })
    : h('input', { name: 'dependencia', required: true, maxlength: 80, placeholder: 'Ejemplo: Escuadrón A' });
  const f = h('form', {
    class: 'tarjeta form',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await api('novedades', { body: Object.fromEntries(new FormData(f)) });
        aviso('Novedad registrada. Minuta Nº ' + r.numero, 'ok');
        render();
        abrirDetalle(r.id);
      } catch (x) { aviso(x.message); }
    },
  },
  h('h2', { class: 'ancho' }, 'Nueva novedad'),
  campo('Dependencia', dep),
  campo('Tipo de novedad', cat),
  h('label', { class: 'campo' }, etiqueta, h('input', { name: 'extra', required: true, maxlength: 300 })),
  campo('Fecha del hecho', h('input', { name: 'fecha', type: 'date', required: true, value: hoy(), max: hoy() })),
  campo('Hora', h('input', { name: 'hora', type: 'time', required: true, value: horaAhora() })),
  campo('Personal involucrado *', h('input', { name: 'personal', required: true, maxlength: 500, placeholder: 'Grado, apellido y nombre' }), 'ancho'),
  campo('Descripción de la novedad *', h('textarea', { name: 'descripcion', required: true, maxlength: 4000 }), 'ancho'),
  h('p', { class: 'nota ancho' }, 'La novedad se registra con estado Informada, a tu nombre y con fecha y hora del sistema. Después podés actualizar su seguimiento.'),
  h('div', { class: 'ancho acciones' }, h('button', { class: 'btn', type: 'submit' }, 'Registrar y generar minuta')));
  return f;
}

function vistaNovedades() {
  const opc = (txt0, lista) => [h('option', { value: '' }, txt0), ...lista];
  const exp = h('a', { class: 'btn sec', href: '#', onclick: () => { exp.href = '/api/exportar?' + params(); } }, 'Exportar a CSV');
  const f = h('form', { class: 'filtros', onsubmit: (e) => { e.preventDefault(); buscar(); } },
    campo('Desde', h('input', { type: 'date', name: 'desde' })),
    campo('Hasta', h('input', { type: 'date', name: 'hasta' })),
    campo('Tipo', h('select', { name: 'categoria' }, opc('Todos', Object.entries(S.cats).map(([k, c]) => h('option', { value: k }, c.nombre))))),
    campo('Estado', h('select', { name: 'estado' }, opc('Todos', S.estados.map((e) => h('option', { value: e }, e))))),
    S.user.rol !== 'jefe' ? campo('Dependencia', h('input', { name: 'dependencia' })) : null,
    campo('Buscar', h('input', { name: 'q', placeholder: 'Número, personal o texto' })),
    h('button', { class: 'btn', type: 'submit' }, 'Filtrar'), exp);
  const params = () => new URLSearchParams([...new FormData(f)].filter(([, v]) => v)).toString();
  const cuerpo = h('div', { class: 'tabla-wrap' });
  async function buscar() {
    try {
      const filas = await api('novedades?' + params());
      cuerpo.replaceChildren(filas.length
        ? h('table', {}, h('thead', {}, h('tr', {}, ['Número', 'Fecha y hora', 'Dependencia', 'Tipo', 'Personal', 'Estado'].map((t) => h('th', {}, t)))),
          h('tbody', {}, filas.map((n) => h('tr', { class: 'fila', onclick: () => abrirDetalle(n.id) },
            h('td', {}, h('button', { class: 'enlace', onclick: (e) => { e.stopPropagation(); abrirDetalle(n.id); } }, n.numero)),
            h('td', {}, dmy(n.fecha) + ' ' + n.hora), h('td', {}, n.dependencia), h('td', {}, S.cats[n.categoria]?.nombre), h('td', {}, n.personal), h('td', {}, badge(n.estado))))))
        : h('p', { class: 'nota' }, 'No hay novedades para los filtros indicados.'));
    } catch (x) { aviso(x.message); }
  }
  S.recargar = buscar;
  buscar();
  return h('div', {}, h('div', { class: 'tarjeta' }, h('h2', {}, 'Novedades registradas'), f), h('div', { class: 'tarjeta' }, cuerpo));
}

function minutaNodo(n) {
  const fila = (k, v) => h('tr', {}, h('th', {}, k), h('td', {}, v));
  const c = S.cats[n.categoria];
  return h('article', { class: 'minuta' },
    h('h2', {}, 'Minuta de novedad Nº ' + n.numero),
    h('table', { class: 'ficha' },
      fila('Dependencia', n.dependencia), fila('Fecha y hora del hecho', `${dmy(n.fecha)} ${n.hora} hs`),
      fila('Tipo de novedad', c?.nombre), fila(c?.extra, n.extra), fila('Personal involucrado', n.personal),
      fila('Descripción', n.descripcion), fila('Estado', n.estado), fila('Informada por', `${n.autor}, el ${fechaAR(n.creado)}`)),
    h('h3', {}, 'Actuaciones'),
    h('ul', { class: 'hist' }, n.historial.map((x) => h('li', {}, h('b', {}, `${fechaAR(x.fecha)}, ${x.usuario}: `), x.accion + (x.detalle ? '. ' + x.detalle : '')))));
}

function imprimir(nodo) {
  const z = $('#impresion');
  z.replaceChildren(nodo.cloneNode(true));
  window.addEventListener('afterprint', () => z.replaceChildren(), { once: true });
  window.print();
}

async function abrirDetalle(id) {
  let n;
  try { n = await api('novedades/' + id); } catch (x) { return aviso(x.message); }
  const dlg = h('dialog', { class: 'modal' });
  const minuta = minutaNodo(n);
  const sel = h('select', { name: 'estado' }, S.estados.map((e) => h('option', { value: e, selected: e === n.estado }, e)));
  const nota = h('textarea', { maxlength: 2000, placeholder: 'Detalle de la actuación o novedad en el seguimiento' });
  const form = h('form', {
    class: 'seguimiento',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api('novedades/' + id, { method: 'PATCH', body: { estado: sel.value, nota: nota.value } });
        aviso('Seguimiento guardado', 'ok');
        dlg.close();
        if (S.recargar) S.recargar();
        abrirDetalle(id);
      } catch (x) { aviso(x.message); }
    },
  },
  h('h3', {}, 'Actualizar seguimiento'), campo('Estado', sel), campo('Actuación', nota),
  h('div', { class: 'acciones' }, h('button', { class: 'btn', type: 'submit' }, 'Guardar seguimiento')));
  dlg.append(minuta, form, h('div', { class: 'acciones' },
    h('button', { class: 'btn sec', type: 'button', onclick: () => imprimir(minuta) }, 'Imprimir o guardar como PDF'),
    h('button', { class: 'btn sec', type: 'button', onclick: () => dlg.close() }, 'Cerrar')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

function vistaDiaria() {
  const fecha = h('input', { type: 'date', value: hoy(), onchange: () => cargar() });
  const cont = h('div', { class: 'tarjeta' });
  let doc = null;
  const imp = h('button', { class: 'btn sec', type: 'button', onclick: () => doc && imprimir(doc) }, 'Imprimir o guardar como PDF');
  async function cargar() {
    if (!fecha.value) return;
    try {
      const filas = await api(`novedades?desde=${fecha.value}&hasta=${fecha.value}`);
      const grupos = {};
      filas.slice().reverse().forEach((n) => (grupos[n.dependencia] ||= []).push(n));
      doc = h('article', { class: 'minuta' },
        h('h2', {}, 'Minuta general de novedades del ' + dmy(fecha.value)),
        h('p', {}, `Total de novedades informadas: ${filas.length}`),
        Object.entries(grupos).map(([dep, lista]) => [
          h('h3', {}, `${dep} (${lista.length})`),
          lista.map((n) => h('div', { class: 'item' },
            h('b', {}, `${n.numero}, ${n.hora} hs, ${S.cats[n.categoria]?.nombre}, ${n.estado}`), '\n',
            `${S.cats[n.categoria]?.extra}: ${n.extra}\nPersonal: ${n.personal}\n${n.descripcion}`)),
        ]),
        filas.length ? null : h('p', { class: 'nota' }, 'No se informaron novedades en la fecha seleccionada.'),
        h('p', { class: 'nota' }, `Emitida por ${S.user.nombre} el ${fechaAR(new Date().toISOString())}`));
      cont.replaceChildren(doc);
    } catch (x) { aviso(x.message); }
  }
  cargar();
  return h('div', {}, h('div', { class: 'tarjeta barra' }, campo('Fecha', fecha), imp), cont);
}

function vistaUsuarios() {
  const cont = h('div', { class: 'tarjeta tabla-wrap' });
  async function listar() {
    try {
      const us = await api('usuarios');
      cont.replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, ['Usuario', 'Nombre', 'Rol', 'Dependencia', 'Estado', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, us.map((x) => h('tr', {},
          h('td', {}, x.usuario), h('td', {}, x.nombre), h('td', {}, ROLES[x.rol]), h('td', {}, x.dependencia || ''), h('td', {}, x.activo ? 'Activo' : 'Inactivo'),
          h('td', { class: 'acciones' },
            h('button', { class: 'btn sec chico', onclick: () => cambiar(x.id, { activo: !x.activo }) }, x.activo ? 'Desactivar' : 'Activar'),
            h('button', { class: 'btn sec chico', onclick: () => {
              const c = prompt(`Contraseña temporal para ${x.usuario} (8 caracteres o más, con letras y números). Deberá cambiarla al ingresar.`);
              if (c) cambiar(x.id, { clave: c });
            } }, 'Restablecer contraseña')))))));
    } catch (e) { aviso(e.message); }
  }
  async function cambiar(id, body) {
    try { await api('usuarios/' + id, { method: 'PATCH', body }); aviso('Cambios guardados', 'ok'); listar(); } catch (e) { aviso(e.message); }
  }
  const rol = h('select', { name: 'rol' }, Object.entries(ROLES).map(([k, v]) => h('option', { value: k }, v)));
  const f = h('form', {
    class: 'tarjeta form',
    onsubmit: async (e) => {
      e.preventDefault();
      try { await api('usuarios', { body: Object.fromEntries(new FormData(f)) }); aviso('Usuario creado', 'ok'); f.reset(); listar(); } catch (x) { aviso(x.message); }
    },
  },
  h('h2', { class: 'ancho' }, 'Nuevo usuario'),
  campo('Usuario', h('input', { name: 'usuario', required: true, maxlength: 30, autocomplete: 'off' })),
  campo('Nombre y apellido', h('input', { name: 'nombre', required: true, maxlength: 80 })),
  campo('Rol', rol),
  campo('Dependencia (obligatoria para jefes)', h('input', { name: 'dependencia', maxlength: 80, placeholder: 'Ejemplo: Escuadrón A' })),
  campo('Contraseña temporal', h('input', { name: 'clave', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
  h('div', { class: 'ancho acciones' }, h('button', { class: 'btn', type: 'submit' }, 'Crear usuario')));
  listar();
  return h('div', {}, f, h('h2', {}, 'Usuarios'), cont,
    h('div', { class: 'tarjeta barra' }, h('a', { class: 'btn sec', href: '/api/respaldo' }, 'Descargar copia de seguridad de la base de datos')));
}

const VISTAS = { cargar: vistaCargar, novedades: vistaNovedades, diaria: vistaDiaria, usuarios: vistaUsuarios, cuenta: () => vistaClave(false) };

iniciar().then(() => { S.vista = puedeCargar() ? 'cargar' : 'novedades'; render(); });
