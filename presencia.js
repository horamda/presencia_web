(() => {
'use strict';
const $ = selector => document.querySelector(selector);
const endpoint = new URL(document.body.dataset.endpoint, location.origin);
const empresa = new URLSearchParams(location.search).get('empresa_id');
if (empresa) endpoint.searchParams.set('empresa_id', empresa);
let data = null, busy = false, timer, nextPoll = 0, receivedAt = 0, failure = '';
let currentView = 'presencia';
let encounterBranches = [], savedBranch = '';
try { savedBranch = sessionStorage.getItem('presencia-sucursal') || ''; } catch (_) {}
const normalize = value => String(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const branchKey = branch => JSON.stringify([branch.empresa, branch.nombre]);
const matchesModality = person => !$('#modalidad').value || normalize(person.modalidad) === $('#modalidad').value;
try { $('#modalidad').value = sessionStorage.getItem('presencia-modalidad') || ''; } catch (_) {}

// Sonido de alerta compartido con encuentro.js (cargado después de este script).
let soundOn = true;
try { soundOn = localStorage.getItem('presencia-sonido') !== '0'; } catch (_) {}
let audioCtx = null;
function beep(freq = 880, duration = 180) {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.type = 'sine'; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration / 1000);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + duration / 1000 + 0.03);
  } catch (_) { /* Audio no disponible en este navegador/dispositivo. */ }
}
function chime() { beep(660, 140); setTimeout(() => beep(990, 220), 150); }
window.presenciaSonido = { beep, chime, activo: () => soundOn };
function syncSoundButton() {
  const button = $('#alternar-sonido');
  button.setAttribute('aria-pressed', String(soundOn));
  button.textContent = soundOn ? '🔊' : '🔇';
  button.setAttribute('aria-label', soundOn ? 'Silenciar alertas sonoras' : 'Activar alertas sonoras');
}
syncSoundButton();
$('#alternar-sonido').addEventListener('click', () => {
  soundOn = !soundOn;
  try { localStorage.setItem('presencia-sonido', soundOn ? '1' : '0'); } catch (_) {}
  syncSoundButton();
  if (soundOn) beep(880, 120);
});

// Modo de texto grande para ver la pantalla de lejos (punto de encuentro, TV, etc).
let largeText = false;
try { largeText = localStorage.getItem('presencia-texto-grande') === '1'; } catch (_) {}
function syncLargeText() {
  document.body.classList.toggle('large-text', largeText);
  const button = $('#alternar-texto');
  button.setAttribute('aria-pressed', String(largeText));
  button.setAttribute('aria-label', largeText ? 'Desactivar texto grande' : 'Activar texto grande para ver de lejos');
}
syncLargeText();
$('#alternar-texto').addEventListener('click', () => { largeText = !largeText;
  try { localStorage.setItem('presencia-texto-grande', largeText ? '1' : '0'); } catch (_) {}
  syncLargeText();
});

// Exportar CSV: utilidad compartida con encuentro.js.
function csvEscape(value) {
  const text = String(value ?? '');
  return /[",;\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
function downloadCSV(filename, headers, rows) {
  const lines = [headers.map(csvEscape).join(';'), ...rows.map(row => row.map(csvEscape).join(';'))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], {type: 'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const link = element('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
window.presenciaCSV = downloadCSV;

function updateBranchOptions() {
  const selection = $('#sucursal').value || savedBranch;
  const options = document.createDocumentFragment(), all = element('option', 'Todas las sucursales');
  all.value = ''; options.append(all);
  const branches = new Map();
  [...(data?.sucursales || []), ...encounterBranches].forEach(branch => branches.set(branchKey(branch), branch));
  branches.forEach((branch, key) => { const option = element('option', branch.nombre); option.value = key; options.append(option); });
  $('#sucursal').replaceChildren(options);
  if (branches.has(selection)) $('#sucursal').value = selection;
  updateTotals();
}
function updateTotals() {
  const selected = $('#sucursal').value;
  document.body.classList.toggle('single-branch', Boolean(selected));
  $('#macro-alcance').textContent = selected ? 'Todo el control visible corresponde a ' + $('#sucursal').selectedOptions[0].textContent + '.' : 'Mostrando todas las sucursales en las tres vistas.';
  if (!data) return;
  const branches = data.sucursales.filter(branch => !selected || branchKey(branch) === selected);
  const persons = branches.flatMap(branch => branch.personas).filter(matchesModality);
  const validated = persons.filter(person => person.ingreso_validado).length;
  $('#validados').textContent = validated;
  $('#verificar').textContent = persons.length - validated;
  $('#total').textContent = persons.length;
  const missing = branches.flatMap(branch => branch.sin_ingreso_personas).filter(matchesModality);
  $('#sin-ingreso-count').textContent = missing.length;
  $('#missing-total').textContent = missing.length;
  $('#missing-none').textContent = missing.filter(person => person.estado !== 'solo_salida').length;
  $('#missing-exit').textContent = missing.filter(person => person.estado === 'solo_salida').length;
}
let wasStale = false;
function updateStatus() {
  if (currentView === 'encuentro') return;
  const stale = Boolean(failure) || (data && Date.now() - receivedAt > 70000);
  if (stale && !wasStale) beep(320, 260);
  wasStale = Boolean(stale);
  $('#connection').className = 'connection ' + (stale ? 'stale' : data ? 'live' : '');
  $('#connection-label').textContent = stale ? 'Sin actualizar' : data ? 'Conectado' : 'Conectando';
  $('#freshness').classList.toggle('stale', Boolean(stale));
  document.body.classList.toggle('stale-data', Boolean(stale));
  const message = stale
    ? (failure || 'La consulta quedó desactualizada.') + (data ? ' Se conserva la última lista; puede haber cambiado.' : ' Todavía no hay una lista disponible.')
    : busy ? 'Actualizando la lista…' : data ? 'Datos recibidos · actualización cada 30 segundos' : 'Consultando el sistema de asistencia…';
  if ($('#estado').textContent !== message) $('#estado').textContent = message;
}
function buildBranchCard(branch, missing, query) {
  const people = (missing ? branch.sin_ingreso_personas : branch.personas).filter(matchesModality).filter(person => !query || normalize(person.nombre + ' ' + person.sector).includes(query));
  if (query && !people.length) return null;
  const card = element('article', undefined, 'branch');
  const heading = element('div', undefined, 'branch-head');
  const title = element('div');
  title.append(element('h3', branch.nombre), element('p', branch.empresa));
  const counter = element('div', undefined, 'branch-count');
  counter.append(element('strong', people.length), element('span', query ? 'coincidencias' : missing ? 'sin ingreso hoy' : 'sin salida registrada'));
  heading.append(title, counter); card.append(heading);
  const meta = element('div', undefined, 'branch-meta');
  const validated = people.filter(person => person.ingreso_validado).length;
  meta.append(element('span', validated + ' ingresos validados', 'chip'),
    element('span', (people.length - validated) + ' ubicaciones a verificar', 'chip uncertain'));
  if (!missing) card.append(meta);
  const sectors = new Map();
  people.forEach(person => {
    if (!sectors.has(person.sector)) sectors.set(person.sector, []);
    sectors.get(person.sector).push(person);
  });
  sectors.forEach((persons, sector) => {
    const section = element('section', undefined, 'sector');
    const sectionHeading = element('div', undefined, 'sector-heading');
    sectionHeading.append(element('h4', sector), element('span', persons.length + (persons.length === 1 ? ' persona' : ' personas')));
    const list = element('ul', undefined, 'people');
    persons.forEach(person => {
      const row = element('li', undefined, 'person'), info = element('div', undefined, 'person-info');
      info.append(element('span', person.nombre, 'person-name'));
      const state = element('div', undefined, 'person-state');
      state.append(element('span', missing ? (person.estado === 'solo_salida' ? 'Salida sin ingreso' : 'Sin fichadas hoy') : person.ingreso_validado ? 'Ingreso validado' : 'Ubicación a verificar', 'badge' + (person.ingreso_validado && !missing ? '' : ' uncertain')),
        element('span', person.modalidad));
      info.append(state);
      const time = element('div', 'Ingreso', 'person-time'), parts = person.ultimo_ingreso.split(':');
      time.append(element('strong', parts.length >= 2 ? parts[0].padStart(2, '0') + ':' + parts[1] : 'Sin hora'));
      row.append(info); if (!missing) row.append(time); list.append(row);
    });
    section.append(sectionHeading, list); card.append(section);
  });
  if (!people.length) card.append(element('p', $('#modalidad').value ? 'No hay personas para la modalidad seleccionada en esta lista.' : missing ? 'Todos los empleados asignados registraron un ingreso hoy.' : 'Sin ingresos pendientes de salida en las fichadas de hoy. Esto no confirma que el depósito esté vacío.', 'empty-branch'));
  card.append(element('p', 'Sucursal completa · ' + branch.empleados + ' empleados asignados · ' + branch.vinieron + ' con ingreso hoy · ' + branch.retirados + ' con salida', 'branch-foot'));
  return {card, count: people.length};
}
function finishRender(visible, query, selected, missing) {
  $('#resultado').textContent = visible + (visible === 1 ? ' persona' : ' personas') +
    (query || selected ? ' en esta vista filtrada.' : missing ? ' sin ingreso registrado · no confirma una ausencia' : ' con ingreso sin salida · agrupadas por sector');
  $('#vacio').hidden = $('#sucursales').childElementCount > 0;
  $('#vacio').textContent = query ? 'No hay coincidencias. Probá otro nombre o limpiá los filtros.' : 'No hay sucursales con empleados activos para esta consulta.';
}
const RENDER_CHUNK_THRESHOLD = 300;
let renderToken = 0;
function render() {
  if (!data || currentView === 'encuentro') return;
  const missing = currentView === 'sin-ingreso';
  const query = normalize($('#buscar').value.trim()), selected = $('#sucursal').value;
  const branches = data.sucursales.filter(branch => !selected || branchKey(branch) === selected);
  const totalCandidates = branches.reduce((sum, branch) => sum + (missing ? branch.sin_ingreso_personas.length : branch.personas.length), 0);
  const container = $('#sucursales');
  container.replaceChildren();
  const token = ++renderToken;
  let visible = 0;
  if (totalCandidates <= RENDER_CHUNK_THRESHOLD) {
    const fragment = document.createDocumentFragment();
    branches.forEach(branch => {
      const result = buildBranchCard(branch, missing, query);
      if (result) { fragment.append(result.card); visible += result.count; }
    });
    container.append(fragment);
    finishRender(visible, query, selected, missing);
    return;
  }
  // Plantel inusualmente grande: se arma de a una sucursal por frame para no trabar el hilo principal.
  let index = 0;
  const step = () => {
    if (token !== renderToken) return;
    if (index < branches.length) {
      const result = buildBranchCard(branches[index], missing, query);
      if (result) { container.append(result.card); visible += result.count; }
      index += 1;
      requestAnimationFrame(step);
    } else {
      finishRender(visible, query, selected, missing);
    }
  };
  requestAnimationFrame(step);
}
function validatePayload(payload) {
  if (!payload || !Array.isArray(payload.sucursales) || !payload.totales || !Number.isFinite(Date.parse(payload.actualizado))) throw new Error('La consulta devolvió una lista incompatible.');
  const keys = ['empleados', 'presentes', 'vinieron', 'retirados', 'sin_ingreso'];
  const validCounts = row => row && keys.every(key => Number.isInteger(row[key]) && row[key] >= 0);
  if (!validCounts(payload.totales) || payload.sucursales.some(branch =>
    !validCounts(branch) || !Array.isArray(branch.sin_ingreso_personas) || branch.sin_ingreso_personas.length !== branch.sin_ingreso || !Array.isArray(branch.personas) || branch.personas.length !== branch.presentes || [...branch.personas, ...branch.sin_ingreso_personas].some(person =>
      typeof person.ingreso_validado !== 'boolean' ||
      ['clave', 'estado', 'nombre', 'sector', 'modalidad', 'modalidad_codigo', 'ultimo_ingreso'].some(key => typeof person[key] !== 'string')
    ))) throw new Error('La lista de personas no coincide con los totales. Reiniciar la consulta si fue actualizada.');
  const persons = payload.sucursales.flatMap(branch => branch.personas);
  if (persons.length !== payload.totales.presentes) throw new Error('Los totales de las sucursales no coinciden.');
}
function paintDates() {
  const updated = new Date(data.actualizado), tz = {timeZone: 'America/Argentina/Buenos_Aires'};
  $('#fecha').textContent = updated.toLocaleDateString('es-AR', {...tz, day: 'numeric', month: 'long', year: 'numeric'});
  $('#ultima').textContent = 'Última consulta: ' + updated.toLocaleDateString('es-AR', tz) + ' · ' + updated.toLocaleTimeString('es-AR', {...tz, hour12: false}) + ' (Argentina)';
}
function accept(payload) {
  validatePayload(payload);
  data = payload; receivedAt = Date.now();
  try { localStorage.setItem('presencia-cache', JSON.stringify(payload)); } catch (_) {}
  updateBranchOptions();
  document.dispatchEvent(new Event('macro-sucursal'));
  paintDates();
  render();
}
function restoreCache() {
  try {
    const raw = localStorage.getItem('presencia-cache');
    if (!raw) return;
    const cached = JSON.parse(raw);
    validatePayload(cached);
    data = cached;
    updateBranchOptions();
    document.dispatchEvent(new Event('macro-sucursal'));
    paintDates();
    render();
  } catch (_) { /* Caché corrupta o ausente: se ignora y se espera la primera consulta real. */ }
}
async function refresh() {
  if (busy) return;
  clearTimeout(timer); busy = true; $('#actualizar').disabled = true; updateStatus();
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(endpoint, {cache: 'no-store', signal: controller.signal});
    if (!response.ok) { const detail = await response.json().catch(() => ({})); throw new Error(detail.error || 'No se pudo consultar el sistema.'); }
    accept(await response.json()); failure = '';
  } catch (error) {
    failure = error.name === 'AbortError' ? 'El sistema no respondió a tiempo.' : error.message;
  } finally {
    clearTimeout(timeout); busy = false; $('#actualizar').disabled = false;
    nextPoll = Date.now() + 30000; timer = setTimeout(refresh, 30000); updateStatus();
  }
}
$('.filters').addEventListener('submit', event => event.preventDefault());
function setView(view) {
  currentView = view;
  document.body.dataset.view = view;
  ['presencia', 'sin-ingreso', 'encuentro'].forEach(key => $('#vista-' + key).setAttribute('aria-pressed', String(key === view)));
  $('.overview').hidden = view !== 'presencia';
  $('#missing-overview').hidden = view !== 'sin-ingreso';
  $('#freshness').hidden = view === 'encuentro';
  $('.roster').hidden = view === 'encuentro';
  $('#encuentro-panel').hidden = view !== 'encuentro';
  $('.legend').hidden = view !== 'presencia';
  $('.scope-note').hidden = view !== 'presencia';
  $('#csv').hidden = view === 'encuentro';
  $('h1').textContent = view === 'encuentro' ? 'Control en el punto de encuentro' : view === 'sin-ingreso' ? 'Personal sin ingreso registrado' : 'Personas con ingreso sin salida';
  $('.subtitle').textContent = view === 'encuentro' ? 'Confirmaciones compartidas y guardadas en este servidor.' : view === 'sin-ingreso' ? 'Control separado. No fichar no confirma que alguien haya faltado.' : 'Consultá nombres, sectores y la validación de ubicación de cada ingreso.';
  $('#roster-title').textContent = view === 'sin-ingreso' ? 'Sin ingreso hoy, por sucursal' : 'Lista por sucursal';
  render();
  updateStatus();
  if (view === 'encuentro') document.dispatchEvent(new Event('abrir-encuentro'));
}
['presencia', 'sin-ingreso', 'encuentro'].forEach(view => $('#vista-' + view).addEventListener('click', () => setView(view)));
if (!document.body.dataset.checklist) $('#vista-encuentro').hidden = true;
$('#actualizar').addEventListener('click', () => currentView === 'encuentro' ? document.dispatchEvent(new Event('abrir-encuentro')) : refresh());
$('#buscar').addEventListener('input', render);
$('#modalidad').addEventListener('change', () => {
  try { sessionStorage.setItem('presencia-modalidad', $('#modalidad').value); } catch (_) {}
  updateTotals(); render(); document.dispatchEvent(new Event('macro-sucursal'));
});
$('#sucursal').addEventListener('change', () => {
  savedBranch = $('#sucursal').value;
  try { sessionStorage.setItem('presencia-sucursal', savedBranch); } catch (_) {}
  updateTotals(); render(); document.dispatchEvent(new Event('macro-sucursal'));
});
document.addEventListener('encuentro-sucursales', event => { encounterBranches = event.detail; updateBranchOptions(); });
$('#limpiar').addEventListener('click', () => { $('#buscar').value = ''; render(); $('#buscar').focus(); });
$('#imprimir').addEventListener('click', () => { updateStatus(); window.print(); });
$('#csv').addEventListener('click', () => {
  if (!data) return;
  const missing = currentView === 'sin-ingreso';
  const query = normalize($('#buscar').value.trim()), selected = $('#sucursal').value;
  const rows = [];
  data.sucursales.filter(branch => !selected || branchKey(branch) === selected).forEach(branch => {
    (missing ? branch.sin_ingreso_personas : branch.personas).filter(matchesModality)
      .filter(person => !query || normalize(person.nombre + ' ' + person.sector).includes(query))
      .forEach(person => rows.push([
        branch.nombre, branch.empresa, person.sector, person.nombre, person.modalidad,
        missing ? (person.estado === 'solo_salida' ? 'Salida sin ingreso' : 'Sin fichadas hoy') : (person.ingreso_validado ? 'Ingreso validado' : 'Ubicación a verificar'),
        missing ? '' : person.ultimo_ingreso,
      ]));
  });
  downloadCSV((missing ? 'sin-ingreso' : 'presencia') + '-' + new Date().toISOString().slice(0, 10) + '.csv',
    ['Sucursal', 'Empresa', 'Sector', 'Nombre', 'Modalidad', 'Estado', 'Último ingreso'], rows);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { updateStatus(); refresh(); } });
window.addEventListener('offline', () => { failure = 'Este dispositivo no tiene conexión.'; updateStatus(); });
window.addEventListener('online', refresh);
setInterval(updateStatus, 1000);
restoreCache();
refresh();
})();
