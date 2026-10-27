/**
 * Apuração de lucro — Mercado Livre, Shopee, Amazon, Shein e TikTok das três empresas.
 *  Mercado Livre e Shopee vêm direto das APIs (pedidos, tarifas, frete e repasse reais).
 * Montado em server.js:  app.use('/apuracao-mkt', require('./apuracao_mkt').router)
 *
 *  Pedidos:   Zagodini / Com Amor de Mãe → Bling (todas as situações, menos cancelado)
 *             Lufe                       → Tiny (cache da apuração Tiny)
 *  Custo:     ERP (Bling/Tiny) → planilha do canal (custo_por_sku.json / planilha da Lufe) → planilha geral
 *  Tarifas:   Amazon → financeiro da própria Amazon por pedido (comissão, tarifas, frete DBA/FBA);
 *                      pedido ainda sem lançamento financeiro = estimativa (histórico de comissão + faixa fixa)
 *             Shein / TikTok → taxas que o Bling registra no pedido (comissão + frete) + fixo por SKU da planilha
 *                      (Lufe: percentual e fixo da planilha da Lufe, o Tiny não traz as taxas)
 *  Imposto e embalagem: config_empresas.js (página Conta).
 *
 *  POST /apuracao-mkt/iniciar?emp=zagodini|mae|lufe&ini=YYYY-MM-DD&fim=YYYY-MM-DD
 *  GET  /apuracao-mkt/status?emp&ini&fim
 *  GET  /apuracao-mkt/resultado?emp=todas|zagodini|mae|lufe&ini&fim
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');
const bling = require('./bling');
const amazon = require('./amazon');
const cm = require('./custos_ml');

const DIR = path.join(DATA, 'apuracao_cache');
fs.mkdirSync(DIR, { recursive: true });
const delay = ms => new Promise(r => setTimeout(r, ms));
const r2 = v => Math.round((v || 0) * 100) / 100;
const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? 0 : n; };
const K = v => (v === null || v === undefined || v === '') ? '' : String(v).trim().toUpperCase();

const EMP = {
  zagodini: { nome: 'Zagodini',        idx: 0, erp: 'bling', amazon: 'zagodini', conta: 'zagodini' },
  mae:      { nome: 'Com Amor de Mãe', idx: 1, erp: 'bling', amazon: 'mae',      conta: 'camae' },
  lufe:     { nome: 'Lufe',            idx: 2, erp: 'tiny',  amazon: 'lufe' },
};
const CANAIS = ['Mercado Livre', 'Shopee', 'Amazon', 'Shein', 'TikTok'];

function canalDe(nome, numLoja) {
  const s = String(nome || '').toLowerCase(), n = String(numLoja || '').trim();
  if (/amazon/.test(s)) return 'Amazon';
  if (/shein/.test(s)) return 'Shein';
  if (/tik ?tok/.test(s)) return 'TikTok';
  if (s) return null;                                   // loja conhecida e de outro canal
  if (/^\d{3}-\d{7}-\d{7}$/.test(n)) return 'Amazon';
  if (/^GSH/i.test(n)) return 'Shein';
  if (/^\d{18,19}$/.test(n)) return 'TikTok';
  return null;
}

// ─── Arquivos de cache ─────────────────────────────────────────────────────
const lerJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const gravarJson = (f, o) => { try { fs.writeFileSync(f, JSON.stringify(o)); } catch (e) { console.warn('[apuracao-mkt] gravar', f, e.message); } };
const arqPedBling = idx => path.join(DIR, `apmkt_bling_${idx}.json`);        // { id: detalhe }
const arqPeriodo = (emp, ini, fim) => path.join(DIR, `apmkt_${emp}_${ini}_${fim}.json`);
const arqAmz = (emp, ini, fim) => path.join(DIR, `apmkt_amz_${emp}_${ini}_${fim}.json`);
const _pedBling = {};
const pedBling = idx => (_pedBling[idx] ||= lerJson(arqPedBling(idx), {}));

// planilhas antigas por canal (Zagodini / Mãe): custo e fixo por SKU
function mapaPlanilha(arquivo, conta, canal) {
  const j = lerJson(path.join(DATA, arquivo), {});
  return j?.[conta]?.[canal === 'Amazon' ? 'amazon' : 'shein'] || {};
}
function procurar(mapa, sku) {
  if (!mapa || !sku) return null;
  const pega = k => { const v = mapa[k]; if (v == null) return null; return typeof v === 'object' ? v : num(v) || null; };
  const s = K(sku);
  return pega(sku) ?? pega(s) ?? pega(s.replace(/^0+/, '')) ?? null;
}

// ─── Amazon: financeiro por pedido ─────────────────────────────────────────
async function financeiroAmazon(empKey, ini, fim, job) {
  const az = amazon.loja(EMP[empKey].amazon);
  if (!az.configurada()) return null;
  const amt = x => Number(x?.CurrencyAmount ?? x?.Amount ?? 0);
  // lançamentos saem no envio e devoluções chegam depois: busca até 45 dias depois do fim
  const ate = new Date(Math.min(Date.now() - 5 * 60e3, Date.parse(fim + 'T23:59:59-03:00') + 45 * 864e5)).toISOString();
  const desde = new Date(Date.parse(ini + 'T00:00:00-03:00')).toISOString();
  const ped = {};   // AmazonOrderId -> { com, tarifas, frete, principal, devolucao }
  let next = null, pg = 0;
  do {
    if (job?.cancelar) throw new Error('Cancelado');
    const d = await az.get('/finances/v0/financialEvents', next ? { NextToken: next } : { PostedAfter: desde, PostedBefore: ate, MaxResultsPerPage: 100 });
    const fe = d.payload?.FinancialEvents || {};
    for (const s of fe.ShipmentEventList || []) {
      const P = ped[s.AmazonOrderId] ||= { com: 0, tarifas: 0, frete: 0, principal: 0, devolucao: 0, estorno: 0 };
      P.venda = true;   // a venda (comissão) já foi lançada
      for (const it of s.ShipmentItemList || []) {
        P.principal += (it.ItemChargeList || []).filter(c => c.ChargeType === 'Principal').reduce((a, c) => a + amt(c.ChargeAmount), 0);
        // frete pago pelo cliente (abaixo de R$ 79): a Amazon repassa e depois cobra a etiqueta (MFNShippingChargeback) — se anulam
        P.freteCliente = (P.freteCliente || 0) + (it.ItemChargeList || []).filter(c => /^Shipping(Charge|Tax)$/.test(c.ChargeType)).reduce((a, c) => a + amt(c.ChargeAmount), 0)
          + (it.PromotionList || []).filter(x => /ship/i.test(x.PromotionType || x.PromotionId || '')).reduce((a, x) => a + amt(x.PromotionAmount), 0);   // desconto de frete (negativo)
        for (const f of it.ItemFeeList || []) { const v = -amt(f.FeeAmount); if (f.FeeType === 'Commission') P.com += v; else P.tarifas += v; }
      }
    }
    for (const s of fe.ServiceFeeEventList || []) {
      if (!s.AmazonOrderId) continue;
      // MFNShippingChargeback = etiqueta do envio cobrada do vendedor (frete); MFNPostageFee e outras = tarifa fixa
      const P = ped[s.AmazonOrderId] ||= { com: 0, tarifas: 0, frete: 0, principal: 0, devolucao: 0, estorno: 0 };
      for (const f of s.FeeList || []) { const v = -amt(f.FeeAmount); if (/ShippingChargeback|Shipping(Label|Charge)/i.test(f.FeeType || '')) P.frete += v; else P.tarifas += v; }
    }
    for (const s of fe.RefundEventList || []) {
      const P = ped[s.AmazonOrderId] ||= { com: 0, tarifas: 0, frete: 0, principal: 0, devolucao: 0, estorno: 0 };
      for (const it of s.ShipmentItemAdjustmentList || []) {
        P.devolucao -= (it.ItemChargeAdjustmentList || []).filter(c => c.ChargeType === 'Principal').reduce((a, c) => a + amt(c.ChargeAmount), 0);
        P.estorno += (it.ItemFeeAdjustmentList || []).reduce((a, f) => a + amt(f.FeeAmount), 0);   // comissão devolvida (+) menos taxa de reembolso (−)
      }
    }
    next = d.payload?.NextToken; pg++;
    if (job) job.fase = `Amazon ${EMP[empKey].nome}: financeiro pág. ${pg} (${Object.keys(ped).length} pedidos)`;
    if (next) await delay(2100);
  } while (next && pg < 120);
  return ped;
}


// ─── Mercado Livre e Shopee: direto das APIs ────────────────────────────────
let FONTES = {};
function setFontes(f) { FONTES = f || {}; }
const arqML = emp => path.join(DIR, `apmkt_ml_${emp}.json`);     // { ped: {id: pedido}, envio: {id: {custo, em}}, desc: {id: rebate} }
const arqShp = emp => path.join(DIR, `apmkt_shp_${emp}.json`);   // { sn: pedido + escrow }
const arqCanal = (emp, canal, ini, fim) => path.join(DIR, `apmkt_${canal}_${emp}_${ini}_${fim}.json`);
const diaSP = iso => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const diasEntre = (ini, fim) => { const out = []; for (let d = new Date(ini + 'T12:00:00Z'); d <= new Date(fim + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10)); return out; };
async function paralelo(lista, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < lista.length) { const x = lista[i++]; await fn(x); } })); }

async function buscarML(empKey, ini, fim, job) {
  const ml = FONTES.ml, idx = EMP[empKey].idx;
  if (!ml) return;
  const C = lerJson(arqML(empKey), { ped: {}, envio: {}, desc: {} });
  const uid = (await ml(idx, '/users/me')).id, ids = [], dias = diasEntre(ini, fim);
  for (let i = 0; i < dias.length; i++) {
    for (let off = 0; off < 5000; off += 50) {
      if (job.cancelar) throw new Error('Cancelado');
      const r = await ml(idx, '/orders/search', { seller: uid, 'order.date_created.from': dias[i] + 'T00:00:00.000-03:00', 'order.date_created.to': dias[i] + 'T23:59:59.999-03:00', limit: 50, offset: off, sort: 'date_asc' });
      for (const o of r.results || []) {
        C.ped[o.id] = { id: o.id, pack: o.pack_id || null, data: diaSP(o.date_created), status: o.status, ship: o.shipping?.id || null, cliente: o.buyer?.nickname || '',
          total: +o.total_amount || 0, refund: (o.payments || []).reduce((a, p) => a + (+p.transaction_amount_refunded || 0), 0), desconto: (o.tags || []).includes('order_has_discount'),
          itens: (o.order_items || []).map(x => ({ sku: x.item?.seller_sku || x.item?.seller_custom_field || '', titulo: x.item?.title || '', q: +x.quantity || 1, pu: +x.unit_price || 0, fee: +x.sale_fee || 0 })) };
        ids.push(o.id);
      }
      if ((r.results || []).length < 50) break;
    }
    job.fase = `Mercado Livre ${EMP[empKey].nome}: pedidos ${dias[i]} (${ids.length})`; job.pct = Math.max(job.pct, 80);
  }
  // frete pago pelo vendedor (por envio) e rebate do ML (desconto bancado pelo ML fora da tarifa)
  const recente = d => Date.now() - Date.parse(d + 'T12:00:00Z') < 10 * 864e5;
  const envios = [...new Set(ids.map(id => C.ped[id].ship).filter(Boolean))].filter(sid => !C.envio[sid] || recente(C.envio[sid].data || '2000-01-01'));
  let k = 0;
  await paralelo(envios, 4, async sid => {
    if (job.cancelar) return;
    try { const c = await ml(idx, '/shipments/' + sid + '/costs'); C.envio[sid] = { custo: +(c.senders || []).reduce((a, x) => a + (+x.cost || 0), 0), data: diaSP(new Date().toISOString()) }; } catch (e) {}
    if (++k % 50 === 0) { job.fase = `Mercado Livre ${EMP[empKey].nome}: frete dos envios ${k}/${envios.length}`; gravarJson(arqML(empKey), C); }
  });
  const comDesc = ids.filter(id => C.ped[id].desconto && C.desc[id] === undefined);
  await paralelo(comDesc, 4, async id => {
    try { const d = await ml(idx, '/orders/' + id + '/discounts');
      C.desc[id] = (d.details || []).filter(x => x.supplier?.funding_mode && x.supplier.funding_mode !== 'sale_fee').reduce((a, x) => a + (x.items || []).reduce((b, it) => b + Math.max(0, (+it.amounts?.total || 0) - (+it.amounts?.seller || 0)), 0), 0);
    } catch (e) { C.desc[id] = 0; }
  });
  gravarJson(arqML(empKey), C);
  gravarJson(arqCanal(empKey, 'ml', ini, fim), { ini, fim, geradoEm: new Date().toISOString(), ids });
}

async function buscarShopee(empKey, ini, fim, job) {
  const sp = require('./shopee').loja(empKey);
  if (!sp.getTokens().access_token) return;
  const C = lerJson(arqShp(empKey), {}), sns = [];
  const t0 = Math.floor(Date.parse(ini + 'T00:00:00-03:00') / 1000), t1 = Math.floor(Date.parse(fim + 'T23:59:59-03:00') / 1000);
  for (let a = t0; a <= t1; a += 15 * 86400) {
    const b = Math.min(t1, a + 15 * 86400 - 1);
    for (let cur = '', pg = 0; pg < 100; pg++) {
      if (job.cancelar) throw new Error('Cancelado');
      const d = await sp.shopeeGet('/api/v2/order/get_order_list', { time_range_field: 'create_time', time_from: a, time_to: b, page_size: 100, ...(cur ? { cursor: cur } : {}) });
      if (d.error) throw new Error('Shopee pedidos: ' + (d.message || d.error));
      sns.push(...(d.response?.order_list || []).map(o => o.order_sn));
      if (!d.response?.more) break; cur = d.response.next_cursor;
    }
  }
  job.fase = `Shopee ${EMP[empKey].nome}: ${sns.length} pedidos`;
  for (let i = 0; i < sns.length; i += 50) {
    if (job.cancelar) throw new Error('Cancelado');
    const d = await sp.shopeeGet('/api/v2/order/get_order_detail', { order_sn_list: sns.slice(i, i + 50).join(','), response_optional_fields: 'item_list,order_status,create_time,buyer_username,total_amount' });
    for (const o of d.response?.order_list || []) C[o.order_sn] = { ...(C[o.order_sn] || {}), sn: o.order_sn, data: diaSP(o.create_time * 1000), status: o.order_status, cliente: o.buyer_username || '', total: +o.total_amount || 0,
      itens: (o.item_list || []).map(x => ({ sku: x.model_sku || x.item_sku || '', titulo: x.item_name || '', q: +x.model_quantity_purchased || 1, pu: +x.model_discounted_price || +x.model_original_price || 0 })) };
  }
  // repasse (escrow): definitivo quando o pedido está concluído; antes disso é estimado e é buscado de novo
  const faltam = sns.filter(sn => C[sn] && !['CANCELLED', 'UNPAID'].includes(C[sn].status) && (!C[sn].esc || C[sn].escStatus !== 'COMPLETED'));
  let k = 0;
  await paralelo(faltam, 3, async sn => {
    if (job.cancelar) return;
    try {
      const d = await sp.shopeeGet('/api/v2/payment/get_escrow_detail', { order_sn: sn }); const e = d.response?.order_income;
      if (e) { C[sn].esc = { escrow: +e.escrow_amount || 0, comissao: +e.commission_fee || 0, servico: +e.service_fee || 0, transacao: +e.seller_transaction_fee || 0, freteReal: +e.actual_shipping_fee || 0,
        fretePago: +e.buyer_paid_shipping_fee || 0, freteRebate: +e.shopee_shipping_rebate || 0, voucher: +e.voucher_from_seller || 0, cogs: +e.cost_of_goods_sold || 0,
        itens: (e.items || []).map(x => ({ sku: x.model_sku || x.item_sku || '', q: +x.quantity_purchased || 1, preco: +x.discounted_price || 0, voucher: +x.discount_from_voucher_seller || 0, titulo: x.item_name || '' })) };
        C[sn].escStatus = C[sn].status; }
    } catch (e) {}
    if (++k % 40 === 0) { job.fase = `Shopee ${EMP[empKey].nome}: repasse ${k}/${faltam.length}`; gravarJson(arqShp(empKey), C); }
  });
  gravarJson(arqShp(empKey), C);
  gravarJson(arqCanal(empKey, 'shp', ini, fim), { ini, fim, geradoEm: new Date().toISOString(), sns });
}

// ─── Busca (em segundo plano) ──────────────────────────────────────────────
const jobs = {};
const arqSit = idx => path.join(DATA, 'apuracao_cache', `apmkt_sit_${idx}.json`);
async function situacoesBling(idx) {
  const c = bling.client(idx), out = {};
  const mods = (await c.get('/situacoes/modulos')).data?.data || [];
  const vendas = mods.find(m => /venda/i.test(m.nome || m.descricao || '')) || mods[0];
  if (vendas) for (const x of (await c.get(`/situacoes/modulos/${vendas.id}`)).data?.data || []) out[x.id] = x.nome || x.descricao || String(x.id);
  return out;
}
// pedido que não entra na apuração: cancelado / devolvido / estornado (Bling: nome da situação; Tiny: texto)
const SHEIN_PCT = 0.18;   // comissão da Shein: fixa em 18%
const FORA = /cancel|devolv|estorn|reembols|desfeit/i;

async function buscar(empKey, ini, fim) {
  const key = `${empKey}_${ini}_${fim}`, E = EMP[empKey];
  const job = jobs[key] = { rodando: true, fase: 'Iniciando...', pct: 1, erro: null, cancelar: false };
  try {
    if (E.erp === 'bling') {
      await bling.refreshToken(E.idx).catch(() => {});
      job.fase = 'Canais de venda do Bling...';
      const canais = await bling.getCanaisVenda(E.idx).catch(() => ({}));
      // lista todas as situações (menos cancelado), dia a dia para não passar de 2.000 por consulta
      const c = bling.client(E.idx), lista = [];
      const dias = []; for (let d = new Date(ini + 'T12:00:00Z'); d <= new Date(fim + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) dias.push(d.toISOString().slice(0, 10));
      for (let i = 0; i < dias.length; i++) {
        for (let pagina = 1; pagina <= 30; pagina++) {
          if (job.cancelar) throw new Error('Cancelado');
          let items;
          for (let t = 0; t < 6; t++) {
            try { items = (await c.get('/pedidos/vendas', { params: { dataInicial: dias[i], dataFinal: dias[i], limite: 100, pagina } })).data?.data || []; break; }
            catch (e) { if (e.response?.status === 429 && t < 5) await delay(4000 * (t + 1)); else throw e; }
          }
          lista.push(...items);
          if (items.length < 100) break;
          await delay(350);
        }
        job.fase = `Listando pedidos do Bling: ${dias[i]} (${lista.length})`; job.pct = 2 + Math.round(18 * (i + 1) / dias.length);
        await delay(350);
      }
      try { gravarJson(arqSit(E.idx), await situacoesBling(E.idx)); } catch (e) { console.warn('[apuracao-mkt] situações', e.message); }
      const doCanal = lista.filter(p => p.situacao?.id !== 12 && canalDe(canais[p.loja?.id], p.numeroLoja));
      const cache = pedBling(E.idx);
      const faltam = doCanal.filter(p => !cache[p.id] || cache[p.id].situacao?.id !== p.situacao?.id);
      for (let i = 0; i < faltam.length; i++) {
        if (job.cancelar) throw new Error('Cancelado');
        job.fase = `Detalhes no Bling: ${i + 1}/${faltam.length} (${doCanal.length - faltam.length} já baixados)`;
        job.pct = 20 + Math.round(55 * (i + 1) / faltam.length);
        try { const d = await bling.getPedidoDetalhe(E.idx, faltam[i].id); if (d) cache[faltam[i].id] = { ...d, _loja: canais[d.loja?.id] || '' }; }
        catch (e) { console.warn('[apuracao-mkt] pedido', faltam[i].id, e.message); }
        if ((i + 1) % 25 === 0) gravarJson(arqPedBling(E.idx), cache);
        await delay(650);
      }
      gravarJson(arqPedBling(E.idx), cache);
      gravarJson(arqPeriodo(empKey, ini, fim), { ini, fim, geradoEm: new Date().toISOString(), ids: doCanal.map(p => p.id) });
    } else {
      // Lufe: reaproveita a busca da apuração Tiny (cache de pedidos com canal)
      const tiny = require('./tiny_apuracao');
      job.fase = 'Buscando pedidos no Tiny...';
      await tiny.buscarPeriodo(ini, fim, j => { job.fase = 'Tiny: ' + j.fase; job.pct = Math.min(75, Math.round(j.pct * 0.75)); if (job.cancelar) j.cancelar = true; });
    }
    // SHEIN conectada: taxas reais por pedido (comissão + taxa de serviço) direto da API
    try {
      const shein = require('./shein');
      if (shein.autorizada(empKey)) {
        let nums = [];
        if (E.erp === 'bling') { const per = lerJson(arqPeriodo(empKey, ini, fim), { ids: [] }), cache = pedBling(E.idx); nums = per.ids.map(id => cache[id]).filter(p => p && canalDe(p._loja, p.numeroLoja) === 'Shein').map(p => p.numeroLoja); }
        else nums = (require('./tiny_apuracao').pedidosPeriodo(ini, fim) || []).filter(p => canalDe(p.ecommerce?.nomeEcommerce, p.numero_ecommerce) === 'Shein').map(p => p.numero_ecommerce);
        job.fase = `SHEIN: taxas de ${nums.length} pedidos...`; job.pct = 76;
        await shein.detalhes(empKey, nums, { prog: (i, n) => { job.fase = `SHEIN: taxas dos pedidos ${i}/${n}`; } });
      }
    } catch (e) { console.warn('[apuracao-mkt] SHEIN', empKey, e.message); job.avisoShein = e.message; }
    job.pct = 78; job.fase = 'Financeiro da Amazon...';
    try { const f = await financeiroAmazon(empKey, ini, fim, job); if (f) gravarJson(arqAmz(empKey, ini, fim), { geradoEm: new Date().toISOString(), pedidos: f }); }
    catch (e) { if (e.message === 'Cancelado') throw e; console.warn('[apuracao-mkt] financeiro Amazon', empKey, e.message); job.avisoAmazon = e.message; }
    job.pct = 80; job.fase = 'Mercado Livre...';
    try { await buscarML(empKey, ini, fim, job); } catch (e) { if (e.message === 'Cancelado') throw e; console.warn('[apuracao-mkt] ML', empKey, e.message); job.avisoML = e.message; }
    job.pct = 88; job.fase = 'Shopee...';
    try { await buscarShopee(empKey, ini, fim, job); } catch (e) { if (e.message === 'Cancelado') throw e; console.warn('[apuracao-mkt] Shopee', empKey, e.message); job.avisoShopee = e.message; }
    job.fase = 'Custos do ERP...'; job.pct = 95;
    cm.recarregarErp(E.idx);   // custos sempre atualizados do ERP a cada busca
    await cm.custosErp(E.idx).catch(() => {});
    Object.assign(job, { rodando: false, fase: 'Concluído!', pct: 100 });
  } catch (e) {
    Object.assign(job, { rodando: false, erro: e.message, fase: e.message === 'Cancelado' ? 'Cancelado' : 'Erro: ' + e.message });
  }
}

// ─── Cálculo ───────────────────────────────────────────────────────────────
async function calcular(empKey, ini, fim) {
  const E = EMP[empKey];
  const cfg = require('./config_empresas').porMlIdx(E.idx) || {};
  const aliq = cfg.imposto ?? 0.09, emb = cfg.embalagem ?? 0;
  const erp = await cm.custosErp(E.idx).catch(() => ({}));
  const fin = lerJson(arqAmz(empKey, ini, fim), null);
  const finPed = fin?.pedidos || {};
  const SH = (() => { try { const sh = require('./shein'); return sh.autorizada(empKey) ? sh.pedidosCache(empKey) : {}; } catch (e) { return {}; } })();
  // taxa real da SHEIN para o item (por unidade × qtd); null se o pedido não veio da API
  const sheinReal = (num, sku, q, receita, valPed) => { const P = SH[num]; const D = P?.itens?.[String(sku).toUpperCase()]; if (!D || !D.n) return null; const u = q / D.n; return { comissao: D.com * u, taxa: (D.fixo + D.serv) * u, frete: (P.frete || 0) * (valPed > 0 ? receita / valPed : 1), origem: 'SHEIN (real)' }; };
  const hist = lerJson(path.join(DIR, `amazon_anuncios_${E.amazon}.json`), {})?.hist?.porSku || {};
  const linhas = [];
  const custoDe = (sku, canal, extra) => {
    // custo só do sistema (Bling / Tiny): sem custo lá = alerta para corrigir no ERP (não usa planilha)
    const c = cm.custoComFonte(E.idx, sku, erp);
    if (c && c.fonte !== 'planilha') return [c.v, c.fonte];
    return [null, 'SEM CUSTO'];
  };
  // Lufe/Shein sem % na planilha: usa a comissão média que a Shein cobrou nos pedidos do Bling (Zagodini/Mãe)
  let _txSh = null;
  const taxaSheinBling = () => {
    if (_txSh != null) return _txSh;
    let com = 0, val = 0;
    for (const i of [0, 1]) for (const d of Object.values(pedBling(i))) {
      if (canalDe(d._loja, d.numeroLoja) !== 'Shein' || !(d.taxas?.valorBase > 0)) continue;
      com += num(d.taxas.taxaComissao); val += num(d.taxas.valorBase);
    }
    return (_txSh = val > 1000 ? com / val : 0.18);
  };
  const fora = [];   // pedidos cancelados / devolvidos que saíram da apuração
  const add = (o) => {
    // Amazon devolvida (financeiro): estorna a venda; o produto volta (custo e imposto saem na mesma proporção)
    o.devolucao = 0;
    if (o.canal === 'Amazon') {
      const F = finPed[o.pedidoCanal];
      if (F?.devolucao > 0) {
        const base = F.principal > 0 ? F.principal : o._valPed || o.receita;
        const p = o._valPed > 0 ? o.receita / o._valPed : 1, fr = Math.min(1, F.devolucao / base);
        o.devolucao = F.devolucao * p; o.cmv *= 1 - fr; o.imposto *= 1 - fr; o.taxa -= (F.estorno || 0) * p;
        o.origemTaxa += fr >= 0.999 ? ' · devolvido' : ' · devolução parcial';
      }
    }
    if (o._devolucao) { const fr = Math.min(1, o._devolucao / (o.receita || 1)); o.devolucao = o._devolucao; o.cmv *= 1 - fr; o.imposto *= 1 - fr; o.origemTaxa += ' · devolução parcial'; }
    delete o._devolucao;
    delete o._valPed;
    const lucro = o.receita - o.devolucao - o.cmv - o.comissao - o.taxa - o.frete - o.imposto - o.embalagem;
    linhas.push({ ...o, devolucao: r2(o.devolucao), cmv: r2(o.cmv), comissao: r2(o.comissao), taxa: r2(o.taxa), frete: r2(o.frete), imposto: r2(o.imposto), embalagem: r2(o.embalagem),
      lucro: r2(lucro), pct: (o.receita - o.devolucao) ? r2(lucro / (o.receita - o.devolucao) * 100) : 0 });
  };
  // Amazon: rateia as tarifas do pedido pelos itens (proporcional ao valor)
  const tarifasAmazon = (numLoja, valItem, valPed, sku, qtd, precoUn) => {
    const F = finPed[numLoja];
    const p = valPed > 0 ? valItem / valPed : 1;
    const h = hist[sku];
    const pct = h?.comPct ?? 0.12;
    if (F && (F.com || F.tarifas || F.frete)) {
      // só as taxas de serviço já lançadas (a venda/comissão a Amazon lança depois): comissão estimada
      if (F.venda === false || (!F.com && F.venda !== true)) {
        // venda ainda não lançada: abaixo de R$ 79 o cliente paga o frete (a etiqueta volta como ShippingCharge)
        const fr = valPed < 79 ? 0 : F.frete;
        return { comissao: valItem * pct, taxa: F.tarifas * p, frete: fr * p, origem: 'Amazon (taxa real, comissão estimada ' + Math.round(pct * 1000) / 10 + '%' + (valPed < 79 && F.frete ? ', frete pago pelo cliente' : '') + ')' };
      }
      const frLiq = F.freteCliente != null ? Math.max(0, F.frete - F.freteCliente) : F.frete;
      return { comissao: F.com * p, taxa: F.tarifas * p, frete: frLiq * p, origem: 'Amazon (real)' };
    }
    const fixo = precoUn < 30 ? 4.5 : precoUn < 50 ? 6.5 : precoUn < 79 ? 6.75 : 0;
    return { comissao: valItem * pct, taxa: (h?.outrasUn ?? fixo) * qtd, frete: (h?.freteUn ?? 0) * qtd, origem: 'estimada (sem lançamento ainda)' };
  };

  if (E.erp === 'bling') {
    const per = lerJson(arqPeriodo(empKey, ini, fim), null);
    if (!per) return { pendente: true };
    const cache = pedBling(E.idx);
    const fixoSh = mapaPlanilha('fixo_por_sku.json', E.conta, 'Shein');
    const sits = lerJson(arqSit(E.idx), {});
    for (const id of per.ids) {
      const p = cache[id]; if (!p || p.situacao?.id === 12) continue;
      const canal = canalDe(p._loja, p.numeroLoja); if (!canal) continue;
      const nomeSit = sits[p.situacao?.id] || '';
      if (FORA.test(nomeSit)) { fora.push({ empresa: E.nome, canal, data: (p.data || '').slice(0, 10), pedido: p.numero, pedidoCanal: p.numeroLoja || '', situacao: nomeSit, valor: num(p.total) }); continue; }
      const itens = p.itens || [];
      const valPed = itens.reduce((s, it) => s + num(it.valor) * (num(it.quantidade) || 1), 0);
      const com = num(p.taxas?.taxaComissao), fre = num(p.taxas?.custoFrete);
      itens.forEach((it, i) => {
        const sku = String(it.codigo || '').trim(), q = num(it.quantidade) || 1, pu = num(it.valor), receita = r2(pu * q);
        const [cu, origemCusto] = custoDe(sku, canal, s => { const m = procurar(mapaPlanilha('custo_por_sku.json', E.conta, canal), s); return typeof m === 'number' ? m : null; }) ;
        const prop = valPed > 0 ? receita / valPed : 1 / Math.max(itens.length, 1);
        let t;
        if (canal === 'Amazon') t = tarifasAmazon(p.numeroLoja, receita, valPed, sku, q, pu);
        else {
          // custo fixo da Shein por SKU: planilha de precificação (OneDrive) → planilha antiga
          let fx = null;
          if (canal === 'Shein') { const mp = cm.fixosCanal(E.idx, 'Shein'), k2 = sku.toUpperCase(); fx = mp[k2] ?? mp[k2.replace(/^0+/, '')] ?? procurar(fixoSh, sku); }
          // Shein: comissão fixa de 18% + custo fixo por SKU da planilha (regra do Diego); TikTok: taxas do Bling
          t = canal === 'Shein' && sheinReal(p.numeroLoja, sku, q, receita, valPed) ? sheinReal(p.numeroLoja, sku, q, receita, valPed)
            : canal === 'Shein'
            ? { comissao: receita * SHEIN_PCT, taxa: (typeof fx === 'number' ? fx : 0) * q, frete: fre * prop, origem: '18%' + (typeof fx === 'number' ? ' + fixo planilha' : ' (sem fixo na planilha)') }
            : { comissao: com * prop, taxa: 0, frete: fre * prop, origem: 'Bling' };
        }
        add({ empresa: E.nome, canal, data: (p.data || '').slice(0, 10), pedido: p.numero, pedidoCanal: p.numeroLoja || '', situacao: nomeSit || (p.situacao?.valor ?? ''),
          cliente: p.contato?.nome || '', sku, descricao: it.descricao || '', qtd: q, precoUn: r2(pu), receita, custoUn: cu, origemCusto,
          cmv: (cu || 0) * q, comissao: t.comissao, taxa: t.taxa, frete: t.frete, imposto: receita * aliq, embalagem: i === 0 ? emb : 0, origemTaxa: t.origem, _valPed: valPed });
      });
    }
  } else {
    const tiny = require('./tiny_apuracao');
    const lista = tiny.pedidosPeriodo(ini, fim);
    if (!lista) return { pendente: true };
    const P = tiny.planilhaLufe();
    for (const p of lista) {
      const canal = canalDe(p.ecommerce?.nomeEcommerce, p.numero_ecommerce); if (!canal) continue;
      if (FORA.test(p.situacao || '')) { fora.push({ empresa: E.nome, canal, data: (p.data_pedido || '').split('/').reverse().join('-'), pedido: p.numero, pedidoCanal: p.numero_ecommerce || '', situacao: p.situacao, valor: num(p.total_pedido) }); continue; }
      const tp = num(p.total_produtos), tped = num(p.total_pedido), fator = tp ? tped / tp : 1;
      const itens = p.itens || [];
      const valPed = itens.reduce((s, x) => s + num(x.item?.valor_unitario) * fator * num(x.item?.quantidade), 0);
      itens.forEach((x, i) => {
        const it = x.item || {}, sku = K(it.codigo), q = num(it.quantidade) || 1, pu = num(it.valor_unitario) * fator, receita = r2(pu * q);
        const [cu, origemCusto] = custoDe(sku, canal, s => P.custo(s));
        let t;
        if (canal === 'Amazon') t = tarifasAmazon(p.numero_ecommerce, receita, valPed, sku, q, pu);
        else { const rg = P.regra(canal, sku); t = canal === 'Shein' && sheinReal(p.numero_ecommerce, sku, q, receita, valPed) ? sheinReal(p.numero_ecommerce, sku, q, receita, valPed) : canal === 'Shein' ? { comissao: receita * SHEIN_PCT, taxa: (rg.fixo || 0) * q, frete: (rg.frete || 0) * q, origem: '18% + fixo planilha Lufe' } : { comissao: receita * (rg.rate || 0), taxa: (rg.fixo || 0) * q, frete: (rg.frete || 0) * q, origem: 'planilha Lufe' }; }
        add({ empresa: E.nome, canal, data: (p.data_pedido || '').split('/').reverse().join('-'), pedido: p.numero, pedidoCanal: p.numero_ecommerce || '', situacao: p.situacao,
          cliente: p.cliente?.nome || '', sku, descricao: it.descricao || '', qtd: q, precoUn: r2(pu), receita, custoUn: cu, origemCusto,
          cmv: (cu || 0) * q, comissao: t.comissao, taxa: t.taxa, frete: t.frete, imposto: receita * aliq, embalagem: i === 0 ? emb : 0, origemTaxa: t.origem, _valPed: valPed });
      });
    }
  }
  // ── Mercado Livre (API): preço − tarifa do ML (já com o desconto bancado pelo ML) − frete do vendedor + rebate ──
  const perML = lerJson(arqCanal(empKey, 'ml', ini, fim), null);
  if (perML) {
    const C = lerJson(arqML(empKey), { ped: {}, envio: {}, desc: {} });
    const porEnvio = {};
    for (const id of perML.ids) { const o = C.ped[id]; if (o?.ship && o.status !== 'cancelled') porEnvio[o.ship] = (porEnvio[o.ship] || 0) + o.total; }
    for (const id of perML.ids) {
      const o = C.ped[id]; if (!o) continue;
      const pedido = String(o.pack || o.id);
      if (o.status === 'cancelled' || (o.refund > 0 && o.refund >= o.total - 0.01)) { fora.push({ empresa: E.nome, canal: 'Mercado Livre', data: o.data, pedido, pedidoCanal: String(o.id), situacao: o.status === 'cancelled' ? 'cancelado' : 'devolvido', valor: o.total }); continue; }
      const freteOrd = o.ship && C.envio[o.ship] ? C.envio[o.ship].custo * (porEnvio[o.ship] ? o.total / porEnvio[o.ship] : 1) : 0;
      const rebate = C.desc[id] || 0, valPed = o.itens.reduce((a, x) => a + x.pu * x.q, 0) || o.total;
      o.itens.forEach((x, i) => {
        const receita = r2(x.pu * x.q), prop = valPed > 0 ? receita / valPed : 1;
        const [cu, origemCusto] = custoDe(x.sku, 'Mercado Livre');
        add({ empresa: E.nome, canal: 'Mercado Livre', data: o.data, pedido, pedidoCanal: String(o.id), situacao: o.status, cliente: o.cliente, sku: x.sku, descricao: x.titulo, qtd: x.q, precoUn: r2(x.pu), receita,
          custoUn: cu, origemCusto, cmv: (cu || 0) * x.q, comissao: x.fee * x.q - rebate * prop, taxa: 0, frete: freteOrd * prop, imposto: receita * aliq, embalagem: i === 0 ? emb : 0,
          origemTaxa: 'ML (real)' + (rebate ? ' · rebate ML' : '') + (C.envio[o.ship] ? '' : ' · frete pendente'), _valPed: valPed, _devolucao: o.refund > 0 ? o.refund * prop : 0 });
      });
    }
  }
  // ── Shopee (API): repasse real (escrow) = preço − comissão − taxas − frete ──
  const perShp = lerJson(arqCanal(empKey, 'shp', ini, fim), null);
  if (perShp) {
    const C = lerJson(arqShp(empKey), {});
    for (const sn of perShp.sns) {
      const o = C[sn]; if (!o || o.status === 'UNPAID') continue;
      if (['CANCELLED', 'IN_CANCEL'].includes(o.status)) { fora.push({ empresa: E.nome, canal: 'Shopee', data: o.data, pedido: sn, pedidoCanal: sn, situacao: o.status === 'IN_CANCEL' ? 'cancelando' : 'cancelado', valor: o.total }); continue; }
      const e = o.esc;
      // discounted_price pode vir por unidade ou pela linha: confere com o total de produtos (cost_of_goods_sold)
      const porLinha = e?.itens?.length && e.cogs ? Math.abs(e.itens.reduce((a, x) => a + x.preco, 0) - e.cogs) < Math.abs(e.itens.reduce((a, x) => a + x.preco * x.q, 0) - e.cogs) : true;
      const itens = e?.itens?.length ? e.itens.map(x => ({ sku: x.sku, q: x.q, receita: r2((porLinha ? x.preco : x.preco * x.q) - x.voucher), titulo: x.titulo })) : o.itens.map(x => ({ sku: x.sku, q: x.q, receita: r2(x.pu * x.q), titulo: x.titulo }));
      const recTot = itens.reduce((a, x) => a + x.receita, 0);
      let com = 0, frete = 0, taxa = 0, origem = 'Shopee (sem repasse ainda)';
      if (e) {
        frete = Math.max(0, e.freteReal - e.fretePago - e.freteRebate); com = e.comissao;
        taxa = Math.max(0, recTot - e.escrow - com - frete);
        origem = o.status === 'COMPLETED' ? 'Shopee (repasse real)' : 'Shopee (repasse estimado)';
      }
      itens.forEach((x, i) => {
        const prop = recTot > 0 ? x.receita / recTot : 1 / itens.length;
        const [cu, origemCusto] = custoDe(x.sku, 'Shopee');
        add({ empresa: E.nome, canal: 'Shopee', data: o.data, pedido: sn, pedidoCanal: sn, situacao: o.status, cliente: o.cliente, sku: x.sku, descricao: x.titulo, qtd: x.q, precoUn: r2(x.receita / (x.q || 1)), receita: x.receita,
          custoUn: cu, origemCusto, cmv: (cu || 0) * x.q, comissao: com * prop, taxa: taxa * prop, frete: frete * prop, imposto: x.receita * aliq, embalagem: i === 0 ? emb : 0, origemTaxa: origem, _valPed: recTot });
      });
    }
  }
  return { linhas, fora, amazonFinanceiro: fin?.geradoEm || null };
}

function resumir(linhas) {
  const campos = ['receita', 'devolucao', 'cmv', 'comissao', 'taxa', 'frete', 'imposto', 'embalagem', 'lucro'];
  const grupo = () => ({ pedidos: new Set(), itens: 0, ...Object.fromEntries(campos.map(c => [c, 0])) });
  const por = {}, tot = grupo();
  for (const l of linhas) {
    const k = l.empresa + '|' + l.canal, g = por[k] ||= { empresa: l.empresa, canal: l.canal, ...grupo() };
    for (const o of [g, tot]) { o.pedidos.add(l.empresa + l.pedido); o.itens += l.qtd; for (const c of campos) o[c] += l[c]; }
  }
  const fecha = o => ({ ...o, pedidos: o.pedidos.size, ...Object.fromEntries(campos.map(c => [c, r2(o[c])])), pct: (o.receita - o.devolucao) ? r2(o.lucro / (o.receita - o.devolucao) * 100) : 0 });
  return { grupos: Object.values(por).map(fecha).sort((a, b) => b.receita - a.receita), total: fecha(tot) };
}

// ─── Rotas ─────────────────────────────────────────────────────────────────
const router = express.Router();
const periodo = q => {
  const ok = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  if (!ok(q.ini) || !ok(q.fim) || q.ini > q.fim) throw new Error('Informe o período (de / até)');
  return [q.ini, q.fim];
};
router.post('/iniciar', (req, res) => {
  try {
    const [ini, fim] = periodo(req.query);
    const emps = req.query.emp === 'todas' ? Object.keys(EMP) : [req.query.emp].filter(e => EMP[e]);
    if (!emps.length) throw new Error('Empresa inválida');
    for (const e of emps) { const j = jobs[`${e}_${ini}_${fim}`]; if (!j?.rodando) buscar(e, ini, fim); }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, erro: e.message }); }
});
router.post('/cancelar', (req, res) => { for (const j of Object.values(jobs)) j.cancelar = true; res.json({ ok: true }); });
router.get('/status', (req, res) => {
  try {
    const [ini, fim] = periodo(req.query);
    const emps = req.query.emp === 'todas' ? Object.keys(EMP) : [req.query.emp].filter(e => EMP[e]);
    res.json(Object.fromEntries(emps.map(e => [e, jobs[`${e}_${ini}_${fim}`] || null])));
  } catch (e) { res.status(400).json({ erro: e.message }); }
});
router.get('/resultado', async (req, res) => {
  try {
    const [ini, fim] = periodo(req.query);
    const emps = req.query.emp === 'todas' ? Object.keys(EMP) : [req.query.emp].filter(e => EMP[e]);
    const linhas = [], pendentes = [], amz = {}, fora = [];
    for (const e of emps) {
      const r = await calcular(e, ini, fim);
      if (r.pendente) pendentes.push(EMP[e].nome); else { linhas.push(...r.linhas); fora.push(...r.fora); amz[EMP[e].nome] = r.amazonFinanceiro; }
    }
    const canal = CANAIS.includes(req.query.canal) ? req.query.canal : null;
    const L = (canal ? linhas.filter(l => l.canal === canal) : linhas).sort((a, b) => a.data < b.data ? -1 : a.data > b.data ? 1 : 0);
    const semCusto = {};
    for (const l of L) if (l.custoUn == null) { const s = semCusto[l.empresa + '|' + l.sku] ||= { empresa: l.empresa, canal: l.canal, sku: l.sku, descricao: l.descricao, qtd: 0, receita: 0 }; s.qtd += l.qtd; s.receita = r2(s.receita + l.receita); }
    res.json({ ini, fim, pendentes, amazonFinanceiro: amz, ...resumir(L), semCusto: Object.values(semCusto).sort((a, b) => b.receita - a.receita), foraApuracao: canal ? fora.filter(f => f.canal === canal) : fora, linhas: L });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});
// diagnóstico (admin): um pedido do Bling por canal, para conferir as taxas que vêm
router.get('/debug-pedido', async (req, res) => {
  if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
  const idx = parseInt(req.query.idx) || 0, cache = pedBling(idx);
  const p = Object.values(cache).find(x => canalDe(x._loja, x.numeroLoja) === (req.query.canal || 'TikTok'));
  res.json(p ? { numeroLoja: p.numeroLoja, loja: p._loja, situacao: p.situacao, taxas: p.taxas, total: p.total, totalProdutos: p.totalProdutos, transporte: p.transporte?.frete, itens: (p.itens || []).map(i => ({ codigo: i.codigo, valor: i.valor, quantidade: i.quantidade, precoCompra: i.precoCompra })) } : { nada: true });
});

// ─── Automático: todo dia depois da meia-noite (horário de Brasília) ─────────
// Dia 2..31 → do dia 1 do mês até ontem. Dia 1 → o mês anterior inteiro (fecha o mês).
// Depois reapura o mês anterior inteiro (devoluções, cancelamentos e estornos que chegam depois).
const ARQ_AUTO = path.join(DATA, 'apuracao_cache', 'apmkt_auto.json');
const hojeSP = () => new Date(Date.now() - 3 * 3600e3);          // Brasil sem horário de verão
const ymd = d => d.toISOString().slice(0, 10);
function periodoAuto() {
  const h = hojeSP(), ontem = new Date(h.getTime() - 864e5);
  return [ymd(new Date(Date.UTC(ontem.getUTCFullYear(), ontem.getUTCMonth(), 1))), ymd(ontem)];
}
let _autoRodando = false;
async function rodarAuto(motivo) {
  if (_autoRodando) return;
  _autoRodando = true;
  const [ini, fim] = periodoAuto(), hoje = ymd(hojeSP());
  const st = { data: hoje, ini, fim, inicio: new Date().toISOString(), fimExec: null, motivo, erros: {}, ok: lerJson(ARQ_AUTO, {})?.ok || null };
  try { fs.mkdirSync(path.dirname(ARQ_AUTO), { recursive: true }); fs.writeFileSync(ARQ_AUTO, JSON.stringify(st)); } catch (e) {}
  try {
    const d = new Date(ini + 'T12:00:00Z');
    const antIni = ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))), antFim = ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)));
    st.anterior = { ini: antIni, fim: antFim };
    for (const [a, b, rot] of [[ini, fim, ''], [antIni, antFim, ' (mês anterior)']]) {
      st.fase = 'Apurando ' + a + ' a ' + b + rot;
      try { fs.writeFileSync(ARQ_AUTO, JSON.stringify(st)); } catch (e) {}
      await Promise.all(Object.keys(EMP).map(async e => {
        const j = jobs[`${e}_${a}_${b}`]; if (j?.rodando) return;
        await buscar(e, a, b);
        const r = jobs[`${e}_${a}_${b}`]; if (r?.erro) st.erros[e + rot] = r.erro;
      }));
    }
    delete st.fase;
  } catch (e) { st.erros.geral = e.message; }
  st.fimExec = new Date().toISOString();
  st.ok = { ini, fim, em: st.fimExec };   // último período completo (a tela abre nele enquanto a próxima rodada roda)
  try { fs.writeFileSync(ARQ_AUTO, JSON.stringify(st)); } catch (e) {}
  if (Object.keys(st.erros).length) try { require('./telegram').sendTelegram('⚠️ Apuração automática (' + ini + ' a ' + fim + ') com erro: ' + Object.entries(st.erros).map(([k, v]) => k + ': ' + v).join(' | ')); } catch (e) {}
  _autoRodando = false;
}
// confere a cada 10 min: entre 00:15 e 06:00, se ainda não rodou hoje (ou se o servidor reiniciou no meio)
setInterval(() => {
  const h = hojeSP(), min = h.getUTCHours() * 60 + h.getUTCMinutes();
  if (min < 15 || min > 360) return;
  const st = lerJson(ARQ_AUTO, {});
  if (st.data === ymd(h) && st.fimExec) return;
  rodarAuto(st.data === ymd(h) ? 'retomada' : 'agendada');
}, 10 * 60e3).unref?.();
router.get('/auto', (req, res) => {
  const st = lerJson(ARQ_AUTO, null), [ini, fim] = periodoAuto();
  res.json({ ultima: st, proximo: { ini, fim }, rodando: _autoRodando });
});
router.post('/auto/rodar', (req, res) => { rodarAuto('manual'); res.json({ ok: true }); });

module.exports = { router, setFontes };
