/**
 * Promoções do Mercado Livre por anúncio: todas as opções disponíveis, com margem, rebate do ML e efeito no catálogo,
 * ordenadas da maior margem para a menor, e botão para entrar direto pelo painel.
 *
 *  - Opções: GET /seller-promotions/items/{id}?app_version=v2 (candidatas, programadas e ativas)
 *  - Preço de cada opção: preço da oferta (SMART/PRICE_MATCHING/campanhas do ML) ou o maior preço permitido
 *    (DEAL, desconto próprio) — o de melhor margem dentro da regra
 *  - Rebate: original_price × meli_percentage (parte do desconto que o ML banca)
 *  - Margem: custos_ml.margemPreco (custo do Bling/Tiny, tarifa e frete do ML, imposto, embalagem)
 *  - Catálogo: ganhando/perdendo e preço para ganhar (dados do painel)
 *  - Alerta: oferta com rebate que dá lucro maior que o atual
 *
 *  GET  /ml/promos/:idx                 situação + itens
 *  POST /ml/promos/:idx/recarregar
 *  POST /ml/promos/:idx/entrar          { item, opcao }  (índice da opção na lista do item)
 */
const cm = require('./custos_ml');

const NOME_TIPO = { SMART: 'Oferta do ML (co-participação)', PRICE_MATCHING: 'Preço competitivo', PRICE_MATCHING_MELI_ALL: 'Preço competitivo (ML banca)', MARKETPLACE_CAMPAIGN: 'Campanha do ML',
  DEAL: 'Campanha', SELLER_CAMPAIGN: 'Campanha do vendedor', PRICE_DISCOUNT: 'Desconto próprio', LIGHTNING: 'Oferta relâmpago', DOD: 'Oferta do dia', UNHEALTHY_STOCK: 'Estoque parado', PRE_NEGOTIATED: 'Pré-negociada', VOLUME: 'Desconto por quantidade' };
// como entrar em cada tipo pela API
const ENTRA = {
  SMART: o => ({ promotion_id: o.id, promotion_type: o.tipo, offer_id: o.ref }),
  PRICE_MATCHING: o => ({ promotion_id: o.id, promotion_type: o.tipo, offer_id: o.ref }),
  PRICE_MATCHING_MELI_ALL: o => ({ promotion_id: o.id, promotion_type: o.tipo, offer_id: o.ref }),
  UNHEALTHY_STOCK: o => ({ promotion_id: o.id, promotion_type: o.tipo, offer_id: o.ref }),
  PRE_NEGOTIATED: o => ({ promotion_id: o.id, promotion_type: o.tipo, offer_id: o.ref }),
  MARKETPLACE_CAMPAIGN: o => ({ promotion_id: o.id, promotion_type: o.tipo }),
  DEAL: o => ({ promotion_id: o.id, promotion_type: o.tipo, deal_price: o.preco }),
  SELLER_CAMPAIGN: o => ({ promotion_id: o.id, promotion_type: o.tipo, deal_price: o.preco }),
  PRICE_DISCOUNT: o => ({ promotion_type: 'PRICE_DISCOUNT', deal_price: o.preco, start_date: new Date().toISOString().slice(0, 19), finish_date: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 19) }),
};
const IGNORAR = new Set(['SELLER_COUPON_CAMPAIGN', 'VOLUME']);   // cupom e "leve mais" não mudam o preço do anúncio
const STATUS = { candidate: 'disponível', pending: 'programada', started: 'ativa' };
const r2 = v => Math.round(v * 100) / 100;
const delay = ms => new Promise(r => setTimeout(r, ms));

const ST = {};   // idx -> { status, feito, total, em, itens, erro }
let F;           // funções do server.js

async function opcoesItem(idx, uid, it, cat, erp) {
  let lista = [];
  try { lista = await F.ml(idx, '/seller-promotions/items/' + it.id, { app_version: 'v2' }); } catch (e) { lista = []; }
  if (!Array.isArray(lista)) lista = [];
  const precoAtual = it.sale_amount && it.sale_amount < (it.regular_amount || it.original_price || it.price) ? it.sale_amount : it.price;
  const ativa = lista.find(p => p.status === 'started' && Math.abs((+p.price || 0) - precoAtual) < 0.05);
  const rebAtual = ativa && +ativa.meli_percentage > 0 ? r2((+ativa.original_price || 0) * +ativa.meli_percentage / 100) : 0;
  const atual = await cm.margemPreco(F.ml, idx, uid, it, precoAtual, rebAtual, erp);
  const opcoes = [];
  for (const p of lista) {
    if (IGNORAR.has(p.type) || !STATUS[p.status]) continue;
    const preco = +p.price > 0 ? +p.price : (+p.max_discounted_price || +p.suggested_discounted_price || 0);
    if (!(preco > 0)) continue;
    const reb = +p.meli_percentage > 0 ? r2((+p.original_price || it.price) * +p.meli_percentage / 100) : 0;
    const m = await cm.margemPreco(F.ml, idx, uid, it, preco, reb, erp);
    const o = { id: p.id || null, ref: p.ref_id || p.offer_id || null, tipo: p.type, tipoNome: NOME_TIPO[p.type] || p.type, nome: p.name || NOME_TIPO[p.type] || p.type,
      status: p.status, situacao: STATUS[p.status], preco: r2(preco), original: +p.original_price || null, meliPct: +p.meli_percentage || 0, rebate: reb,
      faixa: p.min_discounted_price ? [+p.min_discounted_price, +p.max_discounted_price] : null, fim: p.finish_date || null, m,
      podeEntrar: p.status === 'candidate' && !!ENTRA[p.type] };
    if (cat) o.catalogo = cat.status === 'winning' ? (cat.s2price ? (preco < cat.s2price ? 'continua ganhando' : 'pode perder') : 'continua ganhando') : (cat.ptw ? (preco <= cat.ptw + 0.001 ? 'passa a ganhar' : 'continua perdendo') : null);
    opcoes.push(o);
  }
  opcoes.sort((a, b) => (b.m.lucro ?? -1e9) - (a.m.lucro ?? -1e9));
  const melhores = opcoes.filter(o => o.status === 'candidate' && o.rebate > 0 && o.m.lucro != null && atual.lucro != null && o.m.lucro > atual.lucro + 0.05);
  // quando a promoção ativa acabar: volta ao preço cheio (ou a outra promoção ativa que siga valendo)
  let saida = null;
  if (ativa?.finish_date) {
    const fim = Date.parse(ativa.finish_date);
    const seguinte = lista.filter(p => p !== ativa && p.status === 'started' && +p.price > 0 && (!p.finish_date || Date.parse(p.finish_date) > fim)).sort((a, b) => b.price - a.price)[0];
    const precoDepois = seguinte ? +seguinte.price : (+ativa.original_price || it.regular_amount || it.original_price || it.price);
    const rebDepois = seguinte && +seguinte.meli_percentage > 0 ? r2((+seguinte.original_price || 0) * +seguinte.meli_percentage / 100) : 0;
    saida = { fim: ativa.finish_date, precoDepois: r2(precoDepois), depoisCom: seguinte ? (seguinte.name || NOME_TIPO[seguinte.type] || seguinte.type) : null, depois: await cm.margemPreco(F.ml, idx, uid, it, precoDepois, rebDepois, erp) };
  }
  return { precoAtual: r2(precoAtual), atual, ativa: ativa ? { nome: ativa.name || NOME_TIPO[ativa.type] || ativa.type, tipo: ativa.type, rebate: rebAtual, fim: ativa.finish_date || null } : null, saida, opcoes, rebateMelhor: melhores.length };
}

async function carregar(idx) {
  const d = F.dados()[idx];
  if (!d) throw new Error('ML desta conta ainda carregando');
  const E = ST[idx] = { ...(ST[idx] || {}), status: 'carregando', feito: 0, total: 0, inicio: Date.now(), erro: null };
  try {
    const uid = await F.uid(idx), erp = await cm.custosErp(idx).catch(() => ({}));
    const cat = {};
    for (const it of d.perdendo || []) cat[it.id] = { status: 'competing', ptw: it.price_to_win };
    for (const it of d.ganhando || []) cat[it.id] = { status: 'winning', s2price: it.s2price };
    const semPromo = new Set((d.semPromo || []).map(x => x.id));
    const todos = [...(d.semPromo || []), ...(d.comPromo || [])];
    E.total = todos.length;
    const itens = [];
    for (const it of todos) {
      try {
        const r = await opcoesItem(idx, uid, it, cat[it.id], erp);
        if (r.opcoes.length || semPromo.has(it.id)) itens.push({ id: it.id, titulo: it.title, sku: it._sku || '', thumb: it.thumbnail, link: it.permalink || ('https://produto.mercadolivre.com.br/' + it.id.replace(/^MLB/, 'MLB-')),
          semPromo: semPromo.has(it.id), catalogo: cat[it.id] ? { status: cat[it.id].status, ptw: cat[it.id].ptw || null, s2: cat[it.id].s2price || null } : null, ...r });
      } catch (e) {}
      E.feito++;
      await delay(120);
    }
    Object.assign(E, { status: 'pronto', em: new Date().toISOString(), itens });
  } catch (e) { Object.assign(E, { status: 'erro', erro: e.message }); }
}

async function entrar(idx, itemId, i) {
  const E = ST[idx], x = E?.itens?.find(y => y.id === itemId), o = x?.opcoes?.[i];
  if (!o) throw new Error('opção não encontrada — atualize a lista');
  if (!o.podeEntrar) throw new Error('esta promoção não dá para entrar pelo painel (' + o.tipoNome + ')');
  const body = ENTRA[o.tipo](o);
  const r = await F.mlReq(idx, 'post', '/seller-promotions/items/' + itemId + '?app_version=v2', body);
  // recalcula só este item
  const d = F.dados()[idx], it = [...(d?.semPromo || []), ...(d?.comPromo || [])].find(y => y.id === itemId);
  if (it) {
    it.sale_amount = o.preco;
    const novo = await opcoesItem(idx, await F.uid(idx), it, x.catalogo ? { status: x.catalogo.status, ptw: x.catalogo.ptw, s2price: x.catalogo.s2 } : null, await cm.custosErp(idx).catch(() => ({})));
    Object.assign(x, novo, { semPromo: false });
  }
  return { ok: true, resposta: r.data, item: x };
}

function rotas(app, fontes) {
  F = fontes;
  app.get('/ml/promos/:idx', (req, res) => {
    const idx = parseInt(req.params.idx), E = ST[idx];
    if (!E || (!E.itens && E.status !== 'carregando')) carregar(idx).catch(() => {});
    const e = ST[idx] || { status: 'carregando' };
    res.json({ status: e.status, feito: e.feito || 0, total: e.total || 0, em: e.em || null, erro: e.erro || null, itens: e.itens || [] });
  });
  app.post('/ml/promos/:idx/recarregar', (req, res) => {
    const idx = parseInt(req.params.idx);
    if (ST[idx]?.status !== 'carregando') carregar(idx).catch(() => {});
    res.json({ ok: true });
  });
  app.post('/ml/promos/:idx/entrar', require('express').json(), async (req, res) => {
    try { res.json(await entrar(parseInt(req.params.idx), String(req.body?.item || ''), parseInt(req.body?.opcao))); }
    catch (e) { const d = e.response?.data; res.status(400).json({ erro: d?.message || d?.error || e.message, detalhe: d?.cause || null }); }
  });
  // atualiza a cada 6h (quando os dados do ML da conta estiverem prontos)
  setInterval(() => { for (const idx of [0, 1, 2]) if (F.dados()[idx] && ST[idx]?.status !== 'carregando') carregar(idx).catch(() => {}); }, 6 * 3600e3).unref?.();
}
module.exports = { rotas };
