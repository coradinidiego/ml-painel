/**
 * Painel de ADS do Mercado Livre (Product Ads) — por conta:
 *   - anúncios com ADS (ativos/pausados) e sem ADS (idle), com métricas do período
 *   - lucro real do ADS: unidades vendidas pelo ADS × lucro por unidade (custo Bling/Tiny, tarifa, frete, imposto) − custo do ADS
 *   - ACOS de equilíbrio = margem % do anúncio: ACOS acima dela = ADS dando prejuízo
 *   - ações: ativar, pausar, mover de campanha, tirar da campanha, colocar na campanha
 *
 *  Leitura:  GET /advertising/advertisers?product_id=PADS (Api-Version 1)
 *            GET /marketplace/advertising/{site}/advertisers/{id}/product_ads/ads  e  .../product_ads/campaigns (api-version 2)
 *  Escrita:  PUT /marketplace/advertising/{site}/product_ads/ads/{item}?channel=marketplace (api-version 2) { status | campaign_id }
 *
 *  GET  /ml/ads/:idx?dias=30     dados
 *  GET  /ml/ads/:idx/raw         diagnóstico (admin): respostas cruas da API
 *  POST /ml/ads/:idx/acao        { item, status?, campaign_id? }
 */
const axios = require('axios');
const cm = require('./custos_ml');
const BASE = 'https://api.mercadolibre.com';
const METRICAS = 'clicks,prints,cost,cpc,acos,ctr,direct_units_quantity,indirect_units_quantity,units_quantity,direct_amount,indirect_amount,total_amount,organic_units_quantity,organic_units_amount';
const r2 = v => Math.round((+v || 0) * 100) / 100;
const delay = ms => new Promise(r => setTimeout(r, ms));
const hojeSP = (d = 0) => new Date(Date.now() - d * 864e5).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

let F;
const ST = {};      // idx|dias -> { status, em, ... }
const _adv = {};    // idx -> { id, site }

async function req(idx, method, path, { params, data, versao = 2 } = {}) {
  for (let t = 0; t < 4; t++) {
    try {
      const r = await axios({ method, url: BASE + path, params, data, timeout: 30000,
        headers: { Authorization: 'Bearer ' + F.token(idx), 'api-version': String(versao), 'Api-Version': String(versao), 'Content-Type': 'application/json' } });
      return r.data;
    } catch (e) {
      if ((e.response?.status === 429 || e.response?.status >= 500) && t < 3) { await delay(1500 * (t + 1)); continue; }
      throw e;
    }
  }
}
async function anunciante(idx) {
  if (_adv[idx]) return _adv[idx];
  const d = await req(idx, 'get', '/advertising/advertisers', { params: { product_id: 'PADS' }, versao: 1 });
  const a = (d.advertisers || [])[0];
  if (!a) throw new Error('esta conta não tem anunciante de Product Ads (ou o app do ML não tem permissão de Publicidade)');
  return (_adv[idx] = { id: a.advertiser_id, site: a.site_id || 'MLB', nome: a.advertiser_name || null });
}
async function todosItens(idx, adv, dias) {
  const out = [], params = { limit: 50, date_from: hojeSP(dias), date_to: hojeSP(0), metrics: METRICAS };
  for (let offset = 0; offset < 5000; offset += 50) {
    const d = await req(idx, 'get', `/marketplace/advertising/${adv.site}/advertisers/${adv.id}/product_ads/ads`, { params: { ...params, offset } });
    const L = d.results || d.items || [];
    out.push(...L);
    if (L.length < 50 || (d.paging?.total != null && offset + 50 >= d.paging.total)) break;
    await delay(250);
  }
  return out;
}
async function campanhas(idx, adv, dias) {
  const d = await req(idx, 'get', `/marketplace/advertising/${adv.site}/advertisers/${adv.id}/product_ads/campaigns`, { params: { limit: 50, offset: 0, date_from: hojeSP(dias), date_to: hojeSP(0), metrics: 'clicks,prints,cost,acos,units_quantity,total_amount,direct_amount' } });
  return (d.results || d.campaigns || []).map(c => ({ id: c.id, nome: c.name, status: c.status, orcamento: c.budget ?? null, acosAlvo: c.acos_target ?? null, estrategia: c.strategy || null,
    custo: r2(c.metrics?.cost), vendas: r2(c.metrics?.total_amount), unidades: c.metrics?.units_quantity || 0, acos: c.metrics?.acos ?? null, cliques: c.metrics?.clicks || 0 }));
}

async function carregar(idx, dias) {
  const k = idx + '|' + dias, E = ST[k] = { ...(ST[k] || {}), status: 'carregando', erro: null, inicio: Date.now() };
  try {
    const adv = await anunciante(idx);
    const [itens, camps] = [await todosItens(idx, adv, dias), await campanhas(idx, adv, dias).catch(() => [])];
    const nomeCamp = Object.fromEntries(camps.map(c => [String(c.id), c.nome]));
    // dados do anúncio (SKU, categoria, tipo, preço atual) que o painel já tem
    const d = F.dados()[idx] || {};
    const porId = Object.fromEntries([...(d.semPromo || []), ...(d.comPromo || []), ...(d.semPromo?.ignorados || [])].map(x => [x.id, x]));
    const cat = {};
    for (const x of d.perdendo || []) cat[x.id] = 'perdendo';
    for (const x of d.ganhando || []) cat[x.id] = 'ganhando';
    const uid = await F.uid(idx), erp = await cm.custosErp(idx).catch(() => ({}));
    const out = [];
    for (const a of itens) {
      const it = porId[a.item_id];
      const m = a.metrics || {};
      const preco = it ? (it.sale_amount && it.sale_amount < (it.regular_amount || it.original_price || it.price) ? it.sale_amount : it.price) : (+a.price || 0);
      const mg = it ? await cm.margemPreco(F.ml, idx, uid, it, preco, 0, erp) : { erro: 'anúncio fora da lista do painel' };
      const un = (+m.units_quantity || ((+m.direct_units_quantity || 0) + (+m.indirect_units_quantity || 0)));
      const custo = r2(m.cost);
      const lucroAntes = mg.lucro != null ? r2(un * mg.lucro) : null;
      out.push({ id: a.item_id, titulo: a.title || it?.title, thumb: a.thumbnail || it?.thumbnail, link: a.permalink || it?.permalink, sku: it?._sku || '',
        status: a.status, campanha: a.campaign_id ? { id: a.campaign_id, nome: nomeCamp[String(a.campaign_id)] || ('#' + a.campaign_id) } : null,
        recomendado: !!a.recommended, catalogo: cat[a.item_id] || null, preco: r2(preco), estoque: it?.available_quantity ?? null,
        margem: mg, acosEquilibrio: mg.pct ?? null,
        cliques: +m.clicks || 0, impressoes: +m.prints || 0, custo, cpc: r2(m.cpc), acos: m.acos != null ? r2(m.acos) : null,
        unidadesAds: un, vendasAds: r2(m.total_amount || ((+m.direct_amount || 0) + (+m.indirect_amount || 0))),
        organicas: +m.organic_units_quantity || 0,
        lucroAds: lucroAntes != null ? r2(lucroAntes - custo) : null });
    }
    Object.assign(E, { status: 'pronto', em: new Date().toISOString(), dias, anunciante: adv, campanhas: camps, itens: out });
  } catch (e) {
    const d = e.response?.data;
    Object.assign(E, { status: 'erro', erro: (e.response?.status ? e.response.status + ' ' : '') + (d?.message || d?.error || e.message) });
  }
  return E;
}

function rotas(app, fontes) {
  F = fontes;
  const admin = req => req.usuario?.admin || !require('./auth').ativo();
  app.get('/ml/ads/:idx', (req, res) => {
    const idx = parseInt(req.params.idx), dias = [7, 15, 30, 60].includes(+req.query.dias) ? +req.query.dias : 30, k = idx + '|' + dias, E = ST[k];
    if (req.query.recarregar || !E || (E.status !== 'carregando' && Date.now() - Date.parse(E.em || 0) > 3 * 3600e3) || E.status === 'erro' && req.query.recarregar) carregar(idx, dias).catch(() => {});
    const e = ST[k] || { status: 'carregando' };
    res.json({ status: e.status, erro: e.erro || null, em: e.em || null, dias, anunciante: e.anunciante || null, campanhas: e.campanhas || [], itens: e.itens || [] });
  });
  app.get('/ml/ads/:idx/raw', async (req, res) => {
    if (!admin(req)) return res.status(403).json({ erro: 'só admin' });
    const idx = parseInt(req.params.idx), out = {};
    try { out.advertisers = await req_(idx, 'get', '/advertising/advertisers', { params: { product_id: 'PADS' }, versao: 1 }); } catch (e) { out.erroAdvertisers = e.response?.status + ' ' + JSON.stringify(e.response?.data || e.message).slice(0, 400); }
    try { const a = await anunciante(idx); out.items = await req_(idx, 'get', `/marketplace/advertising/${a.site}/advertisers/${a.id}/product_ads/ads`, { params: { limit: 2, offset: 0, date_from: hojeSP(7), date_to: hojeSP(0), metrics: METRICAS } }); } catch (e) { out.erroItems = e.response?.status + ' ' + JSON.stringify(e.response?.data || e.message).slice(0, 400); }
    try { const a = await anunciante(idx); out.campaigns = await req_(idx, 'get', `/marketplace/advertising/${a.site}/advertisers/${a.id}/product_ads/campaigns`, { params: { limit: 5, offset: 0, date_from: hojeSP(7), date_to: hojeSP(0), metrics: 'clicks,cost,acos' } }); } catch (e) { out.erroCampaigns = e.response?.status + ' ' + JSON.stringify(e.response?.data || e.message).slice(0, 400); }
    res.json(out);
  });
  const req_ = req;
  app.post('/ml/ads/:idx/acao', require('express').json(), async (rq, res) => {
    const idx = parseInt(rq.params.idx), item = String(rq.body?.item || '');
    const body = {};
    if (rq.body?.campaign_id != null) body.campaign_id = Number(rq.body.campaign_id);
    if (rq.body?.status && body.campaign_id !== 0) body.status = rq.body.status === 'paused' ? 'paused' : 'active';
    if (!/^MLB\d+$/.test(item) || !Object.keys(body).length) return res.status(400).json({ erro: 'parâmetros inválidos' });
    try {
      const adv = await anunciante(idx);
      const r = await req(idx, 'put', `/marketplace/advertising/${adv.site}/product_ads/ads/${item}`, { params: { channel: 'marketplace' }, data: body });
      // atualiza o item nos dados em memória
      for (const [k, E] of Object.entries(ST)) if (k.startsWith(idx + '|')) for (const x of E.itens || []) if (x.id === item) {
        x.status = r.status || body.status || x.status;
        if (body.campaign_id != null) x.campanha = body.campaign_id ? { id: body.campaign_id, nome: (E.campanhas || []).find(c => String(c.id) === String(body.campaign_id))?.nome || ('#' + body.campaign_id) } : null;
      }
      res.json({ ok: true, resposta: r });
    } catch (e) { const d = e.response?.data; res.status(400).json({ erro: d?.message || d?.error || e.message, detalhe: d?.cause || null }); }
  });
}
module.exports = { rotas };
