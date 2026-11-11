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
  DEAL: 'Campanha', SELLER_CAMPAIGN: 'Campanha do vendedor', PRICE_DISCOUNT: 'Desconto próprio', LIGHTNING: 'Oferta relâmpago', SMART_LIGHTNING: 'Relâmpago do ML (co-participação)', DOD: 'Oferta do dia', UNHEALTHY_STOCK: 'Estoque parado', PRE_NEGOTIATED: 'Pré-negociada', VOLUME: 'Desconto por quantidade' };
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
  // relâmpago: reserva unidades para a oferta (stock entre o mínimo e o máximo que o ML pede)
  SMART_LIGHTNING: o => ({ promotion_id: o.id, promotion_type: o.tipo, offer_id: o.ref, stock: o.qtd }),
  LIGHTNING: o => ({ promotion_id: o.id, promotion_type: o.tipo, deal_price: o.preco, stock: o.qtd }),
  PRICE_DISCOUNT: o => ({ promotion_type: 'PRICE_DISCOUNT', deal_price: o.preco, start_date: horaBR(), finish_date: horaBR(Date.now() + 30 * 864e5) }),
};
// data no horário de Brasília sem fuso (formato que o ML pede nas promoções): 2026-11-11T09:20:00
const horaBR = (t = Date.now()) => new Date(t - 3 * 3600e3).toISOString().slice(0, 19);
const EDITA = new Set(['DEAL', 'SELLER_CAMPAIGN', 'PRICE_DISCOUNT']);   // promoções com preço escolhido pelo vendedor
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
    // rebate do ML = meli_percentage × preço original (as % ML + seller somam o desconto total sobre o preço cheio)
    const orig = +p.original_price || it.price, pctM = +p.meli_percentage || 0;
    const reb = pctM > 0 ? r2(orig * pctM / 100) : 0;
    const m = await cm.margemPreco(F.ml, idx, uid, it, preco, reb, erp);
    const o = { id: p.id || null, ref: p.ref_id || p.offer_id || null, tipo: p.type, tipoNome: NOME_TIPO[p.type] || p.type, nome: p.name || NOME_TIPO[p.type] || p.type,
      status: p.status, situacao: STATUS[p.status], preco: r2(preco), original: +p.original_price || null, meliPct: +p.meli_percentage || 0, rebate: reb,
      faixa: p.min_discounted_price ? [+p.min_discounted_price, +p.max_discounted_price] : null, inicio: p.start_date || null, fim: p.finish_date || null, m,
      estoque: p.stock?.min != null ? { min: +p.stock.min, max: +p.stock.max || +p.stock.min } : null,
      podeEntrar: p.status === 'candidate' && !!ENTRA[p.type],
      // já ativa/programada com preço do vendedor: dá para mudar o preço (PUT na mesma promoção)
      podeEditar: ['started', 'pending'].includes(p.status) && EDITA.has(p.type) };
    if (o.podeEditar && !o.faixa) o.faixa = [r2(Math.max(1, orig * 0.2)), r2(orig * 0.99)];
    if (cat) o.catalogo = cat.status === 'winning' ? (cat.s2price ? (preco < cat.s2price ? 'continua ganhando' : 'pode perder') : 'continua ganhando') : (cat.ptw ? (preco <= cat.ptw + 0.001 ? 'passa a ganhar' : 'continua perdendo') : null);
    opcoes.push(o);
  }
  // desconto próprio (o vendedor escolhe o %): sempre disponível quando não há promoção ativa
  if (!ativa && !opcoes.some(o => o.tipo === 'PRICE_DISCOUNT')) {
    const cheio = +(it.regular_amount || it.original_price || it.price) || 0;
    if (cheio > 0) {
      const preco = r2(cheio * 0.95);
      opcoes.push({ id: null, ref: null, tipo: 'PRICE_DISCOUNT', tipoNome: NOME_TIPO.PRICE_DISCOUNT, nome: 'Desconto próprio (escolha o %)', status: 'candidate', situacao: 'disponível',
        preco, original: cheio, meliPct: 0, rebate: 0, faixa: [r2(cheio * 0.2), r2(cheio * 0.95)], fim: null, m: await cm.margemPreco(F.ml, idx, uid, it, preco, 0, erp), podeEntrar: true, livre: true });
    }
  }
  for (const o of opcoes) if (o.faixa && o.status === 'candidate' && ENTRA[o.tipo] && 'deal_price' in ENTRA[o.tipo]({ ...o })) o.livre = true;   // preço aberto dentro da faixa
  for (const o of opcoes) if (o.podeEditar) o.livre = true;
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
  // perdendo catálogo: margem no preço que faz ganhar (price_to_win) e qual promoção leva até ele
  let ganhar = null;
  if (cat && cat.status !== 'winning' && cat.ptw > 0) {
    const ptw = r2(cat.ptw);
    const m = await cm.margemPreco(F.ml, idx, uid, it, ptw, 0, erp);
    let via = null;
    for (let i = 0; i < opcoes.length; i++) {
      const o = opcoes[i]; if (!((o.status === 'candidate' && o.podeEntrar) || o.podeEditar)) continue;
      let p = null;
      if (o.livre && o.faixa && ptw >= o.faixa[0] - 0.001) p = Math.min(ptw, o.faixa[1]);
      else if (o.preco <= ptw + 0.001) p = o.preco;
      if (p == null || p > ptw + 0.001) continue;
      const mo = (o.livre && Math.abs(p - o.preco) > 0.004) ? await cm.margemPreco(F.ml, idx, uid, it, p, o.rebate || 0, erp) : o.m;
      if (!via || (mo.lucro ?? -1e9) > (via.m.lucro ?? -1e9)) via = { opcao: i, nome: o.nome, preco: r2(p), livre: !!o.livre, rebate: o.rebate || 0, m: mo, editar: !!o.podeEditar };
    }
    ganhar = { ptw, m, via, s2: cat.s2price || null };
  }
  // em promoção ativa agora (programada não conta; só vira informação no card)
  const emPromo = lista.some(p => p.status === 'started' && !IGNORAR.has(p.type));
  const prog = lista.filter(p => p.status === 'pending' && !IGNORAR.has(p.type)).sort((a, b) => Date.parse(a.start_date || 0) - Date.parse(b.start_date || 0))[0];
  const programada = prog ? { nome: prog.name || NOME_TIPO[prog.type] || prog.type, inicio: prog.start_date || null, preco: +prog.price || null } : null;
  return { emPromo, programada, ganhar, precoAtual: r2(precoAtual), atual, ativa: ativa ? { nome: ativa.name || NOME_TIPO[ativa.type] || ativa.type, tipo: ativa.type, rebate: rebAtual, fim: ativa.finish_date || null } : null, saida, opcoes, rebateMelhor: melhores.length };
}

const fs = require('fs'), path = require('path');
const arq = idx => path.join(require('./dados'), 'apuracao_cache', `promos_ml_${idx}.json`);
const salvar = idx => { try { const E = ST[idx]; fs.mkdirSync(path.dirname(arq(idx)), { recursive: true }); fs.writeFileSync(arq(idx), JSON.stringify({ em: E.em, itens: E.itens })); } catch (e) {} };
async function carregar(idx) {
  const d = F.dados()[idx];
  if (!d) throw new Error('ML desta conta ainda carregando');
  const E = ST[idx] = { ...(ST[idx] || {}), status: 'carregando', feito: 0, total: 0, inicio: Date.now(), erro: null };
  try {
    cm.recarregarErp(idx);   // custo sempre atualizado do Bling/Tiny a cada recálculo (correções no ERP aparecem logo)
    const uid = await F.uid(idx), erp = await cm.custosErp(idx).catch(() => ({}));
    const cat = {};
    for (const it of d.perdendo || []) cat[it.id] = { status: 'competing', ptw: it.preco_nao_resolve ? null : it.price_to_win };   // preço não resolve (inclui abaixo de R$ 19): não sugere
    for (const it of d.ganhando || []) cat[it.id] = { status: 'winning', s2price: it.s2price };
    const semPromo = new Set((d.semPromo || []).map(x => x.id));
    const todos = [...(d.semPromo || []), ...(d.comPromo || [])];   // sem promoção primeiro: são os que aparecem na tela
    E.total = todos.length;
    // o que já estava calculado continua aparecendo; cada anúncio novo substitui o antigo assim que fica pronto
    const mapa = new Map((E.itens || []).map(x => [x.id, x]));
    let i = 0;
    const trabalhador = async () => {
      while (i < todos.length) {
        const it = todos[i++];
        try {
          const r = await opcoesItem(idx, uid, it, cat[it.id], erp);
          const sem = semPromo.has(it.id) && !r.emPromo;   // só promoção ATIVA conta; programada continua "sem promoção"
          if (semPromo.has(it.id) && !sem) moverParaComPromo(d, it.id);
          if (r.opcoes.length || sem) mapa.set(it.id, { id: it.id, titulo: it.title, sku: it._sku || '', thumb: it.thumbnail, link: it.permalink || ('https://produto.mercadolivre.com.br/' + it.id.replace(/^MLB/, 'MLB-')),
            semPromo: sem, catalogo: cat[it.id] ? { status: cat[it.id].status, ptw: cat[it.id].ptw || null, s2: cat[it.id].s2price || null } : null, ...r });
          else mapa.delete(it.id);
        } catch (e) {}
        E.feito++;
        if (E.feito % 25 === 0) E.itens = [...mapa.values()];
        await delay(60);
      }
    };
    await Promise.all([trabalhador(), trabalhador(), trabalhador(), trabalhador()]);   // 4 em paralelo
    const ids = new Set(todos.map(x => x.id));
    Object.assign(E, { status: 'pronto', em: new Date().toISOString(), itens: [...mapa.values()].filter(x => ids.has(x.id)) });
    salvar(idx);
  } catch (e) { Object.assign(E, { status: 'erro', erro: e.message }); }
}

// anúncio que o sale_price mostra sem desconto, mas que tem promoção ativa ou programada no ML
function moverParaComPromo(d, id) {
  const i = (d.semPromo || []).findIndex(x => x.id === id);
  if (i >= 0) d.comPromo.push(...d.semPromo.splice(i, 1));
}
// usado pelo server.js a cada atualização da lista: quem já está em promoção (ativa/programada) não volta para "sem promoção"
function jaEmPromo(idx) { return new Set((ST[idx]?.itens || []).filter(x => x.emPromo).map(x => x.id)); }
const acharItem = (idx, itemId) => { const d = F.dados()[idx]; return [...(d?.semPromo || []), ...(d?.comPromo || [])].find(y => y.id === itemId); };
function precoEscolhido(o, preco) {
  if (preco == null || preco === '' || !o.livre) return o.preco;
  const p = r2(+preco);
  if (!(p > 0)) throw new Error('preço inválido');
  if (o.faixa && (p < o.faixa[0] - 0.001 || p > o.faixa[1] + 0.001)) throw new Error(`preço fora da faixa permitida (R$ ${o.faixa[0].toFixed(2)} a R$ ${o.faixa[1].toFixed(2)})`);
  return p;
}
async function simular(idx, itemId, i, preco) {
  const x = ST[idx]?.itens?.find(y => y.id === itemId), o = x?.opcoes?.[i], it = acharItem(idx, itemId);
  if (!o || !it) throw new Error('opção não encontrada — atualize a lista');
  const p = precoEscolhido(o, preco);
  return { preco: p, m: await cm.margemPreco(F.ml, idx, await F.uid(idx), it, p, o.rebate || 0, await cm.custosErp(idx).catch(() => ({}))) };
}
async function entrar(idx, itemId, i, preco, qtd) {
  const E = ST[idx], x = E?.itens?.find(y => y.id === itemId), o0 = x?.opcoes?.[i];
  if (!o0) throw new Error('opção não encontrada — atualize a lista');
  if (!o0.podeEntrar) throw new Error('esta promoção não dá para entrar pelo painel (' + o0.tipoNome + ')');
  const o = { ...o0, preco: precoEscolhido(o0, preco) };
  if (o0.estoque) {   // relâmpago: unidades reservadas para a oferta
    const it0 = acharItem(idx, itemId), disp = +(it0?.available_quantity ?? 0);
    if (disp < o0.estoque.min) throw new Error(`a relâmpago exige pelo menos ${o0.estoque.min} unidades reservadas e o anúncio tem ${disp} em estoque`);
    o.qtd = Math.max(o0.estoque.min, Math.min(o0.estoque.max, disp, qtd > 0 ? Math.round(qtd) : o0.estoque.min));
  }
  const body = ENTRA[o.tipo](o);
  const r = await F.mlReq(idx, 'post', '/seller-promotions/items/' + itemId + '?app_version=v2', body);
  // recalcula só este item
  const d = F.dados()[idx], it = [...(d?.semPromo || []), ...(d?.comPromo || [])].find(y => y.id === itemId);
  if (it) {
    it.sale_amount = o.preco;
    const novo = await opcoesItem(idx, await F.uid(idx), it, x.catalogo ? { status: x.catalogo.status, ptw: x.catalogo.ptw, s2price: x.catalogo.s2 } : null, await cm.custosErp(idx).catch(() => ({})));
    Object.assign(x, novo, { semPromo: false }); moverParaComPromo(d, itemId);
  }
  return { ok: true, resposta: r.data, item: x, qtd: o.qtd || null };
}

async function editar(idx, itemId, i, preco) {
  const E = ST[idx], x = E?.itens?.find(y => y.id === itemId), o = x?.opcoes?.[i];
  if (!o) throw new Error('opção não encontrada — atualize a lista');
  if (!o.podeEditar) throw new Error('esta promoção não dá para editar pelo painel (' + o.tipoNome + ')');
  const p = precoEscolhido(o, preco);
  const body = o.tipo === 'PRICE_DISCOUNT'
    // o ML exige as duas datas, no horário local (sem fuso); desconto já ativo: começa agora e mantém o fim
    ? { promotion_type: 'PRICE_DISCOUNT', deal_price: p, start_date: o.status === 'pending' && o.inicio ? String(o.inicio).slice(0, 19) : horaBR(), finish_date: o.fim ? String(o.fim).slice(0, 19) : horaBR(Date.now() + 30 * 864e5) }
    : { promotion_id: o.id, promotion_type: o.tipo, deal_price: p };
  let r;
  if (o.tipo === 'PRICE_DISCOUNT') {
    // o ML não aceita PUT no desconto próprio ("Invalid promotion type"): um novo POST substitui o preço
    r = await F.mlReq(idx, 'post', '/seller-promotions/items/' + itemId + '?app_version=v2', body);
  } else r = await F.mlReq(idx, 'put', '/seller-promotions/items/' + itemId + '?app_version=v2', body);
  const d = F.dados()[idx], it = [...(d?.semPromo || []), ...(d?.comPromo || [])].find(y => y.id === itemId);
  if (it) {
    if (o.status === 'started') it.sale_amount = p;
    const novo = await opcoesItem(idx, await F.uid(idx), it, x.catalogo ? { status: x.catalogo.status, ptw: x.catalogo.ptw, s2price: x.catalogo.s2 } : null, await cm.custosErp(idx).catch(() => ({})));
    Object.assign(x, novo);
  }
  return { ok: true, resposta: r.data, item: x };
}

function rotas(app, fontes) {
  F = fontes;
  for (const idx of [0, 1, 2]) try { const j = JSON.parse(fs.readFileSync(arq(idx))); ST[idx] = { status: 'pronto', em: j.em, itens: j.itens || [], feito: 0, total: 0, doDisco: true }; } catch (e) {}
  app.get('/ml/promos/:idx', (req, res) => {
    const idx = parseInt(req.params.idx), E = ST[idx];
    if (!E || (!E.itens && E.status !== 'carregando') || (E.doDisco && E.status === 'pronto' && F.dados()[idx])) { if (E) E.doDisco = false; carregar(idx).catch(() => {}); }
    const e = ST[idx] || { status: 'carregando' };
    res.json({ status: e.status, feito: e.feito || 0, total: e.total || 0, em: e.em || null, erro: e.erro || null, itens: e.itens || [] });
  });
  // inclui anúncios específicos na lista (anúncio recém-criado, ou itens de família que a lista principal ainda não trouxe)
  app.post('/ml/promos/:idx/incluir', require('express').json(), async (req, res) => {
    const idx = parseInt(req.params.idx), ids = (req.body?.ids || []).map(String).filter(x => /^MLB\d+$/.test(x)).slice(0, 50);
    if (!ids.length) return res.status(400).json({ erro: 'ids' });
    const E = ST[idx] = ST[idx] || { status: 'pronto', itens: [] }; E.itens = E.itens || [];
    const uid = await F.uid(idx), erp = await cm.custosErp(idx).catch(() => ({})), out = [];
    for (const id of ids) {
      try {
        const it = await F.ml(idx, '/items/' + id, { include_attributes: 'all' });
        it._sku = (it.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name || it.seller_custom_field || '';
        const r = await opcoesItem(idx, uid, it, null, erp);
        const x = { id, titulo: it.title, sku: it._sku, thumb: it.thumbnail, link: it.permalink, semPromo: !r.emPromo, catalogo: null, ...r };
        E.itens = E.itens.filter(y => y.id !== id); E.itens.unshift(x); out.push(x);
      } catch (e) { out.push({ id, erro: e.message }); }
    }
    salvar(idx); res.json({ ok: true, itens: out });
  });
  app.post('/ml/promos/:idx/recarregar', (req, res) => {
    const idx = parseInt(req.params.idx);
    if (ST[idx]?.status !== 'carregando') carregar(idx).catch(() => {});
    res.json({ ok: true });
  });
  app.post('/ml/promos/:idx/simular', require('express').json(), async (req, res) => {
    try { res.json(await simular(parseInt(req.params.idx), String(req.body?.item || ''), parseInt(req.body?.opcao), req.body?.preco)); }
    catch (e) { res.status(400).json({ erro: e.message }); }
  });
  app.post('/ml/promos/:idx/editar', require('express').json(), async (req, res) => {
    if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
    try { res.json(await editar(parseInt(req.params.idx), String(req.body?.item || ''), parseInt(req.body?.opcao), req.body?.preco)); }
    catch (e) { const d = e.response?.data; res.status(400).json({ erro: d?.message || d?.error || e.message, detalhe: d?.cause || null }); }
  });
  app.post('/ml/promos/:idx/entrar', require('express').json(), async (req, res) => {
    try { res.json(await entrar(parseInt(req.params.idx), String(req.body?.item || ''), parseInt(req.body?.opcao), req.body?.preco, +req.body?.qtd || 0)); }
    catch (e) { const d = e.response?.data; res.status(400).json({ erro: d?.message || d?.error || e.message, detalhe: d?.cause || null }); }
  });
  // admin: entra direto numa promoção (anúncio novo que ainda não está na lista). body: { item, promotion_id?, promotion_type, deal_price? }
  app.post('/ml/promos/:idx/entrar-direto', require('express').json(), async (req, res) => {
    if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
    const b = req.body || {}, item = String(b.item || ''), tipo = String(b.promotion_type || '');
    if (!/^MLB\d+$/.test(item) || !ENTRA[tipo]) return res.status(400).json({ erro: 'informe item (MLB...) e promotion_type válido' });
    const o = { id: b.promotion_id || null, tipo, ref: b.offer_id || null, preco: b.deal_price != null ? r2(+b.deal_price) : null, qtd: +b.stock || 0 };
    if (b.sair) { try { const r = await F.mlReq(parseInt(req.params.idx), 'delete', '/seller-promotions/items/' + item + '?app_version=v2&promotion_type=' + tipo + (o.id ? '&promotion_id=' + o.id : '')); return res.json({ ok: true, resposta: r.data }); } catch (e) { const d = e.response?.data; return res.status(400).json({ erro: d?.message || d?.error || e.message, detalhe: d?.cause || null }); } }
    try { const r = await F.mlReq(parseInt(req.params.idx), b.editar ? 'put' : 'post', '/seller-promotions/items/' + item + '?app_version=v2', b.editar ? { promotion_id: o.id, promotion_type: tipo, deal_price: o.preco } : ENTRA[tipo](o)); res.json({ ok: true, resposta: r.data }); }
    catch (e) { const d = e.response?.data; res.status(400).json({ erro: d?.message || d?.error || e.message, detalhe: d?.cause || null }); }
  });
  // atualiza a cada 6h (quando os dados do ML da conta estiverem prontos)
  setInterval(() => { for (const idx of [0, 1, 2]) if (F.dados()[idx] && ST[idx]?.status !== 'carregando') carregar(idx).catch(() => {}); }, 6 * 3600e3).unref?.();
}
module.exports = { rotas, jaEmPromo };
