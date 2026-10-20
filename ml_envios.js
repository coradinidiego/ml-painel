/**
 * Envios do Mercado Livre direto da API do ML (para o painel da TV).
 *
 * Conta PACOTES (shipments), não pedidos — um carrinho com vários pedidos é um pacote só.
 * Ignora Full (fulfillment): quem empacota é o ML.
 *
 * Classificação:
 *   emitir NF    → "handling" ou ready_to_ship/invoice_pending
 *   a empacotar  → ready_to_ship com etiqueta ainda não impressa (ready_to_print)
 *   próximos dias→ "pending" (ex.: buffered: etiqueta libera em outro dia)
 *   empacotado   → "ready_to_ship" com etiqueta impressa, aguardando coleta/postagem
 *                  (printed, in_pickup_list, ready_for_pickup, ready_for_dropoff…)
 *   enviado hoje → entregue à transportadora (picked_up, dropped_off, in_hub…) ou "shipped" hoje
 * Prazo: data limite de despacho do ML — /shipments/{id}/sla (expected_date), o mesmo prazo que aparece no ML.
 *        (estimated_handling_limit costuma vir vazio; sem data nenhuma o pacote conta como "hoje").
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
  if (s.status === 'ready_to_ship' && s.coletadoEm && s.coletadoEm < hoje) return true;   // já coletado em dia anterior
  return false;
}

const _uid = {};
async function uid(conta) { return _uid[conta] ||= (await get(conta, '/users/me')).id; }

async function pedidosPagos(conta) {
  const seller = await uid(conta);
  const desde = new Date(Date.now() - DIAS_JANELA * 864e5).toISOString().replace('Z', '-00:00');
  const ids = new Map(); // shipping id -> número da venda (pacote ou pedido)
  for (let offset = 0; offset < 2000; offset += 50) {
    const d = await get(conta, '/orders/search', { seller, 'order.status': 'paid', 'order.date_created.from': desde, sort: 'date_desc', limit: 50, offset });
    for (const o of d.results || []) if (o.shipping?.id) ids.set(String(o.shipping.id), String(o.pack_id || o.id));
    if (!d.results?.length || offset + 50 >= (d.paging?.total || 0)) break;
    await delay(200);
  }
  return ids;
}

function resumirEnvio(s) {
  return {
    status: s.status, substatus: s.substatus || null,
    logistica: s.logistic_type || s.logistic?.type || null,
    limite: diaSP(s.shipping_option?.estimated_handling_limit?.date || s.lead_time?.estimated_handling_limit?.date),
    enviadoEm: diaSP(s.status_history?.date_shipped || s.date_shipped),
    // 1ª vez que a transportadora pegou o pacote (picked_up/in_hub…). Depois disso o substatus pode voltar a
    // "in_packing_list" (lista de carregamento no centro do ML) — o site do ML já mostra "A caminho".
    coletadoEm: diaSP((s.substatus_history || []).find(h => SUB_ENVIADO.has(h.substatus))?.date) || '',
  };
}

function classificar(s, hoje) {
  if (s.logistica === 'fulfillment') return null;                        // Full: quem empacota é o ML
  if (s.status === 'pending') return 'futuro';                           // ex.: buffered — etiqueta libera em outro dia
  if (s.status === 'handling') return 'emitirNF';                        // aguardando NF/etiqueta
  if (s.status === 'ready_to_ship') {
    if (s.coletadoEm) return s.coletadoEm === hoje ? 'enviado' : null;   // já coletado (site do ML: "A caminho")
    if (s.substatus === 'invoice_pending') return 'emitirNF';
    if (SUB_ENVIADO.has(s.substatus)) return (!s.limite || s.limite >= hoje) ? 'enviado' : null;   // coletado em dia anterior não conta como hoje
    if (SUB_EMPACOTADO.has(s.substatus)) return 'empacotado';
    return 'aEmpacotar';                                                 // ready_to_print, sem substatus
  }
  if (s.status === 'shipped' && s.enviadoEm === hoje) return 'enviado';
  return null;
}

/** Retorna linhas no mesmo formato do tv.js: { tipo, canal, prazo } — uma por pacote. */
async function coletar(conta, prazoFn) {
  const hoje = hojeSP(), c = cache();
  // Depois do fim da janela de coleta, pacotes da coleta (cross_docking) com prazo de hoje já foram levados:
  // o ML só muda o status quando o pacote é escaneado no centro de distribuição (pode levar horas).
  const col = await coletaHoje(conta).catch(() => null);
  const agoraHm = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Sao_Paulo' });
  const coletaPassou = !!col?.ate && agoraHm >= col.ate;
  const ids = await pedidosPagos(conta);
  const linhas = [];
  let consultas = 0;
  for (const [id, venda] of ids) {
    const chave = conta + ':' + id;
    let s = c[chave];
    if (!s || !finalizado(s, hoje)) {
      const ant = s;
      try { s = c[chave] = { ...resumirEnvio(await get(conta, '/shipments/' + id)), ts: Date.now() }; consultas++; }
      catch (e) { if (e.response?.status === 401) throw e; continue; }
      if (ant?.slaTs) { s.sla = ant.sla; s.slaTs = ant.slaTs; s.slaStatus = ant.slaStatus; }
      // prazo de despacho (SLA) só para o que ainda vai ser preparado; guarda por 30 min
      if ((s.status === 'handling' || s.status === 'ready_to_ship') && (!s.slaTs || s.slaStatus === undefined || Date.now() - s.slaTs > 30 * 60e3)) {
        try { const sla = await get(conta, '/shipments/' + id + '/sla'); s.sla = diaSP(sla?.expected_date) || null; s.slaStatus = sla?.status || null; s.slaTs = Date.now(); consultas++; }
        catch (e) { if (e.response?.status === 401) throw e; }
      }
      if (s.sla) s.limite = s.sla;
      if (consultas % 20 === 0) { salvar(); await delay(300); }
    }
    let tipo = classificar(s, hoje);
    // só presume coletado o pacote com prazo HOJE que o ML não marcou como atrasado (prazo vencido = não foi levado)
    if (tipo === 'empacotado' && coletaPassou && s.logistica === 'cross_docking' && s.limite === hoje && s.slaStatus !== 'delayed') tipo = 'enviado';
    const flex = s.logistica === 'self_service';   // Flex: entrega feita pela própria empresa
    // aguardando coleta com prazo de dia anterior: se o ML não diz que está atrasado, foi coletado e só não foi escaneado ainda
    if (tipo === 'empacotado' && s.logistica === 'cross_docking' && s.limite && s.limite < hoje && s.slaStatus !== 'delayed') tipo = null;
    let pz = (tipo === 'aEmpacotar' || tipo === 'emitirNF' || tipo === 'empacotado') ? prazoFn(s.limite, hoje) : 'hoje';
    if (s.slaStatus === 'delayed' && tipo !== 'enviado') pz = 'atrasado';          // o próprio ML diz que está atrasado
    if (tipo) linhas.push({ tipo, canal: 'Mercado Livre', prazo: pz, flex, num: venda });
  }
  // limpa do cache envios com mais de 30 dias
  for (const [k, v] of Object.entries(c)) if (v.ts && Date.now() - v.ts > 30 * 864e5) delete c[k];
  salvar();
  return linhas;
}

/** Janela de coleta de hoje (Mercado Envios Coleta / cross_docking), da agenda da conta no ML. Cache por dia. */
const _coleta = {};
async function coletaHoje(conta) {
  const hoje = hojeSP(), c = _coleta[conta];
  if (c && c.dia === hoje) return c.v;
  const dia = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Sao_Paulo' }).toLowerCase();
  const s = await get(conta, `/users/${await uid(conta)}/shipping/schedule/cross_docking`);
  const d = s?.schedule?.[dia], det = d?.work ? (d.detail || [])[0] : null;
  const v = det?.from ? { de: det.from, ate: det.to || null, cutoff: det.cutoff || null } : { semColeta: true };
  _coleta[conta] = { dia: hoje, v };
  return v;
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

module.exports = { coletar, classificar, resumirEnvio, diagnostico, coletaHoje };
