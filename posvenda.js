/**
 * Pós-venda (devoluções e reclamações) — Mercado Livre, Shopee e SHEIN, por empresa.
 *
 *  - Para analisar: o marketplace está esperando uma decisão do vendedor
 *      ML: reclamação aberta em que o vendedor pode reembolsar / abrir disputa / tem ação obrigatória
 *      Shopee: devolução com status REQUESTED (aguardando resposta do vendedor)
 *      (a SHEIN não pede análise do vendedor: aprova sozinha)
 *  - Chegou na empresa: o produto devolvido foi entregue no endereço do vendedor (últimos 30 dias).
 *      Fica na lista até alguém marcar "conferido" no painel.
 *      ML: devolução entregue em seller_address (ou com "revisar devolução" pendente)
 *      Shopee: logística reversa LOGISTICS_DELIVERY_DONE
 *      SHEIN: devolução recebida pelo vendedor (sellerSignedTime)
 *  - A caminho: devolução postada, ainda não chegou (só contagem)
 *
 *  GET  /posvenda                 situação de todas as empresas
 *  POST /posvenda/conferido       { chave, conferido }
 *  POST /posvenda/atualizar
 */
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');

const EMP = [
  { id: 'zagodini', nome: 'Comercial Zagodini', idx: 0 },
  { id: 'mae', nome: 'Com Amor de Mãe', idx: 1 },
  { id: 'lufe', nome: 'Lufe Casa & Decoração', idx: 2 },
];
const ARQ = path.join(DATA, 'apuracao_cache', 'posvenda.json');
const ARQ_CONF = path.join(DATA, 'apuracao_cache', 'posvenda_conferidos.json');
const lerJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const gravar = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch (e) {} };
const delay = ms => new Promise(r => setTimeout(r, ms));
const DIAS = 30;
const iso = v => v ? new Date(typeof v === 'number' ? v * 1000 : v).toISOString() : null;

const ST = lerJson(ARQ, {});
const _tit = {};                      // item_id -> título/foto (anúncios fora da lista do painel)          // emp -> { em, ml, shopee, shein }
const CONF = lerJson(ARQ_CONF, {});   // chave -> { em, por }

// ─── Mercado Livre ──────────────────────────────────────────────────────────
const ACOES_ANALISE = new Set(['refund', 'open_dispute', 'allow_return', 'allow_partial_refund', 'partial_refund']);
const ACOES_REVISAR = new Set(['return_review_ok', 'return_review_fail', 'return_review_unified_ok', 'return_review_unified_fail']);
const MOTIVO_ML = { mediations: 'mediação', returns: 'devolução', ml_case: 'caso ML', cancel_purchase: 'cancelamento', change: 'troca' };

async function coletarML(ctx, e) {
  const { ml, dadosCache } = ctx;
  const d = dadosCache[e.idx];
  const itens = {};
  for (const x of [...(d?.semPromo || []), ...(d?.comPromo || []), ...(d?.semPromoIgnorados || [])]) itens[x.id] = x;
  const out = { analisar: [], chegou: [], caminho: 0, disputa: 0 };
  const limite = Date.now() - DIAS * 864e5;
  const devolucao = async id => { try { return await ml(e.idx, '/post-purchase/v2/claims/' + id + '/returns'); } catch (er) { return null; } };
  const item = async (r, c) => {
    const o = { ...((r?.orders || [])[0] || {}) };
    if (!o.item_id && c.resource === 'order' && c.resource_id) {   // reclamação sem devolução: item vem do pedido
      try { const p = await ml(e.idx, '/orders/' + c.resource_id); const oi = (p.order_items || [])[0]?.item || {}; o.item_id = oi.id; o.order_id = c.resource_id;
        if (oi.id && !itens[oi.id] && !_tit[oi.id]) _tit[oi.id] = { title: oi.title, _sku: oi.seller_sku || oi.seller_custom_field || '' }; } catch (er) {}
    }
    if (o.item_id && !itens[o.item_id]) {
      if (!_tit[o.item_id]) try { const x = await ml(e.idx, '/items/' + o.item_id, { attributes: 'id,title,thumbnail,seller_custom_field' }); _tit[o.item_id] = { title: x.title, thumbnail: x.thumbnail, _sku: x.seller_custom_field || '' }; } catch (er) { _tit[o.item_id] = {}; }
      itens[o.item_id] = _tit[o.item_id];
    }
    const it = itens[o.item_id] || {};
    const orderId = o.order_id || c.resource_id;
    return { item: o.item_id || null, titulo: it.title || o.item_id || 'Pedido ' + orderId, thumb: it.thumbnail || null, sku: it._sku || '', pedido: String(orderId || ''),
      link: orderId ? 'https://www.mercadolivre.com.br/vendas/' + orderId + '/detalhe' : 'https://www.mercadolivre.com.br/vendas/omni/lista' };
  };
  const quandoChegou = r => {
    for (const s of r?.shipments || []) for (const h of s.status_history || []) if (h.status === 'delivered') return h.date;
    return r?.last_updated || null;
  };
  const vistos = new Set();
  const tratar = async (c, aberto) => {
    if (vistos.has(c.id)) return; vistos.add(c.id);
    const sel = (c.players || []).find(p => p.type === 'seller' || p.role === 'respondent') || {};
    const acoes = sel.available_actions || [];
    // revisar a devolução só quando o ML exige (ação obrigatória com prazo); opcional = já passou do prazo / não precisa
    const revisar = acoes.some(a => ACOES_REVISAR.has(a.action) && a.mandatory);
    const comDev = c.type === 'returns' || (c.related_entities || []).includes('return') || acoes.some(a => ACOES_REVISAR.has(a.action));
    // reclamação aberta: confere sempre se já virou devolução (o ML nem sempre marca related_entities)
    const r = (comDev || aberto) ? await devolucao(c.id) : null;
    const temDev = !!(r && r.status && (r.shipments || []).length);
    const sh = (r?.shipments || []).find(s => s.destination?.name === 'seller_address');
    const base = { chave: 'ml|' + c.id, canal: 'ml', id: String(c.id), tipo: MOTIVO_ML[c.type] || c.type, etapa: c.stage, aberto, ...(await item(r, c)) };
    if (revisar || sh?.status === 'delivered') {
      // só entra o que pede ação sua: revisar a devolução que chegou (o resto o ML já resolveu)
      if (revisar)
        out.chegou.push({ ...base, chegouEm: quandoChegou(r), acao: revisar ? 'revisar a devolução no ML' : null, prazo: acoes.find(a => ACOES_REVISAR.has(a.action) && a.mandatory)?.due_date || null });
      return;
    }
    if (sh && ['shipped', 'ready_to_ship'].includes(sh.status)) out.caminho++;
    if (!aberto) return;
    // só o que depende de você: ação obrigatória com prazo, ou reclamação do comprador (sem devolução) esperando sua resposta.
    // devolução comum (o cliente posta e o ML cuida) e mediação nas mãos do ML não entram.
    const reclamacao = c.type === 'mediations' && c.stage === 'claim' && !comDev && !temDev;
    const decide = acoes.filter(a => a.mandatory && !['recontact'].includes(a.action) && !ACOES_REVISAR.has(a.action));   // só o que o ML exige de você
    if (decide.length) out.analisar.push({ ...base, acoes: decide.map(a => a.action), prazo: decide.map(a => a.due_date).filter(Boolean).sort()[0] || null, criado: c.date_created });
    else if (c.stage === 'dispute') out.disputa++;
  };
  // abertas
  for (let off = 0; off < 300; off += 50) {
    const s = await ml(e.idx, '/post-purchase/v1/claims/search', { status: 'opened', limit: 50, offset: off });
    for (const c of s.data || []) await tratar(c, true);
    if ((s.data || []).length < 50) break;
  }
  // fechadas recentes (o produto pode chegar depois do reembolso)
  for (let off = 0; off < 300; off += 50) {
    const s = await ml(e.idx, '/post-purchase/v1/claims/search', { status: 'closed', limit: 50, offset: off, sort: 'last_updated:desc' });
    const L = s.data || [];
    for (const c of L) if (Date.parse(c.last_updated) >= limite && (c.type === 'returns' || (c.related_entities || []).includes('return'))) await tratar(c, false);
    if (L.length < 50 || Date.parse(L[L.length - 1].last_updated) < limite) break;
  }
  // número da venda como aparece no ML (pacote, quando o pedido faz parte de um carrinho)
  for (const x of [...out.analisar, ...out.chegou]) {
    try { const o = await ml(e.idx, '/orders/' + x.pedido); if (o.pack_id) { x.pedidoId = x.pedido; x.pedido = String(o.pack_id); x.link = 'https://www.mercadolivre.com.br/vendas/' + o.pack_id + '/detalhe'; } } catch (er) {}
  }
  return out;
}

const MOTIVO_SHP = { ITEM_MISSING: 'item faltando', WRONG_ITEM: 'item errado', FUNCTIONAL_DMG: 'com defeito', PHYSICAL_DMG: 'avariado', ITEM_DAMAGED: 'avariado', DAMAGED_PACKAGE: 'embalagem danificada',
  CHANGE_MIND: 'desistência', DIFFERENT_DESCRIPTION: 'diferente do anúncio', NOT_RECEIPT: 'não recebido', LACKING_ACCESSORIES: 'faltando acessórios', USED: 'produto usado', EXPECTATION_FAILED: 'não atendeu à expectativa', COUNTERFEIT: 'falsificado', MUTUAL_AGREE: 'acordo com o comprador' };
// ─── Shopee ─────────────────────────────────────────────────────────────────
async function coletarShopee(e) {
  const sp = require('./shopee').loja(e.id);
  if (!sp.getTokens().access_token) return { naoConectada: true };
  const out = { analisar: [], chegou: [], caminho: 0, disputa: 0 };
  const agora = Math.floor(Date.now() / 1000), L = [];
  for (let w = 0; w < DIAS / 15; w++) {
    const to = agora - w * 15 * 86400, from = to - 15 * 86400 + 1;
    for (let pg = 0; pg < 20; pg++) {
      const d = await sp.shopeeGet('/api/v2/returns/get_return_list', { page_no: pg, page_size: 50, update_time_from: from, update_time_to: to });
      if (d.error) throw new Error('Shopee devoluções: ' + (d.message || d.error));
      L.push(...(d.response?.return || []));
      if (!d.response?.more) break;
    }
  }
  const vistos = new Set();
  for (const r0 of L) {
    if (vistos.has(r0.return_sn) || ['CANCELLED'].includes(r0.status)) continue;
    vistos.add(r0.return_sn);
    const it = (r0.item || [])[0] || {};
    const base = { chave: 'shopee|' + r0.return_sn, canal: 'shopee', id: r0.return_sn, pedido: r0.order_sn, tipo: 'devolução' + (r0.reason ? ' · ' + (MOTIVO_SHP[r0.reason] || r0.reason.toLowerCase().replace(/_/g, ' ')) : ''),
      titulo: it.name || r0.order_sn, thumb: (it.images || [])[0] || null, sku: it.variation_sku || it.item_sku || '', valor: r0.refund_amount, status: r0.status,
      link: 'https://seller.shopee.com.br/portal/sale/returnrefundcancel?search=' + encodeURIComponent(r0.order_sn) };
    if (r0.status === 'REQUESTED') { out.analisar.push({ ...base, prazo: iso(r0.due_date), criado: iso(r0.create_time) }); continue; }
    if (['SELLER_DISPUTE', 'JUDGING'].includes(r0.status)) out.disputa++;
    if (!r0.needs_logistics) continue;
    let det;
    try { det = (await sp.shopeeGet('/api/v2/returns/get_return_detail', { return_sn: r0.return_sn })).response || {}; } catch (er) { continue; }
    await delay(80);
    const lg = det.reverse_logistics_status || '';
    if (lg === 'LOGISTICS_DELIVERY_DONE') {
      if (r0.status === 'PROCESSING') out.chegou.push({ ...base, chegouEm: iso(det.update_time || r0.update_time), prazo: r0.status === 'PROCESSING' && r0.return_seller_due_date ? iso(r0.return_seller_due_date) : null,
        acao: r0.status === 'PROCESSING' ? 'validar a devolução na Shopee' : null });
    } else if (/PICKUP_DONE|IN_TRANSIT|PICKUP|ARRANGE|REQUEST_CREATED/.test(lg) && r0.status !== 'CLOSED') out.caminho++;
  }
  return out;
}

// ─── SHEIN ──────────────────────────────────────────────────────────────────
const ST_SHEIN = { 2: 'aguardando envio do cliente', 5: 'recebida pelo vendedor', 7: 'em trânsito', 8: 'reembolsada', 9: 'finalizada' };
async function coletarShein(e) {
  const shein = require('./shein');
  if (!shein.autorizada(e.id)) return { naoConectada: true };
  const out = { analisar: [], chegou: [], caminho: 0, disputa: 0 };
  const fmt = d => d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const nos = new Set();
  for (let i = 0; i < DIAS / 2 + 1; i++) {
    const fim = new Date(Date.now() + 864e5 - i * 2 * 864e5), ini = new Date(fim - 2 * 864e5 + 1000);
    for (let page = 1; page <= 10; page++) {
      const r = await shein.api(e.id, '/open-api/return-order/list', { page, pageSize: 20, queryType: 1, startTime: fmt(ini) + ' 00:00:00', endTime: fmt(fim) + ' 00:00:00' });
      if (r.code !== '0') throw new Error('SHEIN devoluções: ' + r.msg);
      const L = r.info?.returnOrderList || [];
      for (const x of L) nos.add(x.returnOrderNo);
      if (L.length < 20) break;
    }
    await delay(150);
  }
  const lista = [...nos];
  for (let i = 0; i < lista.length; i += 20) {
    const d = await shein.api(e.id, '/open-api/return-order/details', { returnOrderNoList: lista.slice(i, i + 20) });
    for (const x of d.info || []) {
      if (x.cancelTime) continue;
      const g = (x.returnGoodsInfoList || [])[0] || {};
      const base = { chave: 'shein|' + x.returnOrderNo, canal: 'shein', id: x.returnOrderNo, pedido: x.orderNo, tipo: 'devolução', status: ST_SHEIN[x.returnOrderStatus] || 'status ' + x.returnOrderStatus,
        titulo: g.goodsName || g.goodsTitle || g.skuSn || x.orderNo, sku: g.skuSn || g.goodsSn || '', thumb: g.goodsImg || g.imgUrl || null,
        link: 'https://sso.geiwohuo.com/#/order-management/return-order-list?returnOrderNo=' + encodeURIComponent(x.returnOrderNo) };
      const recebida = x.sellerSignedTime ? new Date(x.sellerSignedTime.replace(' ', 'T') + '+08:00') : null;
      if (recebida && x.returnOrderStatus === 5) { if (false && x.checkStatus === 2) out.chegou.push({ ...base, chegouEm: recebida.toISOString(), acao: 'conferir a devolução na SHEIN' }); }
      else if ([2, 7].includes(x.returnOrderStatus)) out.caminho++;
    }
    await delay(150);
  }
  return out;
}

module.exports = function montar(app, ctx) {
  let rodando = false;
  async function atualizar() {
    if (rodando) return; rodando = true;
    try {
      for (const e of EMP) {
        const R = ST[e.id] ||= {};
        {
          try { R.ml = await coletarML(ctx, e); } catch (er) { R.ml = { ...(R.ml || {}), erro: er.response?.status === 401 ? 'token ML expirado' : (er.response?.data?.message || er.message) }; }
        }
        try { R.shopee = await coletarShopee(e); } catch (er) { R.shopee = { ...(R.shopee || {}), erro: er.message }; }
        try { R.shein = await coletarShein(e); } catch (er) { R.shein = { ...(R.shein || {}), erro: er.message }; }
        R.em = new Date().toISOString();
        gravar(ARQ, ST);
      }
    } finally { rodando = false; }
  }
  setTimeout(() => atualizar().catch(er => console.warn('[posvenda]', er.message)), 90e3);
  setInterval(() => atualizar().catch(er => console.warn('[posvenda]', er.message)), 20 * 60e3).unref?.();

  const visao = () => Object.fromEntries(EMP.map(e => {
    const R = ST[e.id] || {};
    const canal = c => {
      const x = R[c]; if (!x) return null;
      if (x.naoConectada) return { naoConectada: true };
      const chegou = (x.chegou || []).map(i => ({ ...i, conferido: CONF[i.chave] || null })).sort((a, b) => String(b.chegouEm || '').localeCompare(String(a.chegouEm || '')));
      return { erro: x.erro || null, analisar: x.analisar || [], chegou: chegou.filter(i => !i.conferido), conferidos: chegou.filter(i => i.conferido), caminho: x.caminho || 0, disputa: x.disputa || 0 };
    };
    return [e.id, { nome: e.nome, idx: e.idx, em: R.em || null, ml: canal('ml'), shopee: canal('shopee'), shein: canal('shein') }];
  }));
  app.get('/posvenda', (req, res) => res.json({ rodando, empresas: visao() }));
  app.post('/posvenda/atualizar', (req, res) => { atualizar().catch(() => {}); res.json({ ok: true }); });
  app.post('/posvenda/conferido', require('express').json(), (req, res) => {
    const chave = String(req.body?.chave || '');
    if (!/^(ml|shopee|shein)\|/.test(chave)) return res.status(400).json({ erro: 'chave inválida' });
    if (req.body?.conferido === false) delete CONF[chave];
    else CONF[chave] = { em: new Date().toISOString(), por: req.usuario?.nome || req.usuario?.email || null };
    // limpa marcações com mais de 90 dias
    for (const [k, v] of Object.entries(CONF)) if (Date.now() - Date.parse(v.em) > 90 * 864e5) delete CONF[k];
    gravar(ARQ_CONF, CONF);
    res.json({ ok: true });
  });
  return { visao };
};
