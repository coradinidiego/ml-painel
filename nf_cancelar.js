/**
 * NF-e para cancelar: pedido cancelado (pelo cliente/marketplace) que já tinha nota fiscal emitida e autorizada.
 * O Bling e o Tiny cancelam o pedido sozinhos, mas não a nota — ela fica autorizada até alguém cancelar à mão.
 *
 *  - Tiny (Lufe): pedidos com situação "cancelado" (últimos DIAS) × notas de saída autorizadas (6/7), pelo nº do pedido na loja
 *  - Bling (Zagodini, Mãe): pedidos com situação Cancelado (id 12) → nota do pedido → situação da NF-e (5/6/7 = autorizada)
 *      (precisa do escopo "Notas Fiscais" no app do Bling)
 *  - O prazo normal de cancelamento na SEFAZ é de 24 h depois da autorização; depois disso só cancelamento extemporâneo
 *  - Cada nota pendente vira um cartão no Trello (lista "Notas a cancelar") e o cartão é concluído quando a nota aparece cancelada.
 *
 *  GET  /nfcancelar            situação
 *  POST /nfcancelar/atualizar
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const DATA = require('./dados');

const DIAS = 10;
const EMP = [
  { id: 'zagodini', nome: 'Zagodini', idx: 0, erp: 'Bling' },
  { id: 'mae', nome: 'Com Amor de Mae', idx: 1, erp: 'Bling' },
  { id: 'lufe', nome: 'Lufe', idx: 2, erp: 'Tiny' },
];
const ARQ = path.join(DATA, 'apuracao_cache', 'nf_cancelar.json');
const ARQ_TR = path.join(DATA, 'apuracao_cache', 'nf_cancelar_trello.json');
const lerJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const gravar = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch (e) {} };
const delay = ms => new Promise(r => setTimeout(r, ms));
const ST = lerJson(ARQ, {});
const ARQ_FULL = path.join(DATA, 'apuracao_cache', 'nf_cancelar_full.json');
const FULL = lerJson(ARQ_FULL, {});   // "idx|pedidoML" -> true/false (venda pelo Full)
const EXCLUIDOS = new Set();          // chaves fora por serem Full (o cartão é arquivado)
const ARQ_DEV = path.join(DATA, 'apuracao_cache', 'nf_devolucao.json');
const DEV = lerJson(ARQ_DEV, {});     // chave -> nota de venda enviada e cancelada: esperar o produto voltar e emitir NF de devolução
let DEV_NOVOS = [], NAO_CONF = [], ANALISAR = [];
const ENTRADAS = new Set();           // "emp|pedido" com NF de entrada (devolução) já emitida
const DEVOLVIDAS = new Set();         // chave da nota de venda que já tem NF de devolução (entrada do mesmo cliente e valor)
const soDig = v => String(v || '').replace(/\D/g, '');

let ML = null;
// SHEIN: se o pedido saiu (enviado/coletado) a nota vale — o "cancelado" do ERP não reflete a SHEIN
async function sheinEnviado(empId, pedido) {
  if (!/^GSH/i.test(String(pedido))) return false;
  try { const shein = require('./shein'); if (!shein.autorizada(empId)) return false;
    const P = (await shein.detalhes(empId, [String(pedido)], { idadeMin: 60 }))[String(pedido)];
    return !!(P && (P.coletado || P.enviado));
  } catch (er) { return false; }
}
// Confere o pedido no site (marketplace): { cancelado: true|false|null, enviado, full, ...devolução do ML }
async function conferirSite(empId, idx, pedido) {
  const n = String(pedido || '');
  try {
    if (/^2\d{15}$/.test(n)) {                                     // Mercado Livre
      if (await ehFull(idx, n)) return { full: true };
      const s = await situacaoML(idx, n);
      return s ? { ...s, canal: 'Mercado Livre' } : { cancelado: null, canal: 'Mercado Livre' };
    }
    if (/^GSH/i.test(n)) {                                          // SHEIN (st 6 = cancelado)
      const shein = require('./shein'); if (!shein.autorizada(empId)) return { cancelado: null, canal: 'SHEIN' };
      const P = (await shein.detalhes(empId, [n], { idadeMin: 60 }))[n];
      return P ? { cancelado: Number(P.st) === 6, enviado: !!(P.coletado || P.enviado), canal: 'SHEIN' } : { cancelado: null, canal: 'SHEIN' };
    }
    if (/^\d{3}-\d{7}-\d{7}$/.test(n)) {                            // Amazon
      const o = (await require('./amazon').loja(empId).get('/orders/v0/orders/' + n))?.payload || {};
      return { cancelado: o.OrderStatus ? o.OrderStatus === 'Canceled' : null, enviado: (o.NumberOfItemsShipped || 0) > 0, canal: 'Amazon' };
    }
    if (/^\d{6}[A-Z0-9]{6,10}$/.test(n)) {                            // Shopee
      const d = await require('./shopee').loja(empId).shopeeGet('/api/v2/order/get_order_detail', { order_sn_list: n, response_optional_fields: 'order_status,pickup_done_time' });
      const o = d.response?.order_list?.[0];
      return o ? { cancelado: ['CANCELLED', 'IN_CANCEL'].includes(o.order_status), enviado: ['SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED', 'TO_RETURN'].includes(o.order_status) || !!o.pickup_done_time, canal: 'Shopee' } : { cancelado: null, canal: 'Shopee' };
    }
  } catch (er) { return { cancelado: null, erro: er.message }; }
  return { cancelado: null, canal: 'outro' };
}
async function pedidoML(idx, pedido) {
  try { return await ML(idx, '/orders/' + pedido); }
  catch (er) { const pk = await ML(idx, '/packs/' + pedido); return pk?.orders?.[0]?.id ? await ML(idx, '/orders/' + pk.orders[0].id) : null; }
}
async function ehFull(idx, pedido) {
  if (!/^2\d{15}$/.test(String(pedido)) || !ML) return false;   // só vendas do Mercado Livre
  const k = idx + '|' + pedido;
  if (FULL[k] !== undefined) return FULL[k];
  try {
    const o = await pedidoML(idx, pedido);
    const sh = o?.shipping?.id ? await ML(idx, '/shipments/' + o.shipping.id) : null;
    FULL[k] = sh?.logistic_type === 'fulfillment';
  } catch (er) { return false; }
  gravar(ARQ_FULL, FULL);
  return FULL[k];
}
// Venda do ML que já saiu para o cliente: a nota não se cancela — espera o produto voltar e emite NF de devolução.
// { enviado, devolucao: 'sem devolução' | 'a caminho' | 'chegou', chegouEm }
async function situacaoML(idx, pedido) {
  if (!/^2\d{15}$/.test(String(pedido)) || !ML) return null;
  try {
    const o = await pedidoML(idx, pedido); if (!o) return null;
    const sh = o.shipping?.id ? await ML(idx, '/shipments/' + o.shipping.id) : null;
    const hist = sh?.status_history || {};
    const enviado = ['shipped', 'delivered', 'not_delivered'].includes(sh?.status) || !!hist.date_shipped || !!hist.date_delivered;
    const cancelado = o.status === 'cancelled';
    if (!enviado) return { enviado: false, cancelado };
    let devolucao = 'sem devolução', chegouEm = null;
    const cs = await ML(idx, '/post-purchase/v1/claims/search', { resource: 'order', resource_id: o.id });
    for (const c of cs.data || []) {
      let r; try { r = await ML(idx, '/post-purchase/v2/claims/' + c.id + '/returns'); } catch (er) { continue; }
      const s2 = (r.shipments || []).find(x => x.destination?.name === 'seller_address') || (r.shipments || [])[0];
      if (!s2) continue;
      if (s2.status === 'delivered' || r.status === 'delivered') { devolucao = 'chegou'; chegouEm = r.last_updated || null; break; }
      if (['shipped', 'ready_to_ship', 'pending'].includes(s2.status) || ['label_generated', 'shipped', 'opened'].includes(r.status)) devolucao = 'a caminho';
    }
    return { enviado: true, cancelado, devolucao, chegouEm, entregue: sh?.status === 'delivered' || !!hist.date_delivered };
  } catch (er) { return null; }
}
// Pedidos cancelados nos sites nos últimos DIAS (para achar venda cancelada no site e ativa no ERP)
async function siteCancelados(empId, idx) {
  const out = new Set(), de = new Date(Date.now() - DIAS * 864e5), agora = new Date();
  try {   // Mercado Livre (o ERP usa o nº do pacote quando houver)
    if (ML) { const me = await ML(idx, '/users/me');
      for (let off = 0; off < 1000; off += 50) {
        const r = await ML(idx, '/orders/search', { seller: me.id, 'order.status': 'cancelled', 'order.date_created.from': de.toISOString().slice(0, 19) + '.000-00:00', limit: 50, offset: off });
        for (const o of r.results || []) { out.add(String(o.pack_id || o.id)); out.add(String(o.id)); }
        if ((r.results || []).length < 50) break;
      } }
  } catch (er) {}
  try { const shein = require('./shein'); if (shein.autorizada(empId)) for (const x of await shein.listarPedidos(empId, de, agora)) if (x.st === 6) out.add(String(x.num)); } catch (er) {}
  try { const sp = require('./shopee').loja(empId);
    if (sp.getTokens().access_token) { const to = Math.floor(Date.now() / 1000);
      for (let cur = '', i = 0; i < 20; i++) {
        const d = await sp.shopeeGet('/api/v2/order/get_order_list', { time_range_field: 'create_time', time_from: to - Math.min(DIAS, 15) * 86400, time_to: to, page_size: 100, order_status: 'CANCELLED', ...(cur ? { cursor: cur } : {}) });
        for (const o of d.response?.order_list || []) out.add(String(o.order_sn));
        if (!d.response?.more) break; cur = d.response.next_cursor;
      } } } catch (er) {}
  try { const az = require('./amazon').loja(empId);
    if (az.configurada()) { let next = null;
      for (let i = 0; i < 10; i++) {
        const d = await az.get('/orders/v0/orders', next ? { MarketplaceIds: 'A2Q3Y263D00KWC', NextToken: next } : { MarketplaceIds: 'A2Q3Y263D00KWC', CreatedAfter: de.toISOString(), OrderStatuses: 'Canceled' });
        for (const o of d.payload?.Orders || []) out.add(String(o.AmazonOrderId));
        next = d.payload?.NextToken; if (!next) break; await delay(1100);
      } } } catch (er) {}
  return out;
}
const motivo = (erp, canal, sit, erpCanc) => erpCanc ? `cancelado no ${erp}, mas ativo no ${canal || 'site'}${sit.enviado ? ' (já enviado)' : ''}` : `cancelado no ${canal || 'site'}, mas ativo no ${erp}`;
const TR = lerJson(ARQ_TR, {});
const br = d => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const iso = d => d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const deBr = s => { const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/); return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4] || '12'}:${m[5] || '00'}:00-03:00` : null; };

// ─── Tiny ───────────────────────────────────────────────────────────────────
async function tinyTodas(metodo, chave, params) {
  const tiny = require('./tiny'), out = [];
  for (let pagina = 1, total = 1; pagina <= total && pagina <= 30; pagina++) {
    const r = await tiny.chamar(metodo, { ...params, pagina });
    if (r.vazio) break;
    total = parseInt(r.numero_paginas || 1);
    out.push(...(r[chave] || []));
  }
  return out;
}
async function coletarTiny() {
  const desde = br(new Date(Date.now() - DIAS * 864e5));
  const canc = (await tinyTodas('pedidos.pesquisa.php', 'pedidos', { situacao: 'cancelado', dataInicial: desde })).map(x => x.pedido);
  const porLoja = new Map(canc.filter(p => p.numero_ecommerce).map(p => [String(p.numero_ecommerce), p]));
  const ENT_TINY = new Set();   // cliente|valor das notas de entrada (devolução) dos últimos 60 dias
  const nfs = (await tinyTodas('notas.fiscais.pesquisa.php', 'notas_fiscais', { dataInicial: desde, tipoNota: 'S' })).map(x => x.nota_fiscal);
  try { const ent = (await tinyTodas('notas.fiscais.pesquisa.php', 'notas_fiscais', { dataInicial: br(new Date(Date.now() - 60 * 864e5)), tipoNota: 'E' })).map(x => x.nota_fiscal);
    for (const n of ent) if (['6', '7'].includes(String(n.situacao))) { if (n.numero_ecommerce) ENTRADAS.add('lufe|' + n.numero_ecommerce); ENT_TINY.add(soDig(n.cliente?.cpf_cnpj) + '|' + (+n.valor).toFixed(2)); } } catch (er) {}
  const out = [];
  for (const n of nfs) {
    if (!['6', '7'].includes(String(n.situacao)) || n.tipo === 'E') continue;   // 6 autorizada, 7 emitida DANFE
    const p = porLoja.get(String(n.numero_ecommerce || ''));
    if (!p) continue;
    if (ENT_TINY.has(soDig(n.cliente?.cpf_cnpj) + '|' + (+n.valor).toFixed(2))) { DEVOLVIDAS.add('tiny|' + n.id); continue; }   // já tem NF de devolução: resolvido
    const sit = await conferirSite('lufe', 2, n.numero_ecommerce);
    if (sit.full) { EXCLUIDOS.add('tiny|' + n.id); continue; }   // Full: nota não se cancela pelo ERP
    if (sit.cancelado !== true) { EXCLUIDOS.add('tiny|' + n.id);
      if (sit.cancelado === null) NAO_CONF.push({ emp: 'lufe', nf: n.numero, pedido: String(n.numero_ecommerce), canal: sit.canal, erro: sit.erro || null });
      else ANALISAR.push({ chave: 'an|tiny|' + n.id, emp: 'lufe', nf: n.numero, serie: n.serie, situacaoNf: 'autorizada', pedido: String(n.numero_ecommerce), pedidoErp: p.numero, cliente: n.nome, valor: +n.valor || null,
        motivo: motivo('Tiny', sit.canal, sit, true), link: 'https://erp.tiny.com.br/notas_fiscais#edit/' + n.id });
      continue; }   // só quando Tiny, site e nota concordam
    if (sit?.enviado) { DEV_NOVOS.push({ chave: 'tiny|' + n.id, emp: 'lufe', nf: n.numero, serie: n.serie, nfId: n.id, emissao: deBr(n.data_emissao), pedido: String(n.numero_ecommerce), pedidoErp: p.numero,
      cliente: n.nome, valor: +n.valor || null, link: 'https://erp.tiny.com.br/notas_fiscais#edit/' + n.id, devolucao: sit.devolucao, chegouEm: sit.chegouEm, entregue: sit.entregue }); continue; }
    out.push({ chave: 'tiny|' + n.id, nf: n.numero, serie: n.serie, nfId: n.id, emissao: deBr(n.data_emissao), pedido: String(n.numero_ecommerce), pedidoErp: p.numero,
      cliente: n.nome, valor: +n.valor || null, canal: p.nome_ecommerce || null, link: 'https://erp.tiny.com.br/notas_fiscais#edit/' + n.id });
  }
  // B) cancelado no site, ativo no Tiny, com nota autorizada
  const autorizadas = new Map(), canceladas = new Map();
  for (const n of nfs) { if (n.tipo === 'E' || !n.numero_ecommerce) continue; const k = String(n.numero_ecommerce);
    if (['6', '7'].includes(String(n.situacao))) autorizadas.set(k, n); else if (/cancel/i.test(n.descricao_situacao || '') || String(n.situacao) === '3') canceladas.set(k, n); }
  const noSite = await siteCancelados('lufe', 2);
  for (const k of noSite) {
    const n = autorizadas.get(k); if (!n || porLoja.has(k)) continue;
    if (ENT_TINY.has(soDig(n.cliente?.cpf_cnpj) + '|' + (+n.valor).toFixed(2))) continue;
    const sit = await conferirSite('lufe', 2, k); if (sit.full || sit.cancelado !== true) continue;
    ANALISAR.push({ chave: 'an|tiny|' + n.id, emp: 'lufe', nf: n.numero, serie: n.serie, situacaoNf: 'autorizada', pedido: k, cliente: n.nome, valor: +n.valor || null,
      motivo: motivo('Tiny', sit.canal, sit, false), link: 'https://erp.tiny.com.br/notas_fiscais#edit/' + n.id });
  }
  // C) nota cancelada, mas a venda continua ativa no Tiny e no site (e não foi emitida outra nota)
  for (const [k, n] of canceladas) {
    if (autorizadas.has(k) || porLoja.has(k)) continue;
    const sit = await conferirSite('lufe', 2, k); if (sit.full || sit.cancelado !== false) continue;
    ANALISAR.push({ chave: 'an|tiny|' + n.id, emp: 'lufe', nf: n.numero, serie: n.serie, situacaoNf: 'cancelada', pedido: k, cliente: n.nome, valor: +n.valor || null,
      motivo: `nota cancelada, mas a venda está ativa no Tiny e no ${sit.canal || 'site'}${sit.enviado ? ' (já enviada)' : ''}`, link: 'https://erp.tiny.com.br/notas_fiscais#edit/' + n.id });
  }
  return out;
}

// ─── Bling ──────────────────────────────────────────────────────────────────
async function blingGet(c, url, tent = 5) {
  for (let t = 0; t < tent; t++) {
    try { return (await c.get(url, { timeout: 30000 })).data; }
    catch (e) { if (e.response?.status === 429 && t < tent - 1) { await delay(2500 * (t + 1)); continue; } throw e; }
  }
}
const NF_AUTORIZADA = new Set([5, 6, 7]);   // 5 autorizada, 6 emitida DANFE, 7 registrada
async function coletarBling(e, cache) {
  const c = require('./bling').client(e.idx);
  const desde = iso(new Date(Date.now() - DIAS * 864e5));
  // notas de entrada (devolução) dos últimos 60 dias, por documento do cliente
  const entradas = new Map();
  try { const d60 = iso(new Date(Date.now() - 60 * 864e5));
    for (let pagina = 1; pagina <= 20; pagina++) {
      const d = await blingGet(c, `/nfe?limite=100&pagina=${pagina}&tipo=0&dataEmissaoInicial=${d60}%2000:00:00`); await delay(340);
      for (const n of d?.data || []) if (NF_AUTORIZADA.has(Number(n.situacao))) { const k = soDig(n.contato?.numeroDocumento); if (k) (entradas.get(k) || entradas.set(k, []).get(k)).push(n); }
      if ((d?.data || []).length < 100) break;
    } } catch (er) {}
  const temDevolucao = async nf => {   // entrada do mesmo cliente, depois da venda, com o mesmo valor
    const L = entradas.get(soDig(nf?.contato?.numeroDocumento)) || [];
    for (const n of L) {
      if (nf.dataEmissao && n.dataEmissao < nf.dataEmissao) continue;
      let v = cache['e' + n.id];
      if (v === undefined) { const d = (await blingGet(c, '/nfe/' + n.id))?.data; await delay(340); v = cache['e' + n.id] = +d?.valorNota || 0; }
      if (Math.abs(v - (+nf.valorNota || 0)) < 0.05) return true;
    }
    return false;
  };
  const peds = [];
  for (let pagina = 1; pagina <= 30; pagina++) {
    const d = await blingGet(c, `/pedidos/vendas?limite=100&pagina=${pagina}&idsSituacoes[]=12&dataInicial=${desde}`);
    peds.push(...(d?.data || []));
    if ((d?.data || []).length < 100) break;
    await delay(350);
  }
  const out = [];
  for (const p of peds) {
    // o nº da nota do pedido não muda: guarda para não perguntar de novo a cada rodada
    let nfId = cache[p.id];
    if (nfId === undefined) {
      const d = await blingGet(c, '/pedidos/vendas/' + p.id); await delay(340);
      nfId = cache[p.id] = d?.data?.notaFiscal?.id || 0;
    }
    if (!nfId) continue;
    let nf;
    try { nf = (await blingGet(c, '/nfe/' + nfId))?.data; await delay(340); }
    catch (er) { if (er.response?.status === 403) throw Object.assign(new Error('o app do Bling não tem permissão de Notas Fiscais'), { semEscopo: true }); throw er; }
    if (!nf || !NF_AUTORIZADA.has(Number(nf.situacao))) continue;
    if (await temDevolucao(nf)) { DEVOLVIDAS.add('bling' + e.idx + '|' + nfId); continue; }   // já tem NF de devolução: resolvido
    const sit = await conferirSite(e.id, e.idx, p.numeroLoja);
    if (sit.full) { EXCLUIDOS.add('bling' + e.idx + '|' + nfId); continue; }   // Full: nota não se cancela pelo Bling
    if (sit.cancelado !== true) { EXCLUIDOS.add('bling' + e.idx + '|' + nfId);
      if (sit.cancelado === null) NAO_CONF.push({ emp: e.id, nf: nf.numero, pedido: String(p.numeroLoja || p.numero), canal: sit.canal, erro: sit.erro || null });
      else ANALISAR.push({ chave: 'an|bling' + e.idx + '|' + nfId, emp: e.id, nf: nf.numero, serie: nf.serie, situacaoNf: 'autorizada', pedido: String(p.numeroLoja || p.numero), pedidoErp: p.numero,
        cliente: p.contato?.nome || '', valor: +p.total || null, motivo: motivo('Bling', sit.canal, sit, true), link: 'https://www.bling.com.br/notas.fiscais.php#edit/' + nfId });
      continue; }   // só quando Bling, site e nota concordam
    if (sit?.enviado) { DEV_NOVOS.push({ chave: 'bling' + e.idx + '|' + nfId, emp: e.id, nf: nf.numero, serie: nf.serie, nfId, emissao: nf.dataEmissao ? new Date(nf.dataEmissao.replace(' ', 'T') + '-03:00').toISOString() : null,
      pedido: String(p.numeroLoja || p.numero), pedidoErp: p.numero, cliente: p.contato?.nome || '', valor: +p.total || null, link: 'https://www.bling.com.br/notas.fiscais.php#edit/' + nfId,
      devolucao: sit.devolucao, chegouEm: sit.chegouEm, entregue: sit.entregue }); continue; }
    out.push({ chave: 'bling' + e.idx + '|' + nfId, nf: nf.numero, serie: nf.serie, nfId, emissao: nf.dataEmissao ? new Date(nf.dataEmissao.replace(' ', 'T') + '-03:00').toISOString() : null,
      pedido: String(p.numeroLoja || p.numero), pedidoErp: p.numero, cliente: p.contato?.nome || nf.contato?.nome || '', valor: +p.total || null,
      link: 'https://www.bling.com.br/notas.fiscais.php#edit/' + nfId });
  }
  const jaCanc = new Set(peds.map(p => String(p.numeroLoja || '')));
  const pedidoBling = async numLoja => { const d = await blingGet(c, '/pedidos/vendas?numerosLojas[]=' + encodeURIComponent(numLoja)); await delay(340); return (d?.data || [])[0] || null; };
  const nfDoPedido = async id => { if (cache['p' + id] !== undefined) return cache['p' + id]; const d = await blingGet(c, '/pedidos/vendas/' + id); await delay(340); return (cache['p' + id] = d?.data?.notaFiscal?.id || 0); };
  const nfSit = async id => { const d = (await blingGet(c, '/nfe/' + id))?.data; await delay(340); return d; };
  // B) cancelado no site, ativo no Bling, com nota autorizada
  for (const k of await siteCancelados(e.id, e.idx)) {
    if (jaCanc.has(k)) continue;
    const p = await pedidoBling(k); if (!p || Number(p.situacao?.id) === 12) continue;
    const nfId = await nfDoPedido(p.id); if (!nfId) continue;
    const nf = await nfSit(nfId); if (!nf || !NF_AUTORIZADA.has(Number(nf.situacao))) continue;
    if (await temDevolucao(nf)) continue;
    const sit = await conferirSite(e.id, e.idx, k); if (sit.full || sit.cancelado !== true) continue;
    ANALISAR.push({ chave: 'an|bling' + e.idx + '|' + nfId, emp: e.id, nf: nf.numero, serie: nf.serie, situacaoNf: 'autorizada', pedido: k, pedidoErp: p.numero, cliente: p.contato?.nome || '', valor: +p.total || null,
      motivo: motivo('Bling', sit.canal, sit, false), link: 'https://www.bling.com.br/notas.fiscais.php#edit/' + nfId });
  }
  // C) nota cancelada, mas a venda continua ativa no Bling e no site (e o pedido não tem outra nota autorizada)
  const canc = [];
  for (let pagina = 1; pagina <= 10; pagina++) {
    const d = await blingGet(c, `/nfe?limite=100&pagina=${pagina}&tipo=1&situacao=2&dataEmissaoInicial=${desde}%2000:00:00`); await delay(340);
    canc.push(...(d?.data || [])); if ((d?.data || []).length < 100) break;
  }
  for (const n of canc) {
    let num = cache['n' + n.id];
    if (num === undefined) { const d = await nfSit(n.id); num = cache['n' + n.id] = d?.numeroPedidoLoja || ''; }
    if (!num || jaCanc.has(String(num))) continue;
    const p = await pedidoBling(num); if (!p || Number(p.situacao?.id) === 12) continue;
    const atual = await nfDoPedido(p.id);
    if (atual && atual !== n.id) { const a = await nfSit(atual); if (a && NF_AUTORIZADA.has(Number(a.situacao))) continue; }   // foi emitida outra nota
    const sit = await conferirSite(e.id, e.idx, num); if (sit.full || sit.cancelado !== false) continue;
    ANALISAR.push({ chave: 'an|bling' + e.idx + '|' + n.id, emp: e.id, nf: n.numero, serie: n.serie, situacaoNf: 'cancelada', pedido: String(num), pedidoErp: p.numero, cliente: n.contato?.nome || '', valor: +p.total || null,
      motivo: `nota cancelada, mas a venda está ativa no Bling e no ${sit.canal || 'site'}${sit.enviado ? ' (já enviada)' : ''}`, link: 'https://www.bling.com.br/notas.fiscais.php#edit/' + n.id });
  }
  return out;
}

// ─── Trello (lista da Rafaela) ─────────────────────────────────────────────
const trOk = () => !!(process.env.TRELLO_KEY && process.env.TRELLO_TOKEN);
const trello = async (metodo, caminho, params = {}) => (await axios({ method: metodo, url: 'https://api.trello.com/1' + caminho,
  params: { key: process.env.TRELLO_KEY.trim(), token: process.env.TRELLO_TOKEN.trim(), ...params }, timeout: 20000 })).data;
async function sincronizarTrello() {
  if (!trOk()) return null;
  const pend = new Map(), ok = new Set();
  for (const e of EMP) { const R = ST[e.id]; if (!R) continue; if (!R.erro) ok.add(e.id); for (const x of R.itens || []) pend.set(x.chave, { ...x, emp: e }); }
  for (const e of EMP) for (const x of ST[e.id]?.analisar || []) pend.set(x.chave, { ...x, emp: e, analise: true });
  for (const [chave, x] of pend) {
    if (TR[chave] && !TR[chave].resolvido) continue;
    if (x.analise) {
      const desc = [`Divergência entre ${x.emp.erp}, site e nota fiscal — analisar.`, `Motivo: ${x.motivo}`, `NF-e: ${x.nf}${x.serie ? ' série ' + x.serie : ''} (${x.situacaoNf})`,
        `Venda: ${x.pedido}${x.pedidoErp ? ' (pedido ' + x.pedidoErp + ' no ' + x.emp.erp + ')' : ''}`, x.cliente ? `Cliente: ${x.cliente}` : null, x.valor ? `Valor: R$ ${x.valor.toFixed(2).replace('.', ',')}` : null,
        `Abrir a nota no ${x.emp.erp}: ${x.link}`, '', '(criado automaticamente pelo painel)'].filter(v => v !== null).join('\n');
      const card = await trello('post', '/cards', { idList: process.env.TRELLO_LISTA_NF || '6adf69b10e63fa14064aa3da', name: `${x.emp.nome} - Analisar NF ${x.nf} (venda ${x.pedido})`, desc, pos: 'top' });
      TR[chave] = { card: card.id, url: card.shortUrl, em: new Date().toISOString(), emp: x.emp.id, analise: true }; gravar(ARQ_TR, TR); continue;
    }
    const venc = x.emissao ? new Date(Date.parse(x.emissao) + 24 * 3600e3) : null;
    const desc = [`Pedido cancelado com NF-e ainda autorizada no ${x.emp.erp}. Cancelar a nota.`, `NF-e: ${x.nf}${x.serie ? ' série ' + x.serie : ''}`,
      x.emissao ? `Emitida: ${new Date(x.emissao).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })} (prazo normal da SEFAZ: 24 h)` : null,
      `Venda: ${x.pedido}${x.pedidoErp ? ' (pedido ' + x.pedidoErp + ' no ' + x.emp.erp + ')' : ''}`, x.cliente ? `Cliente: ${x.cliente}` : null, x.valor ? `Valor: R$ ${x.valor.toFixed(2).replace('.', ',')}` : null,
      `Abrir no ${x.emp.erp}: ${x.link}`, '', '(criado automaticamente pelo painel)'].filter(v => v !== null).join('\n');
    const card = await trello('post', '/cards', { idList: process.env.TRELLO_LISTA_NF || '6adf69b10e63fa14064aa3da',   // lista "Notas a cancelar"
     
      name: `${x.emp.nome} - Cancelar NF ${x.nf} (venda ${x.pedido})`, desc, pos: 'top', ...(venc ? { due: venc.toISOString() } : {}) });
    TR[chave] = { card: card.id, url: card.shortUrl, em: new Date().toISOString(), emp: x.emp.id };
    gravar(ARQ_TR, TR);
  }
  for (const [chave, t] of Object.entries(TR)) {
    if (t.resolvido || pend.has(chave) || !ok.has(t.emp)) continue;
    if (DEV[chave] && !t.dev) {   // a venda tinha saído: não se cancela, vira NF de devolução
      try { await trello('post', '/cards/' + t.card + '/actions/comments', { text: '↩️ A venda já tinha sido enviada: não cancelar a nota. Esperar o produto voltar e emitir a NF de devolução (o painel cria outro cartão quando chegar).' });
        await trello('put', '/cards/' + t.card, { closed: true }); } catch (er) { if (er.response?.status !== 404) throw er; }
      t.resolvido = new Date().toISOString(); t.virouDev = true; gravar(ARQ_TR, TR); continue;
    }
    if (EXCLUIDOS.has(chave)) {   // venda do Full: não era para ter cartão
      try { await trello('put', '/cards/' + t.card, { closed: true }); } catch (er) { if (er.response?.status !== 404) throw er; }
      t.resolvido = new Date().toISOString(); t.full = true; gravar(ARQ_TR, TR); continue;
    }
    try { await trello('put', '/cards/' + t.card, { dueComplete: true }); await trello('post', '/cards/' + t.card + '/actions/comments', { text: DEVOLVIDAS.has(chave) ? '✅ NF de devolução emitida (conferido pelo painel).' : t.analise ? '✅ Bling/Tiny, site e nota agora batem (conferido pelo painel).' : '✅ Nota cancelada (conferido pelo painel).' }); }
    catch (er) { if (er.response?.status !== 404) throw er; }
    t.resolvido = new Date().toISOString(); gravar(ARQ_TR, TR);
  }
  // devoluções: cartão quando o produto chegou; concluído quando a NF de devolução for emitida
  const nomeEmp = id => EMP.find(e => e.id === id)?.nome || id, erpEmp = id => EMP.find(e => e.id === id)?.erp || 'ERP';
  for (const [chave, d] of Object.entries(DEV)) {
    const k = 'dev|' + chave;
    if (!d.feito && d.devolucao === 'chegou' && !TR[k]) {
      const desc = ['O cliente devolveu uma venda que já tinha sido enviada. NÃO cancelar a nota: emitir a NF de devolução (entrada).', `NF de venda: ${d.nf}${d.serie ? ' série ' + d.serie : ''}`,
        `Venda: ${d.pedido}${d.pedidoErp ? ' (pedido ' + d.pedidoErp + ' no ' + erpEmp(d.emp) + ')' : ''}`, d.cliente ? `Cliente: ${d.cliente}` : null, d.valor ? `Valor: R$ ${d.valor.toFixed(2).replace('.', ',')}` : null,
        `Abrir a nota no ${erpEmp(d.emp)}: ${d.link}`, '', '(criado automaticamente pelo painel)'].filter(v => v !== null).join('\n');
      const card = await trello('post', '/cards', { idList: process.env.TRELLO_LISTA_NF || '6adf69b10e63fa14064aa3da', name: `${nomeEmp(d.emp)} - Emitir NF de devolução (NF ${d.nf}, venda ${d.pedido})`, desc, pos: 'top' });
      TR[k] = { card: card.id, url: card.shortUrl, em: new Date().toISOString(), emp: d.emp, dev: true }; gravar(ARQ_TR, TR);
    }
    if (d.feito && TR[k] && !TR[k].resolvido) {
      try { await trello('put', '/cards/' + TR[k].card, { dueComplete: true }); await trello('post', '/cards/' + TR[k].card + '/actions/comments', { text: '✅ NF de devolução emitida.' }); } catch (er) { if (er.response?.status !== 404) throw er; }
      TR[k].resolvido = new Date().toISOString(); gravar(ARQ_TR, TR);
    }
  }
  for (const [k, t] of Object.entries(TR)) if (t.resolvido && Date.now() - Date.parse(t.resolvido) > 90 * 864e5) delete TR[k];
  gravar(ARQ_TR, TR);
  return null;
}

module.exports = function montar(app, ctx = {}) {
  ML = ctx.ml || null;
  let rodando = false, trErro = null;
  const cachePed = lerJson(path.join(DATA, 'apuracao_cache', 'nf_cancelar_pedidos.json'), {});
  async function atualizar() {
    if (rodando) return; rodando = true;
    try {
      DEV_NOVOS = []; NAO_CONF = []; ANALISAR = []; DEVOLVIDAS.clear();
      for (const e of EMP) {
        const R = ST[e.id] ||= {};
        try {
          R.itens = e.erp === 'Tiny' ? await coletarTiny() : await coletarBling(e, cachePed[e.idx] ||= {});
          R.erro = null; R.semEscopo = false;
        } catch (er) { R.erro = er.message; R.semEscopo = !!er.semEscopo; }
        R.em = new Date().toISOString();
        gravar(ARQ, ST);
        gravar(path.join(DATA, 'apuracao_cache', 'nf_cancelar_pedidos.json'), cachePed);
      }
      for (const e of EMP) if (!ST[e.id]?.erro) { ST[e.id].analisar = ANALISAR.filter(x => x.emp === e.id); } gravar(ARQ, ST);
      for (const d of DEV_NOVOS) DEV[d.chave] = { ...(DEV[d.chave] || {}), ...d, visto: new Date().toISOString() };
      for (const d of Object.values(DEV)) if (!d.feito && (ENTRADAS.has(d.emp + '|' + d.pedido) || DEVOLVIDAS.has(d.chave))) { d.feito = new Date().toISOString(); d.feitoPor = 'NF de entrada encontrada no ERP'; }
      for (const [k, d] of Object.entries(DEV)) if (d.feito && Date.now() - Date.parse(d.feito) > 90 * 864e5) delete DEV[k];
      gravar(ARQ_DEV, DEV);
      try { await sincronizarTrello(); trErro = null; } catch (er) { trErro = er.message; console.warn('[nf_cancelar/trello]', er.message); }
    } finally { rodando = false; }
  }
  setTimeout(() => atualizar().catch(er => console.warn('[nf_cancelar]', er.message)), 150e3);
  setInterval(() => atualizar().catch(er => console.warn('[nf_cancelar]', er.message)), 30 * 60e3).unref?.();
  app.get('/nfcancelar', (req, res) => res.json({ rodando, trelloErro: trErro, empresas: Object.fromEntries(EMP.map(e => [e.id, { erp: e.erp, ...(ST[e.id] || {}), naoConferidos: NAO_CONF.filter(x => x.emp === e.id), analisar: (ST[e.id]?.analisar || []), devolucoes: Object.values(DEV).filter(d => d.emp === e.id && (!d.feito || Date.now() - Date.parse(d.feito) < 7 * 864e5)) }])) }));
  app.post('/nfcancelar/devolucao', require('express').json(), (req, res) => {
    const d = DEV[String(req.body?.chave || '')]; if (!d) return res.status(404).json({ erro: 'não encontrado' });
    if (req.body?.feito === false) { delete d.feito; delete d.feitoPor; } else { d.feito = new Date().toISOString(); d.feitoPor = req.usuario?.nome || req.usuario?.email || 'painel'; }
    gravar(ARQ_DEV, DEV); sincronizarTrello().catch(() => {}); res.json({ ok: true });
  });
  app.post('/nfcancelar/atualizar', (req, res) => { atualizar().catch(() => {}); res.json({ ok: true }); });
};
