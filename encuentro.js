(() => {
  'use strict';
  const base = document.body.dataset.checklist;
  if (!base) return;
  const $ = selector => document.querySelector(selector);
  let state = null, busy = false, polling = false, received = 0, failure = '', notice = '', mutationEpoch = 0;
  const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const node = (tag, text, cls) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };
  const date = value => new Date(value).toLocaleString('es-AR', {timeZone:'America/Argentina/Buenos_Aires', hour12:false});
  const signature = value => value?.control ? value.control.id + ':' + value.control.revision : 'empty';
  const branchKey = person => JSON.stringify([person.empresa, person.sucursal]);
  const matchesModality = person => !$('#modalidad').value || normalize(person.modalidad) === $('#modalidad').value;
  try { $('#responsable').value = localStorage.getItem('encuentro-responsable') || ''; } catch (_) { /* Sin almacenamiento local, se usa el campo. */ }
  $('#responsable').addEventListener('input', () => {
    try { localStorage.setItem('encuentro-responsable', $('#responsable').value); } catch (_) { /* El guardado del control es en el servidor. */ }
  });

  function status() {
    const stale = Boolean(failure) || (received && Date.now() - received > 15000);
    $('#encuentro-status').className = stale ? 'check-status error' : 'check-status';
    $('#encuentro-status').textContent = stale
      ? (failure || 'No se pudo actualizar el control.') + ' Las confirmaciones mostradas pueden estar desactualizadas.'
      : busy ? 'Guardando en el servidor…' : received ? (notice ? notice + ' · ' : '') + 'Última sincronización: ' + date(new Date(received).toISOString()) + '. Consulta cada 5 segundos.' : 'Consultando el control guardado…';
    $('#check-content').classList.toggle('check-stale', Boolean(stale));
    if (document.body.dataset.view === 'encuentro') {
      $('#connection').className = 'connection ' + (stale ? 'stale' : received ? 'live' : '');
      $('#connection-label').textContent = stale ? 'Control sin actualizar' : received ? 'Control sincronizado' : 'Conectando';
    }
  }

  function render() {
    const active = state?.control && !state.control.cierre;
    $('#iniciar-control').hidden = Boolean(active);
    $('#iniciar-control').disabled = busy || !received;
    $('#iniciar-control').textContent = state?.control ? 'Iniciar nuevo recuento' : 'Iniciar recuento';
    $('#cerrar-control').hidden = !active;
    $('#cerrar-control').disabled = busy;
    $('#check-content').hidden = !state?.control;
    $('.check-totals').hidden = !state?.control;
    if (!state?.control) {
      $('#control-fecha').textContent = 'No hay un recuento guardado. Iniciar crea un control para todas las sucursales, sin aplicar los filtros de asistencia.';
      status(); return;
    }
    $('#control-fecha').textContent = (active ? 'Control abierto' : 'Control cerrado · solo lectura') +
      ' · Inicio: ' + date(state.control.inicio) + ' · Responsable inicial: ' + state.control.responsable +
      ' · Lista tomada: ' + date(state.control.fuente) + (state.control.cierre ? ' · Cierre: ' + date(state.control.cierre) : '');
    const branches = new Map();
    [...state.personas, ...state.disponibles].forEach(person => branches.set(branchKey(person), {nombre:person.sucursal, empresa:person.empresa}));
    document.dispatchEvent(new CustomEvent('encuentro-sucursales', {detail:[...branches.values()]}));
    renderPeople(); renderAvailable(); status();
  }

  function renderPeople() {
    if (!state?.control) return;
    const selected = $('#sucursal').value, query = normalize($('#check-buscar').value), pending = $('#solo-pendientes').checked;
    const scoped = state.personas.filter(person => (!selected || branchKey(person) === selected) && matchesModality(person));
    const found = scoped.filter(person => person.encontrado).length;
    $('#check-pendientes').textContent = scoped.length - found;
    $('#check-encontrados').textContent = found;
    $('#check-total').textContent = scoped.length;
    $('#check-alcance').textContent = 'Totales según sucursal y modalidad: ' + scoped.length + ' personas. El control completo conserva ' + state.totales.total + ' personas y ' + state.totales.pendientes + ' pendientes.';
    const people = scoped.filter(person =>
      (!pending || !person.encontrado) && normalize(person.nombre + ' ' + person.sector).includes(query));
    const groups = new Map();
    people.forEach(person => { const key = branchKey(person); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(person); });
    const fragment = document.createDocumentFragment();
    groups.forEach(persons => {
      const card = node('article', undefined, 'branch');
      const header = node('div', undefined, 'branch-head');
      const title = node('div'); title.append(node('h3', persons[0].sucursal), node('p', persons[0].empresa));
      header.append(title, node('span', persons.length + ' en esta vista', 'chip')); card.append(header);
      const list = node('ul', undefined, 'people check-people');
      persons.forEach(person => {
        const row = node('li', undefined, 'check-person' + (person.encontrado ? ' found' : ''));
        const label = node('label', undefined, 'check-label');
        const box = node('input'); box.type = 'checkbox'; box.checked = person.encontrado;
        box.disabled = busy || Boolean(state.control.cierre); box.dataset.key = person.clave;
        box.setAttribute('aria-label', 'Confirmar en el punto: ' + person.nombre + ' · ' + person.sector);
        box.addEventListener('change', async () => {
          const found = box.checked; box.checked = person.encontrado;
          await action('marcar', {clave:person.clave, encontrado:found, revision:person.revision});
          const next = [...document.querySelectorAll('.check-label input')].find(el => el.dataset.key === person.clave);
          if (next) next.focus();
        });
        const text = node('span', undefined, 'check-person-info');
        text.append(node('strong', person.nombre), node('span', person.sector + ' · ' + person.modalidad));
        text.append(node('small', person.encontrado ? 'Confirmado por ' + person.responsable + ' · ' + date(person.confirmado) : 'Pendiente de confirmar en el punto'));
        label.append(box, text); row.append(label); list.append(row);
      });
      card.append(list); fragment.append(card);
    });
    if (!people.length) fragment.append(node('p', 'No hay personas para estos filtros. El total del control se muestra arriba.', 'empty-state'));
    $('#check-list').replaceChildren(fragment);
    $('#check-visible').textContent = people.length + ' personas visibles de ' + scoped.length + ' según sucursal y modalidad.';
  }

  function renderAvailable() {
    if (!state?.control) return;
    $('#incorporar-panel').hidden = Boolean(state.control.cierre);
    const query = normalize($('#agregar-buscar').value);
    const selected = $('#sucursal').value;
    const fragment = document.createDocumentFragment();
    const list = state.disponibles.filter(person => matchesModality(person) && (!selected || branchKey(person) === selected) &&
      normalize(person.nombre + ' ' + person.sucursal + ' ' + person.sector).includes(query));
    list.forEach(person => {
      const row = node('div', undefined, 'add-row');
      const info = node('div'); info.append(node('strong', person.nombre), node('p', person.sucursal + ' · ' + person.sector + ' · ' +
        (person.estado === 'con_salida' ? 'Con salida al iniciar' : person.estado === 'solo_salida' ? 'Salida sin ingreso' : 'Sin fichadas al iniciar')));
      const button = node('button', 'Incorporar'); button.type = 'button'; button.disabled = busy;
      button.setAttribute('aria-label', 'Incorporar a ' + person.nombre + ' · ' + person.sector);
      button.addEventListener('click', () => action('incorporar', {clave:person.clave, revision:person.revision}));
      row.append(info, button); fragment.append(row);
    });
    if (!list.length) fragment.append(node('p', 'No hay personal disponible para incorporar con la sucursal y búsqueda seleccionadas.', 'empty-state'));
    $('#agregar-list').replaceChildren(fragment);
  }

  async function poll(force = false) {
    if (busy || polling) return;
    polling = true;
    const epoch = mutationEpoch;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(base, {cache:'no-store', signal:controller.signal});
      if (!response.ok) throw new Error('No se pudo leer el control.');
      const result = await response.json();
      if (!result || !Object.prototype.hasOwnProperty.call(result, 'control')) throw new Error('Respuesta incompatible.');
      // An older GET must never replace a more recent POST result.
      if (!busy && epoch === mutationEpoch && (!state?.control || !result.control || result.control.id !== state.control.id || result.control.revision >= state.control.revision)) {
        const changed = force || signature(result) !== signature(state);
        state = result; received = Date.now(); failure = '';
        if (changed) render(); else status();
      }
    } catch (_) {
      failure = 'Sin conexión con el control guardado.'; status();
    } finally { clearTimeout(timeout); polling = false; }
  }

  async function action(name, extra = {}) {
    if (busy) return;
    const actor = $('#responsable').value.trim();
    if (actor.length < 2) { notice = 'Ingresá tu nombre como responsable antes de guardar.'; status(); $('#responsable').focus(); return; }
    const id = state?.control?.id;
    mutationEpoch += 1; busy = true; notice = ''; render();
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(base + '/' + name, {method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({responsable:actor, control_id:id, ...extra}), signal:controller.signal});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'No se pudo guardar.');
      state = result; received = Date.now(); failure = ''; notice = 'Guardado en el servidor · ' + date(new Date().toISOString());
    } catch (error) {
      failure = (error.name === 'AbortError' ? 'No se pudo confirmar el guardado a tiempo.' : error.message) + ' Actualizá el control antes de repetir la acción.';
    } finally {
      clearTimeout(timeout); busy = false; render();
      // Reconcile uncertain network outcomes without retrying a mutation.
      if (failure) { const error = failure; await poll(true); notice = error; status(); }
    }
  }
  $('#iniciar-control').addEventListener('click', () => action('iniciar'));
  $('#cerrar-control').addEventListener('click', () => {
    if (!state?.control) return;
    if (window.confirm('Cerrar este control con ' + state.totales.pendientes + ' pendientes. Quedará guardado en solo lectura; cerrar no confirma que todas las personas estén a salvo.'))
      action('cerrar', {revision:state.control.revision});
  });
  $('#check-buscar').addEventListener('input', renderPeople);
  document.addEventListener('macro-sucursal', () => { renderPeople(); renderAvailable(); });
  $('#solo-pendientes').addEventListener('change', renderPeople);
  $('#agregar-buscar').addEventListener('input', renderAvailable);
  document.addEventListener('abrir-encuentro', () => poll(true));
  window.addEventListener('offline', () => { failure = 'Este dispositivo no tiene conexión. No se pueden guardar confirmaciones.'; status(); });
  window.addEventListener('online', () => poll(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && document.body.dataset.view === 'encuentro') poll(true); });
  setInterval(() => { if (document.body.dataset.view === 'encuentro' && !document.hidden) poll(); }, 5000);
  setInterval(status, 1000);
  poll(true);
})();
