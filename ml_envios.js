/**
 * Envios do Mercado Livre direto da API do ML (para o painel da TV).
 *
 * Conta PACOTES (shipments), não pedidos — um carrinho com vários pedidos é um pacote só.
 * Ignora Full (fulfillment): quem empacota é o ML.
 *
 * Classificação:
 *   a empacotar  → status "handling", ou "ready_to_ship" com etiqueta ainda não impressa
 *                  (substatus ready_to_print / invoice_pending / sem substatus)
 *   empacotado   → "ready_to_ship" com etiqueta impressa, aguardando coleta/postagem
 *                  (printed, in_pickup_list, ready_for_pickup, ready_for_dropoff…)
 *   enviado hoje → entregue à transportadora (picked_up, dropped_off, in_hub…) ou "shipped" hoje
 * Prazo: data limite de despacho do ML (estimated_handling_limit).
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');

const BASE = 'https://api.mercadolibre.com';
const DIAS_JANELA = 12;                       // pedidos pagos dos últimos N dias
const ARQ_CACHE = path.join(DATA, 'apuracao_cache', 'tv_ml_envios.json');
const delay = ms => new Promise(r => setTimeout(r, ms));
const hojeSP = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const diaSP = iso => iso ? new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }) : '';

const SUB_EMPACOTADO = new Set(['printed', 'in_pickup_list', 'ready_for_pickup', 'ready_for_dropoff', 'in_packing_list', 'waiting_for_carrier', 'ready_to_pack', 'packed']);
const SUB_ENVIADO = new Set(['picked_up', 'dropped_off', 'in_hub', 'authorized_by_carrier', 'in_transit', 'on_route']);

function token(conta) {
  const t = JSON.parse(fs.readFileSync(path.join(DATA, 'tokens.json')));
  if (!t[conta]?.token) throw new Error(`sem token ML para ${conta}`);
  return t[conta].token;
}
async function get(conta, url, params, tent = 4) {
  for (let i = 0; i < tent; i++) {
    try {
      return (await axios.get(BASE + url, { params, timeout: 20000, headers: { Authorization: 'Bearer ' + token(conta) } })).data;
    } catch (e) {
      const st = e.response?.status;
      if ((st === 429 || st >= 500) && i < tent - 1) { await delay(1500 * (i + 1)); continue; }
      throw e;
    }
  }
}

// cache de envios: os já finalizados não são consultados de novo
let _cache = null;
function cache() { if (!_cache) { try { _cache = JSON.parse(fs.readFileSync(ARQ_CACHE)); } catch (e) { _cache = {}; } } return _cache; }
function salvar() { try { fs.mkdirSync(path.dirname(ARQ_CACHE), { recursive: true }); fs.writeFileSync(ARQ_CACHE, JSON.stringify(_cache)); } catch (e) {} }
function finalizado(s, hoje) {
  if (['delivered', 'cancelled', 'not_delivered'].includes(s.status)) return true;
  if (s.status === 'shipped' && s.enviadoEm && s.enviadoEm < hoje) return true;
  return false;
}

const _uid = {};
async function uid(conta) { return _uid[conta] ||= (await get(conta, '/users/me')).id; }

async function pedidosPagos(conta) {
  const seller = await uid(conta);
  const desde = new Date(Date.now() - DIAS_JANELA * 864e5).toISOString().replace('Z', '-00:00');
  const ids = new Map(); // shipping id -> 1
  for (let offset = 0; offset < 2000; offset += 50) {
    const d = await get(conta, '/orders/search', { seller, 'order.status': 'paid', 'order.date_created.from': desde, sort: 'date_desc', limit: 50, offset });
    for (const o of d.results || []) if (o.shipping?.id) ids.set(String(o.shipping.id), 1);
    if (!d.results?.length || offset + 50 >= (d.paging?.total || 0)) break;
    await delay(200);
  }
  return [...ids.keys()];
}

function resumirEnvio(s) {
  return {
    status: s.status, substatus: s.substatus || null,
    logistica: s.logistic_type || s.logistic?.type || null,
    limite: diaSP(s.shipping_option?.estimated_handling_limit?.date || s.lead_time?.estimated_handling_limit?.date),
    enviadoEm: diaSP(s.status_history?.date_shipped || s.date_shipped),
  };
}

function classificar(s, hoje) {
  if (s.logistica === 'fulfillment') return null;
  if (s.status === 'handling') return 'aEmpacotar';
  if (s.status === 'ready_to_ship') {
    if (SUB_ENVIADO.has(s.substatus)) return 'enviado';
    if (SUB_EMPACOTADO.has(s.substatus)) return 'empacotado';
    return 'aEmpacotar';                     // ready_to_print, invoice_pending, sem substatus
  }
  if (s.status === 'shipped' && s.enviadoEm === hoje) return 'enviado';
  return null;
}

/** Retorna linhas no mesmo formato do tv.js: { tipo, canal, prazo } — uma por pacote. */
async function coletar(conta, prazoFn) {
  const hoje = hojeSP(), c = cache();
  const ids = await pedidosPagos(conta);
  const linhas = [];
  let consultas = 0;
  for (const id of ids) {
    const chave = conta + ':' + id;
    let s = c[chave];
    if (!s || !finalizado(s, hoje)) {
      try { s = c[chave] = { ...resumirEnvio(await get(conta, '/shipments/' + id)), ts: Date.now() }; consultas++; }
      catch (e) { if (e.response?.status === 401) throw e; continue; }
      if (consultas % 20 === 0) { salvar(); await delay(300); }
    }
    const tipo = classificar(s, hoje);
    if (tipo) linhas.push({ tipo, canal: 'Mercado Livre', prazo: tipo === 'aEmpacotar' ? prazoFn(s.limite, hoje) : 'hoje' });
  }
  // limpa do cache envios com mais de 30 dias
  for (const [k, v] of Object.entries(c)) if (v.ts && Date.now() - v.ts > 30 * 864e5) delete c[k];
  salvar();
  return linhas;
}

/** Diagnóstico: quantos pacotes em cada status/substatus (a partir do cache da última coleta). */
function diagnostico(conta) {
  const hoje = hojeSP(), por = {}, log = {};
  for (const [k, v] of Object.entries(cache())) {
    if (!k.startsWith(conta + ':') || finalizado(v, hoje)) continue;
    const chave = `${v.status}/${v.substatus || '-'}`;
    por[chave] = por[chave] || { qtd: 0, tvConta: classificar(v, hoje) || 'ignorado' };
    por[chave].qtd++;
    log[v.logistica || '-'] = (log[v.logistica || '-'] || 0) + 1;
  }
  return { porStatus: por, logistica: log };
}

module.exports = { coletar, classificar, resumirEnvio, diagnostico };
