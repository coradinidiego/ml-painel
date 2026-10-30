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
const MARGEM_INDIRETA = 0.12;   // margem usada nas vendas indiretas do ADS (outros produtos), conservadora
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
const CAND = {
  ads: a => [`/advertising/${a.site}/advertisers/${a.id}/product_ads/ads/search`, `/marketplace/advertising/${a.site}/advertisers/${a.id}/product_ads/ads/search`, `/marketplace/advertising/${a.site}/advertisers/${a.id}/product_ads/ads`, `/advertising/advertisers/${a.id}/product_ads/items`],
  camps: a => [`/advertising/${a.site}/advertisers/${a.id}/product_ads/campaigns/search`, `/marketplace/advertising/${a.site}/advertisers/${a.id}/product_ads/campaigns/search`, `/marketplace/advertising/${a.site}/advertisers/${a.id}/product_ads/campaigns`, `/advertising/advertisers/${a.id}/product_ads/campaigns`],
};
const _caminho = {};   // tipo -> caminho que funcionou
async function getCand(idx, adv, tipo, params) {
  let ult;
  for (const p of _caminho[idx + tipo] ? [_caminho[idx + tipo]] : CAND[tipo](adv)) {
    try { const d = await req(idx, 'get', p, { params }); _caminho[idx + tipo] = p; return d; }
    catch (e) { ult = e; if (![400, 404].includes(e.response?.status)) throw e; }
  }
  throw ult;
}
async function todosItens(idx, adv, dias) {
  const out = [], params = { limit: 50, date_from: hojeSP(dias), date_to: hojeSP(0), metrics: METRICAS };
  for (let offset = 0; offset < 5000; offset += 50) {
    const d = await getCand(idx, adv, 'ads', { ...params, offset });
    const L = d.results || d.items || [];
    out.push(...L);
    if (L.length < 50 || (d.paging?.total != null && offset + 50 >= d.paging.total)) break;
    await delay(250);
  }
  return out;
}
async function campanhas(idx, adv, dias) {
  const R = [];
  for (let offset = 0; offset < 2000; offset += 50) {
    const d = await getCand(idx, adv, 'camps', { limit: 50, offset, date_from: hojeSP(dias), date_to: hojeSP(0), metrics: 'clicks,prints,cost,acos,units_quantity,total_amount,direct_amount' });
    const L = d.results || d.campaigns || []; R.push(...L);
    if (L.length < 50 || (d.paging?.total != null && offset + 50 >= d.paging.total)) break;
    await delay(250);
  }
  return R.map(c => ({ id: c.id, nome: c.name, status: c.status, orcamento: c.budget ?? null, acosAlvo: c.acos_target ?? (c.roas_target ? Math.round(10000 / c.roas_target) / 100 : null), roasAlvo: c.roas_target ?? (c.acos_target ? Math.round(1000 / c.acos_target) / 10 : null), estrategia: c.strategy || null,
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
    // anúncios que a lista do painel ainda não tem (ex.: logo depois de reiniciar): busca no ML
    const faltam = itens.map(a => a.item_id).filter(id => id && !porId[id]);
    for (let i = 0; i < faltam.length; i += 20) {
      try {
        const R = await F.ml(idx, '/items', { ids: faltam.slice(i, i + 20).join(','), attributes: 'id,title,price,original_price,thumbnail,permalink,seller_custom_field,attributes,variations,listing_type_id,category_id,available_quantity' });
        for (const w of Array.isArray(R) ? R : [R]) {
          const it = w.body || w; if (!it?.id) continue;
          const skuAttr = o => o?.seller_custom_field || (o?.attributes || []).find(x => x.id === 'SELLER_SKU')?.value_name;
          it._sku = skuAttr(it) || (it.variations || []).map(skuAttr).find(Boolean) || '';
          porId[it.id] = it;
        }
      } catch (e) {}
      await delay(150);
    }
    const uid = await F.uid(idx), erp = await cm.custosErp(idx).catch(() => ({}));
    const out = [];
    for (const a of itens) {
      const it = porId[a.item_id];
      const m = a.metrics || {};
      const preco = it ? (it.sale_amount && it.sale_amount < (it.regular_amount || it.original_price || it.price) ? it.sale_amount : it.price) : (+a.price || 0);
      const mg = it ? await cm.margemPreco(F.ml, idx, uid, it, preco, 0, erp) : { erro: 'anúncio fora da lista do painel' };
      const un = (+m.units_quantity || ((+m.direct_units_quantity || 0) + (+m.indirect_units_quantity || 0)));
      const custo = r2(m.cost);
      // lucro das vendas do ADS:
      //  diretas (o próprio anúncio): pelo preço que realmente saiu → receita − tarifa% − imposto% − unidades × (custo + frete + embalagem)
      //  indiretas (o comprador clicou no ADS e levou OUTRO produto seu): receita × margem média conservadora (MARGEM_INDIRETA)
      const dU = +m.direct_units_quantity || 0, dV = +m.direct_amount || 0, iV = +m.indirect_amount || 0;
      const lucroDireto = mg.lucro == null ? null : !dU ? 0 : dV > 0 && mg.preco > 0
        ? dV * (1 - (mg.tarifa + mg.imposto) / mg.preco) - dU * (mg.custo + mg.frete + mg.embalagem) : dU * mg.lucro;
      const lucroAntes = lucroDireto == null ? null : r2(lucroDireto + iV * MARGEM_INDIRETA);
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

// ── Custo do ADS por anúncio num período (para a apuração) ──
// { em, itens: [{ id, custo, vendas }], skus: { MLB: [SKUs do anúncio e das variações] } }  — cache em disco
const fs = require('fs'), path = require('path');
async function custoPeriodo(idx, ini, fim) {
  if (!F) throw new Error('ADS: painel ainda iniciando');
  const DATA = require('./dados'), arq = path.join(DATA, 'apuracao_cache', `ads_${idx}_${ini}_${fim}.json`);
  let C = null; try { C = JSON.parse(fs.readFileSync(arq)); } catch (e) {}
  const recente = Date.parse(fim + 'T23:59:59-03:00') > Date.now() - 3 * 864e5;
  const ehHoje = fim >= hojeSP(0);   // dia corrente: renova a cada 30 min (números do dia)
  if (C && (!recente || Date.now() - Date.parse(C.em) < (ehHoje ? 30 * 60e3 : 6 * 3600e3))) return C;
  const adv = await anunciante(idx);
  const L = [], params = { limit: 50, date_from: ini, date_to: fim, metrics: 'cost,total_amount,units_quantity' };
  for (let offset = 0; offset < 10000; offset += 50) {
    const d = await getCand(idx, adv, 'ads', { ...params, offset });
    const R = d.results || d.items || [];
    for (const a of R) { const c = +a.metrics?.cost || 0; if (c > 0) L.push({ id: a.item_id, custo: r2(c), vendas: r2(a.metrics?.total_amount) }); }
    if (R.length < 50 || (d.paging?.total != null && offset + 50 >= d.paging.total)) break;
    await delay(250);
  }
  const skus = { ...(C?.skus || {}) }, faltam = L.map(x => x.id).filter(id => !skus[id]);
  for (let i = 0; i < faltam.length; i += 20) {
    try {
      const R = await F.ml(idx, '/items', { ids: faltam.slice(i, i + 20).join(','), attributes: 'id,seller_custom_field,attributes,variations' });
      for (const w of Array.isArray(R) ? R : [R]) {
        const it = w.body || w; if (!it?.id) continue;
        const set = new Set([it.seller_custom_field, (it.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name]);
        for (const v of it.variations || []) { set.add(v.seller_custom_field); set.add((v.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name); }
        skus[it.id] = [...set].filter(Boolean).map(x => String(x).trim());
      }
    } catch (e) {}
  }
  C = { em: new Date().toISOString(), ini, fim, itens: L, skus };
  try { fs.mkdirSync(path.dirname(arq), { recursive: true }); fs.writeFileSync(arq, JSON.stringify(C)); } catch (e) {}
  return C;
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
    try {
      const a = await anunciante(idx), p = { limit: 2, offset: 0, date_from: hojeSP(7), date_to: hojeSP(0), metrics: 'clicks,cost,acos' };
      out.testes = {};
      for (const t of ['ads', 'camps']) for (const c of CAND[t](a)) {
        try { const d = await req_(idx, 'get', c, { params: p }); out.testes[c] = 'OK ' + JSON.stringify(d).slice(0, 600); }
        catch (e) { out.testes[c] = (e.response?.status || '') + ' ' + JSON.stringify(e.response?.data || e.message).slice(0, 150); }
      }
    } catch (e) { out.erro = e.message; }
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
// ── campanhas: alterar orçamento / ACOS alvo, criar campanha individual para um anúncio ──
async function alterarCampanha(idx, id, { budget, acos_target, status }) {
  const adv = await anunciante(idx), body = {};
  if (budget != null) body.budget = Number(budget);
  if (status) body.status = status === 'paused' ? 'paused' : 'active';
  const url = `/marketplace/advertising/${adv.site}/product_ads/campaigns/${id}`;
  if (acos_target == null) return req(idx, 'put', url, { data: body });
  // o ML trocou o ACOS objetivo pelo ROAS objetivo: manda roas_target (= 100 ÷ ACOS); se a conta ainda usar ACOS, cai para acos_target
  try { return await req(idx, 'put', url, { data: { ...body, roas_target: Math.min(35, Math.round(1000 / Number(acos_target)) / 10) } }); }
  catch (e) { if (e.response?.status >= 500) throw e; return req(idx, 'put', url, { data: { ...body, acos_target: Number(acos_target) } }); }
}
async function criarCampanha(idx, item, { nome, budget, acos_target }) {
  const adv = await anunciante(idx);
  const url = `/marketplace/advertising/${adv.site}/advertisers/${adv.id}/product_ads/campaigns`;
  const base = { name: String(nome || item).slice(0, 60), status: 'active', budget: Number(budget), strategy: 'PROFITABILITY', channel: 'marketplace' };
  let c;
  try { c = await req(idx, 'post', url, { data: { ...base, roas_target: Math.min(35, Math.round(1000 / Number(acos_target)) / 10) } }); }
  catch (e) { if (e.response?.status >= 500) throw e; c = await req(idx, 'post', url, { data: { ...base, acos_target: Number(acos_target) } }); }
  const cid = c?.id || c?.campaign_id; if (!cid) throw new Error('o ML não devolveu o id da campanha: ' + JSON.stringify(c).slice(0, 200));
  const a = await req(idx, 'put', `/marketplace/advertising/${adv.site}/product_ads/ads/${item}`, { params: { channel: 'marketplace' }, data: { campaign_id: Number(cid), status: 'active' } });
  return { campanha: c, anuncio: a, id: cid };
}
const estado = (idx, dias) => ST[idx + '|' + dias];
module.exports = { rotas, custoPeriodo, carregar, estado, alterarCampanha, criarCampanha, moverAnuncio: async (idx, item, body) => { const adv = await anunciante(idx); return req(idx, 'put', `/marketplace/advertising/${adv.site}/product_ads/ads/${item}`, { params: { channel: 'marketplace' }, data: body }); } };
