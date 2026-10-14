/**
 * Página Início (todas as empresas): perguntas/mensagens pendentes e divergência de estoque
 * entre os marketplaces e o ERP (Bling para Zagodini e Com Amor de Mãe, Tiny para a Lufe).
 *
 * Montado em server.js:  require('./inicio')(app, { ml, dadosCache, SHP, AZ_ANUNCIOS, extrairSKU, estoqueShp })
 *   GET  /inicio                     -> resumo por empresa (sem promoção, pendências, estoque)
 *   GET  /inicio/estoque             -> lista de divergências (todas as empresas)
 *   POST /inicio/estoque/atualizar   -> refaz a comparação agora (?emp=lufe|zagodini|mae)
 *   GET  /debug/inicio               -> estado interno (erros por etapa)
 *
 * Regras de estoque:
 *  - Compara cada anúncio com o saldo do ERP pelo SKU (no Tiny também pelo GTIN/EAN, que a Lufe usa como SKU no ML).
 *  - É divergência quando o estoque do anúncio não bate nem com o saldo físico nem com o disponível
 *    (físico − reservado) do ERP — assim pedidos em aberto não geram alarme falso.
 *  - Ficam de fora: Mercado Livre Full e Amazon FBA (o estoque é do marketplace), anúncios sem SKU
 *    e SKUs que não existem no ERP (esses dois aparecem só como contagem).
 *  - Antes de mostrar, os anúncios divergentes são conferidos de novo direto no marketplace,
 *    para não acusar diferença por causa de cache antigo.
 */
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');

const EMP = [
  { id: 'zagodini', nome: 'Comercial Zagodini',   idx: 0, erp: 'Bling' },
  { id: 'mae',      nome: 'Com Amor de Mãe',      idx: 1, erp: 'Bling' },
  { id: 'lufe',     nome: 'Lufe Casa & Decoração', idx: 2, erp: 'Tiny' },
];
const ARQ = path.join(DATA, 'apuracao_cache', 'inicio_estoque.json');
const ARQ_TINY = path.join(DATA, 'apuracao_cache', 'inicio_tiny_estoque.json');
const delay = ms => new Promise(r => setTimeout(r, ms));
const K = v => (v === null || v === undefined || v === '') ? null : String(v).trim().toUpperCase();
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? 0 : n; };
const lerJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const gravar = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch (e) {} };

module.exports = function montar(app, ctx) {
  const { ml, dadosCache, SHP, AZ_ANUNCIOS, extrairSKU, estoqueShp } = ctx;
  const shopee = require('./shopee');
  const amazon = require('./amazon');

  // ─── Pendências (perguntas/mensagens) — a cada 5 min ─────────────────────
  const PEND = {};   // emp -> { ml: {perguntas, mensagens, erro}, shopee: {chat, erro}, em }
  async function atualizarPendencias() {
    for (const e of EMP) {
      const P = PEND[e.id] ||= { ml: {}, shopee: {} };
      const uid = dadosCache[e.idx]?.uid;
      if (uid) {
        const m = {};
        try { const q = await ml(e.idx, '/questions/search', { seller_id: uid, status: 'UNANSWERED', limit: 1 }); m.perguntas = q.total ?? q.paging?.total ?? (q.questions || []).length; }
        catch (er) { m.erroPerguntas = er.response?.status === 401 ? 'token ML expirado' : er.message; }
        try {
          const u = await ml(e.idx, '/messages/unread', { role: 'seller', tag: 'post_sale' });
          const L = u.results || [];
          m.mensagens = L.length;                                   // conversas (pedidos) com mensagem não lida
          m.mensagensQtd = L.reduce((s, x) => s + (x.count || 0), 0);
        } catch (er) { m.erroMensagens = er.response?.status === 401 ? 'token ML expirado' : (er.response?.data?.message || er.message); }
        P.ml = m;
      }
      const sp = shopee.loja(e.id);
      if (sp.getTokens().access_token) {
        try { const C = await sp.listarConversas(15, 180); P.shopee = { chat: C.filter(c => c.pendente).length }; }
        catch (er) {
          // erro (ex.: token renovando): usa o que o carregamento da Shopee já tem
          const C = SHP[e.id]?.cache?.conversas;
          P.shopee = C ? { chat: C.filter(c => c.pendente).length, erro: er.message } : { erro: er.message };
        }
      } else P.shopee = { semAuth: true };
      P.em = new Date().toISOString();
    }
  }
  setTimeout(() => atualizarPendencias().catch(e => console.warn('[inicio] pendências', e.message)), 90e3);
  setInterval(() => atualizarPendencias().catch(e => console.warn('[inicio] pendências', e.message)), 5 * 60e3);

  // ─── Estoque do ERP ──────────────────────────────────────────────────────
  // Bling: lista de produtos + saldos por depósito (ignora depósitos Full e os que o Bling desconsidera)
  async function erpBling(idx) {
    const bling = require('./bling'), c = bling.client(idx);
    const deps = await bling.getDepositos(idx);
    const ignorar = new Set(deps.filter(d => /full/i.test(d.descricao || '') || d.desconsiderarSaldo === true).map(d => String(d.id)));
    const prods = [];
    for (let pagina = 1; pagina <= 200; pagina++) {
      const r = await c.get('/produtos', { params: { limite: 100, pagina } });
      const L = r.data?.data || [];
      prods.push(...L);
      if (L.length < 100) break;
      await delay(350);
    }
    const mapa = {};
    for (const p of prods) if (p.codigo) mapa[K(p.codigo)] = { id: p.id, nome: p.nome, fis: num(p.estoque?.saldoVirtualTotal), disp: num(p.estoque?.saldoVirtualTotal), kit: p.formato === 'E', fonteSaldo: 'total' };
    // saldos por depósito, 50 produtos por consulta
    const porId = Object.fromEntries(Object.values(mapa).map(x => [String(x.id), x]));
    const ids = Object.keys(porId);
    let falhou = 0;
    for (let i = 0; i < ids.length; i += 50) {
      try {
        const r = await c.get('/estoques/saldos', { params: { idsProdutos: ids.slice(i, i + 50) } });
        for (const s of r.data?.data || []) {
          const x = porId[String(s.produto?.id)]; if (!x) continue;
          const D = (s.depositos || []).filter(d => !ignorar.has(String(d.id)));
          if (D.length) { x.fis = D.reduce((a, d) => a + num(d.saldoFisico), 0); x.disp = D.reduce((a, d) => a + num(d.saldoVirtual), 0); }
          else { x.fis = num(s.saldoFisicoTotal); x.disp = num(s.saldoVirtualTotal); }
          x.fonteSaldo = 'depositos';
        }
      } catch (e) { falhou++; if (falhou === 1) console.warn('[inicio] Bling saldos', idx, e.response?.status, e.message); }
      await delay(350);
    }
    return mapa;
  }

  // Tiny: códigos/GTIN da lista de produtos (1x por dia) + saldo por produto, só dos SKUs anunciados.
  // Depois só busca o que mudou (lista.atualizacoes.estoque). Tudo guardado em disco.
  const TINY = lerJson(ARQ_TINY, { codigos: {}, codTs: 0, saldos: {}, ultimaAtualizacao: null, cheio: 0 });
  const brDataHora = d => { const p = n => String(n).padStart(2, '0'); return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  async function erpTiny(skusAnunciados) {
    const tiny = require('./tiny');
    if (!Object.keys(TINY.codigos).length || Date.now() - TINY.codTs > 24 * 3600e3) {
      const cod = {};
      for (let pagina = 1, total = 1; pagina <= total && pagina <= 80; pagina++) {
        const ret = await tiny.chamar('produtos.pesquisa.php', { pesquisa: '', pagina });
        if (ret.vazio) break;
        total = parseInt(ret.numero_paginas || 1);
        for (const x of ret.produtos || []) {
          const p = x.produto || {};
          if (!p.id) continue;
          const info = { id: String(p.id), nome: p.nome, kit: p.classe_produto === 'K' };
          if (p.codigo) cod[K(p.codigo)] = info;
          if (p.gtin) cod[K(p.gtin)] ||= info;
        }
        await delay(1100);
      }
      TINY.codigos = cod; TINY.codTs = Date.now(); gravar(ARQ_TINY, TINY);
    }
    const inicio = new Date();
    // 1) o que mudou desde a última vez
    if (TINY.ultimaAtualizacao) {
      try {
        for (let pagina = 1, total = 1; pagina <= total && pagina <= 50; pagina++) {
          const ret = await tiny.chamar('lista.atualizacoes.estoque.php', { dataAlteracao: TINY.ultimaAtualizacao, pagina });
          if (ret.vazio) break;
          total = parseInt(ret.numero_paginas || 1);
          for (const x of ret.produtos || []) { const p = x.produto || {}; if (p.id) TINY.saldos[String(p.id)] = { fis: num(p.saldo), disp: num(p.saldo) - num(p.saldoReservado), ts: Date.now() }; }
          await delay(1100);
        }
      } catch (e) { console.warn('[inicio] Tiny atualizações de estoque:', e.message); TINY.cheio = 0; }
    }
    // 2) saldo completo dos SKUs anunciados que ainda não temos (ou tudo de novo a cada 12h)
    const refazer = Date.now() - (TINY.cheio || 0) > 12 * 3600e3;
    const ids = [...new Set(skusAnunciados.map(s => achar(TINY.codigos, s)?.id).filter(Boolean))];
    const faltam = ids.filter(id => refazer || !TINY.saldos[id]);
    for (let i = 0; i < faltam.length; i++) {
      try {
        const ret = await tiny.chamar('produto.obter.estoque.php', { id: faltam[i] });
        const p = ret.produto || {};
        TINY.saldos[faltam[i]] = { fis: num(p.saldo), disp: num(p.saldo) - num(p.saldoReservado), ts: Date.now() };
      } catch (e) { if (!/erro 20/.test(e.message)) console.warn('[inicio] Tiny estoque', faltam[i], e.message); }
      if (i % 50 === 49) gravar(ARQ_TINY, TINY);
      await delay(1100);
    }
    if (refazer) TINY.cheio = Date.now();
    TINY.ultimaAtualizacao = brDataHora(new Date(inicio.getTime() - 5 * 60e3));   // 5 min de folga
    gravar(ARQ_TINY, TINY);
    const mapa = {};
    for (const [k, info] of Object.entries(TINY.codigos)) { const s = TINY.saldos[info.id]; if (s) mapa[k] = { ...info, fis: s.fis, disp: s.disp }; else mapa[k] = { ...info, semSaldo: true }; }
    return mapa;
  }

  // procura o SKU no ERP: exato, sem zeros à esquerda, ou kit "SKU-3" = saldo ÷ 3
  function achar(mapa, sku) {
    const s = K(sku); if (!s) return null;
    if (mapa[s]) return mapa[s];
    const z = s.replace(/^0+/, ''); if (z !== s && mapa[z]) return mapa[z];
    const m = s.match(/^(.*)-(\d+)$/);
    if (m && mapa[m[1]] && parseInt(m[2]) > 1) { const b = mapa[m[1]], n = parseInt(m[2]); return { ...b, fis: Math.floor(b.fis / n), disp: Math.floor(b.disp / n), kitDe: n }; }
    return null;
  }

  // ─── Anúncios de cada marketplace (estoque por SKU) ──────────────────────
  const skuVarML = v => v.seller_custom_field || (v.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name || null;
  async function itensML(idx) {
    const d = dadosCache[idx]; if (!d?.uid) throw new Error('Mercado Livre ainda carregando');
    const ids = [...new Set([...(d.semPromo || []), ...(d.comPromo || []), ...(d.semPromoIgnorados || [])].map(x => x.id))];
    // pausados por falta de estoque também contam (ERP com saldo e anúncio parado = divergência)
    for (let off = 0; off < 2000; off += 50) {
      const r = await ml(idx, '/users/' + d.uid + '/items/search', { status: 'paused', limit: 50, offset: off });
      ids.push(...(r.results || []));
      if ((r.results || []).length < 50) break;
    }
    const out = [];
    for (let i = 0; i < ids.length; i += 20) {
      const det = await ml(idx, '/items', { ids: ids.slice(i, i + 20).join(','), include_attributes: 'all' });
      for (const w of (Array.isArray(det) ? det : [det])) {
        const it = w.body || w; if (!it?.id) continue;
        if (it.status === 'paused' && !(it.sub_status || []).includes('out_of_stock')) continue;
        if (it.status !== 'active' && it.status !== 'paused') continue;
        const full = it.shipping?.logistic_type === 'fulfillment';
        const base = { canal: 'ml', anuncio: it.id, nome: it.title, link: 'https://www.mercadolivre.com.br/anuncios/' + it.id + '/modificar', full, pausado: it.status === 'paused' };
        if (it.variations?.length) for (const v of it.variations) out.push({ ...base, variacao: v.id, nomeVar: (v.attribute_combinations || []).map(a => a.value_name).filter(Boolean).join(' / '), sku: skuVarML(v) || null, qtd: v.available_quantity ?? 0 });
        else out.push({ ...base, sku: extrairSKU(it), qtd: it.available_quantity ?? 0 });
      }
    }
    return out;
  }
  function itensShopee(k) {
    const C = SHP[k]?.cache; if (!C?.produtos) return null;
    const out = [];
    for (const p of C.produtos) {
      const base = { canal: 'shopee', anuncio: String(p.item_id), nome: p.item_name, link: 'https://seller.shopee.com.br/portal/product/' + p.item_id };
      if (p.has_model) { if (!p._variacoes) continue; for (const v of p._variacoes) out.push({ ...base, variacao: String(v.model_id), nomeVar: v.nome, sku: v.sku || null, qtd: v.estoque ?? 0 }); }
      else out.push({ ...base, sku: p.item_sku || null, qtd: estoqueShp(p) });
    }
    return out;
  }
  function itensAmazon(k) {
    const A = AZ_ANUNCIOS[k]; if (!A?.anuncios) return null;
    return A.anuncios.filter(a => a.status !== 'Incomplete').map(a => ({ canal: 'amazon', anuncio: a.asin || a.sku, nome: a.nome, sku: a.sku, qtd: a.qtd || 0, full: a.fba,
      link: 'https://sellercentral.amazon.com.br/myinventory/inventory?fulfilledBy=all&page=1&pageSize=25&searchField=all&searchTerm=' + encodeURIComponent(a.sku || '') }));
  }

  // confere de novo, direto no marketplace, os anúncios que deram diferença
  async function reconferir(e, divs) {
    const P = divs.filter(x => x.canal === 'ml'), S = divs.filter(x => x.canal === 'shopee'), Z = divs.filter(x => x.canal === 'amazon');
    for (let i = 0; i < P.length; i += 20) {
      try {
        const ids = [...new Set(P.slice(i, i + 20).map(x => x.anuncio))];
        const det = await ml(e.idx, '/items', { ids: ids.join(','), attributes: 'id,available_quantity,variations' });
        const m = Object.fromEntries((Array.isArray(det) ? det : [det]).map(w => w.body || w).filter(x => x?.id).map(x => [x.id, x]));
        for (const x of P.slice(i, i + 20)) { const it = m[x.anuncio]; if (!it) continue; x.qtd = x.variacao ? (it.variations || []).find(v => v.id === x.variacao)?.available_quantity ?? x.qtd : it.available_quantity ?? x.qtd; }
      } catch (er) {}
    }
    if (S.length) {
      const sp = shopee.loja(e.id);
      const itens = [...new Set(S.map(x => x.anuncio))];
      for (let i = 0; i < itens.length; i += 50) {
        try {
          const d = await sp.shopeeGet('/api/v2/product/get_item_base_info', { item_id_list: itens.slice(i, i + 50).join(',') });
          const m = Object.fromEntries((d.response?.item_list || []).map(p => [String(p.item_id), p]));
          for (const x of S) if (!x.variacao && m[x.anuncio]) x.qtd = m[x.anuncio].stock_info_v2?.summary_info?.total_available_stock ?? x.qtd;
        } catch (er) {}
      }
      for (const id of [...new Set(S.filter(x => x.variacao).map(x => x.anuncio))].slice(0, 60)) {
        try { const V = await sp.variacoes(id); for (const x of S) if (x.anuncio === id && x.variacao) { const v = V.find(v => String(v.model_id) === x.variacao); if (v) x.qtd = v.estoque ?? x.qtd; } } catch (er) {}
      }
    }
    const eu = AZ_ANUNCIOS[e.id]?.eu;
    if (Z.length && eu) {
      const az = amazon.loja(e.id);
      for (const x of Z.slice(0, 80)) {
        try {
          const r = await az.get('/listings/2021-08-01/items/' + eu + '/' + encodeURIComponent(x.sku), { marketplaceIds: amazon.MARKETPLACE_BR, includedData: 'fulfillmentAvailability' }, 2);
          const f = (r.fulfillmentAvailability || []).find(f => f.fulfillmentChannelCode === 'DEFAULT');
          if (f && f.quantity != null) x.qtd = f.quantity;
        } catch (er) {}
        await delay(250);
      }
    }
  }

  // ─── Comparação ──────────────────────────────────────────────────────────
  const EST = lerJson(ARQ, {});   // emp -> { status, em, itens, semErp, semSku, comparados, ignorados, erros }
  for (const e of EMP) if (EST[e.id]?.status === 'carregando') EST[e.id].status = 'pronto';
  const rodando = {};
  async function compararEmpresa(e) {
    if (rodando[e.id]) return;
    rodando[e.id] = true;
    const R = EST[e.id] ||= {};
    R.status = 'carregando'; R.inicio = Date.now(); R.etapa = 'anúncios';
    const erros = {};
    try {
      let anuncios = [];
      try { anuncios.push(...await itensML(e.idx)); } catch (er) { erros.ml = er.response?.status === 401 ? 'token ML expirado' : er.message; }
      const s = itensShopee(e.id); if (s) anuncios.push(...s); else if (shopee.loja(e.id).getTokens().access_token) erros.shopee = 'Shopee ainda carregando';
      const a = itensAmazon(e.id); if (a) anuncios.push(...a);
      const ignorados = { full: anuncios.filter(x => x.full).length };
      anuncios = anuncios.filter(x => !x.full);
      R.etapa = e.erp === 'Tiny' ? 'saldos no Tiny' : 'saldos no Bling';
      const erp = e.erp === 'Tiny' ? await erpTiny(anuncios.map(x => x.sku).filter(Boolean)) : await erpBling(e.idx);
      const semSku = [], semErp = [], divs = [], comparados = { ml: 0, shopee: 0, amazon: 0 };
      const bate = (x, r) => { const f = Math.max(0, Math.floor(r.fis)), d = Math.max(0, Math.floor(r.disp)); return x.qtd === f || x.qtd === d; };
      for (const x of anuncios) {
        if (!x.sku) { semSku.push(x); continue; }
        const r = achar(erp, x.sku);
        if (!r || r.semSaldo) { semErp.push(x); continue; }
        comparados[x.canal]++;
        if (!bate(x, r)) divs.push({ ...x, erpFis: Math.max(0, Math.floor(r.fis)), erpDisp: Math.max(0, Math.floor(r.disp)), kit: !!(r.kit || r.kitDe) });
      }
      R.etapa = 'conferindo divergências';
      await reconferir(e, divs);
      const itens = divs.filter(x => x.qtd !== x.erpFis && x.qtd !== x.erpDisp).map(x => ({ ...x, diff: x.qtd - x.erpDisp }));
      itens.sort((p, q) => Math.abs(q.diff) - Math.abs(p.diff));
      const curto = x => ({ canal: x.canal, anuncio: x.anuncio, nome: x.nome, sku: x.sku, link: x.link, nomeVar: x.nomeVar });
      Object.assign(R, { status: 'pronto', em: new Date().toISOString(), erp: e.erp, itens, comparados, ignorados,
        semSku: semSku.map(curto), semErp: semErp.map(curto), erros, duracaoSeg: Math.round((Date.now() - R.inicio) / 1000), etapa: null });
      console.log(`[inicio] estoque ${e.id}: ${itens.length} divergências em ${Object.values(comparados).reduce((a, b) => a + b, 0)} anúncios comparados`);
    } catch (er) {
      Object.assign(R, { status: 'erro', erro: er.response?.status === 401 ? e.erp + ': autorização expirada' : er.message, erros, etapa: null });
      console.warn('[inicio] estoque', e.id, er.message);
    } finally { rodando[e.id] = false; gravar(ARQ, EST); }
  }
  async function compararTodas() { for (const e of EMP) await compararEmpresa(e); }
  setTimeout(() => compararTodas().catch(() => {}), 12 * 60e3);     // depois que ML/Shopee carregaram
  setInterval(() => compararTodas().catch(() => {}), 30 * 60e3);

  // ─── Rotas ───────────────────────────────────────────────────────────────
  app.get('/inicio', (req, res) => {
    const empresas = EMP.map(e => {
      const d = dadosCache[e.idx], S = SHP[e.id], P = PEND[e.id] || {}, R = EST[e.id] || {};
      const porCanal = { ml: 0, shopee: 0, amazon: 0 };
      for (const x of R.itens || []) porCanal[x.canal]++;
      return {
        id: e.id, nome: e.nome, idx: e.idx, erp: e.erp,
        semPromo: {
          ml: d ? d.semPromo.length : null,
          shopee: S?.cache ? S.cache.produtos.filter(p => p._semPromo && estoqueShp(p) > 0).length : null,
          shopeeStatus: S?.cache ? 'ok' : (S?.status || 'sem_auth'),
        },
        pend: {
          ml: { perguntas: P.ml?.perguntas ?? (d ? d.perguntas.length : null), mensagens: P.ml?.mensagens ?? null, erroMensagens: P.ml?.erroMensagens || null },
          shopee: P.shopee?.semAuth || (!S?.cache && S?.status === 'sem_auth') ? { semAuth: true } : { chat: P.shopee?.chat ?? (S?.cache ? (S.cache.conversas || []).filter(c => c.pendente).length : null) },
          amazon: { conectada: amazon.loja(e.id).configurada() },
        },
        estoque: { status: R.status || 'aguardando', etapa: R.etapa || null, em: R.em || null, erro: R.erro || null, erros: R.erros || {},
          porCanal, total: (R.itens || []).length, comparados: R.comparados || null, semSku: (R.semSku || []).length, semErp: (R.semErp || []).length, ignorados: R.ignorados || {} },
      };
    });
    res.json({ empresas, em: new Date().toISOString(), pendEm: PEND.zagodini?.em || null });
  });
  app.get('/inicio/estoque', (req, res) => {
    res.json(Object.fromEntries(EMP.map(e => { const R = EST[e.id] || {}; return [e.id, { status: R.status || 'aguardando', em: R.em || null, itens: R.itens || [], semSku: R.semSku || [], semErp: R.semErp || [] }]; })));
  });
  app.post('/inicio/estoque/atualizar', (req, res) => {
    const alvo = EMP.filter(e => !req.query.emp || e.id === req.query.emp);
    (async () => { for (const e of alvo) await compararEmpresa(e); })().catch(() => {});
    res.json({ ok: true });
  });
  app.get('/debug/inicio', (req, res) => res.json({ PEND, estoque: Object.fromEntries(Object.entries(EST).map(([k, v]) => [k, { ...v, itens: (v.itens || []).length, semSku: (v.semSku || []).length, semErp: (v.semErp || []).length }])), tiny: { codigos: Object.keys(TINY.codigos).length, saldos: Object.keys(TINY.saldos).length, ultimaAtualizacao: TINY.ultimaAtualizacao } }));
};
