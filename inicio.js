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
  // começa assim que o ML de cada conta carregar: tenta a cada 1 min até todas responderem, depois a cada 5 min
  let ultPend = 0;
  setInterval(() => {
    const faltam = EMP.some(e => PEND[e.id]?.ml?.mensagens == null && PEND[e.id]?.ml?.erroMensagens == null);
    if (!faltam && Date.now() - ultPend < 5 * 60e3) return;
    if (!EMP.some(e => dadosCache[e.idx]?.uid)) return;
    ultPend = Date.now();
    atualizarPendencias().catch(e => console.warn('[inicio] pendências', e.message));
  }, 60e3);

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
  async function erpTiny(skusAnunciados, prog = () => {}) {
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
      prog(i + 1, faltam.length);
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
  const skuVarML = v => (v.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name || v.seller_custom_field || null;
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
      // oferta relâmpago em andamento: a Shopee mostra só o estoque da campanha (ex.: 3). Usa o estoque normal do item.
      try {
        const fl = (await sp.shopeeGet('/api/v2/shop_flash_sale/get_shop_flash_sale_list', { type: 2, offset: 0, limit: 20 })).response?.flash_sale_list || [];
        const fsMap = {};
        for (const f of fl) for (let off = 0; off < 500; off += 50) {
          const r = (await sp.shopeeGet('/api/v2/shop_flash_sale/get_shop_flash_sale_items', { flash_sale_id: f.flash_sale_id, offset: off, limit: 50 })).response || {};
          for (const it of r.item_info || []) fsMap[it.item_id + '|'] = { ...it, _fim: f.end_time };
          for (const m of r.models || []) fsMap[m.item_id + '|' + m.model_id] = { ...m, _fim: f.end_time };
          if ((r.item_info || []).length < 50) break;
        }
        for (const x of S) {
          const f = fsMap[x.anuncio + '|' + (x.variacao || '')] || (!x.variacao && fsMap[x.anuncio + '|']);
          if (f && f.stock != null) { x.relampago = { campanha: f.campaign_stock ?? null, normal: f.stock, fim: f._fim ? f._fim * 1000 : null }; x.qtdAlt = [f.stock, f.stock + (f.campaign_stock || 0)]; }
        }
      } catch (er) { console.log('[estoque] relâmpago ' + e.id + ': ' + er.message); }
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
      const erp = e.erp === 'Tiny' ? await erpTiny(anuncios.map(x => x.sku).filter(Boolean), (i, n) => { R.etapa = `saldos no Tiny (${i} de ${n}, ~${Math.ceil((n - i) * 1.2 / 60)} min)`; }) : await erpBling(e.idx);
      const semSku = [], semErp = [], divs = [], comparados = { ml: 0, shopee: 0, amazon: 0 };
      const bate = (x, r) => { const f = Math.max(0, Math.floor(r.fis)), d = Math.max(0, Math.floor(r.disp)); return x.qtd >= Math.min(f, d) && x.qtd <= Math.max(f, d); };   // entre o disponível e o físico = pedidos em andamento, não é divergência
      for (const x of anuncios) {
        if (!x.sku) { semSku.push(x); continue; }
        const r = achar(erp, x.sku);
        if (!r || r.semSaldo) { semErp.push(x); continue; }
        comparados[x.canal]++;
        if (!bate(x, r)) divs.push({ ...x, erpId: r.id, erpFis: Math.max(0, Math.floor(r.fis)), erpDisp: Math.max(0, Math.floor(r.disp)), kit: !!(r.kit || r.kitDe) });
      }
      R.etapa = 'conferindo divergências';
      await reconferir(e, divs);
      const itens = divs.filter(x => ![x.qtd, ...(x.qtdAlt || [])].some(q => q >= Math.min(x.erpFis, x.erpDisp) && q <= Math.max(x.erpFis, x.erpDisp)))
        .map(x => { const q = x.relampago ? x.relampago.normal : x.qtd; return { ...x, qtd: q, diff: q - x.erpDisp }; });
      itens.sort((p, q) => Math.abs(q.diff) - Math.abs(p.diff));
      if (e.erp !== 'Tiny' && syncCfg.on) { R.etapa = 'pedindo ao Bling para sincronizar'; await sincronizarDivergencias(e, itens).catch(er => console.warn('[sync] ' + e.id, er.message)); }
      const curto = x => ({ canal: x.canal, anuncio: x.anuncio, nome: x.nome, sku: x.sku, link: x.link, nomeVar: x.nomeVar });
      Object.assign(R, { status: 'pronto', em: new Date().toISOString(), erp: e.erp, itens, comparados, ignorados,
        semSku: semSku.map(curto), semErp: semErp.map(curto), erros, duracaoSeg: Math.round((Date.now() - R.inicio) / 1000), etapa: null });
      console.log(`[inicio] estoque ${e.id}: ${itens.length} divergências em ${Object.values(comparados).reduce((a, b) => a + b, 0)} anúncios comparados`);
    } catch (er) {
      Object.assign(R, { status: 'erro', erro: er.response?.status === 401 ? e.erp + ': autorização expirada' : er.message, erros, etapa: null });
      console.warn('[inicio] estoque', e.id, er.message);
    } finally { rodando[e.id] = false; gravar(ARQ, EST); }
  }
  // ─── Sincronização automática: pede ao Bling para reenviar o estoque ao canal ───────────────
  // O Bling só manda o estoque para os marketplaces quando o saldo muda. Para "forçar" o reenvio,
  // o painel faz uma entrada de 1 unidade e logo depois uma saída de 1 (saldo final igual, sem risco
  // de sobrescrever venda). Na Shopee em oferta relâmpago o canal não aceita: espera a oferta acabar.
  const ARQ_SYNC = path.join(DATA, 'apuracao_cache', 'inicio_sync.json');
  const SYNC = lerJson(ARQ_SYNC, {});
  const ARQ_SYNC_CFG = path.join(DATA, 'apuracao_cache', 'inicio_sync_cfg.json');
  const syncCfg = lerJson(ARQ_SYNC_CFG, { on: false });
  app.post('/inicio/estoque/sync-auto', (req, res) => {
    if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
    syncCfg.on = req.query.on === '1' || req.body?.on === true; gravar(ARQ_SYNC_CFG, syncCfg); res.json(syncCfg);
  });
  app.get('/inicio/estoque/sync', (req, res) => res.json({ auto: syncCfg.on, itens: SYNC }));         // "emp|sku" -> { em, n, status, aguardaAte, canal, erpId }
  const OBS = 'Painel: reenviar estoque aos canais (entrada/saída técnica de 1 un.)';
  // Bling: 3 requisições/s — repete em 429 com espera crescente
  async function blingReq(c, metodo, url, arg) {
    for (let t = 0; ; t++) {
      try { return metodo === 'get' ? await c.get(url, arg) : await c.post(url, arg); }
      catch (er) { if (er.response?.status === 429 && t < 8) { await delay(1500 * (t + 1)); continue; } throw er; }
    }
  }
  async function tocarBling(idx, produtoId) {
    const bling = require('./bling'), c = bling.client(idx);
    const P = (await blingReq(c, 'get', '/produtos/' + produtoId)).data?.data || {};
    // kit/composição não tem saldo próprio: mexe nos componentes
    const alvos = P.formato === 'E' ? (P.estrutura?.componentes || []).map(x => x.produto?.id).filter(Boolean).slice(0, 5) : [produtoId];
    if (!alvos.length) throw new Error('kit sem componentes');
    const deps = await bling.getDepositos(idx);
    const ign = new Set(deps.filter(d => /full/i.test(d.descricao || '') || d.desconsiderarSaldo === true).map(d => String(d.id)));
    for (const id of alvos) {
      const S = (await blingReq(c, 'get', '/estoques/saldos', { params: { idsProdutos: [id] } })).data?.data?.[0];
      const D = (S?.depositos || []).filter(d => !ign.has(String(d.id))).sort((a, b) => num(b.saldoFisico) - num(a.saldoFisico));
      const dep = D[0]?.id || deps.find(d => d.padrao && !ign.has(String(d.id)))?.id || deps.find(d => !ign.has(String(d.id)))?.id;
      if (!dep) throw new Error('sem depósito');
      await blingReq(c, 'post', '/estoques', { produto: { id }, deposito: { id: dep }, operacao: 'E', quantidade: 1, preco: 0, custo: 0, observacoes: OBS });
      await delay(1500);
      // a saída precisa acontecer de qualquer jeito (senão o saldo fica +1): insiste até 5 min
      for (let t = 0; ; t++) {
        try { await blingReq(c, 'post', '/estoques', { produto: { id }, deposito: { id: dep }, operacao: 'S', quantidade: 1, preco: 0, custo: 0, observacoes: OBS }); break; }
        catch (er) { if (t >= 20) { console.error('[sync] ATENÇÃO: entrada sem saída', idx, id, dep, er.message); throw new Error('entrada de 1 un. feita mas a saída falhou — produto ' + id + ' ficou +1 no Bling'); } await delay(15000); }
      }
      await delay(1000);
    }
    return alvos.length;
  }
  async function sincronizarDivergencias(e, itens) {
    const agora = Date.now();
    let feitos = 0;
    // o que já foi sincronizado e continua diferente depois de 2 tentativas: para de insistir e avisa
    for (const x of itens) {
      if (!x.erpId || x.full) continue;
      const k = e.id + '|' + x.sku, S = SYNC[k] ||= { n: 0 };
      S.canal = x.canal; S.erpId = x.erpId;
      if (x.relampago) {                      // Shopee bloqueia durante a oferta: agenda para depois do fim
        S.status = 'aguardando relâmpago'; S.aguardaAte = (x.relampago.fim || agora + 6 * 3600e3) + 10 * 60e3;
      } else if (S.n >= 2 && agora - (S.em || 0) < 24 * 3600e3) {
        S.status = 'Bling não atualizou o canal (conferir vínculo/configuração da loja no Bling)';
      } else if (!S.em || agora - S.em > 2 * 3600e3) {
        if (feitos >= 30) continue;
        try { await tocarBling(e.idx, x.erpId); S.em = Date.now(); S.n = (S.n || 0) + 1; S.status = 'sincronização pedida ao Bling'; S.erro = null; feitos++; }
        catch (er) { S.erro = er.response?.data?.error?.description || er.response?.data?.error?.message || er.message; S.status = 'erro'; }
      }
      x.sync = { status: S.status, em: S.em || null, n: S.n || 0, erro: S.erro || null, aguardaAte: S.aguardaAte || null };
    }
    // itens que deixaram de divergir: zera o contador
    const atuais = new Set(itens.map(x => e.id + '|' + x.sku));
    for (const k of Object.keys(SYNC)) if (k.startsWith(e.id + '|') && !atuais.has(k) && !SYNC[k].aguardaAte) delete SYNC[k];
    gravar(ARQ_SYNC, SYNC);
    if (feitos) console.log(`[sync] ${e.id}: ${feitos} produtos reenviados pelo Bling`);
  }
  // fim da oferta relâmpago: reenvia na hora certa
  setInterval(async () => {
    const agora = Date.now();
    for (const [k, S] of Object.entries(SYNC)) {
      if (!syncCfg.on || !S.aguardaAte || agora < S.aguardaAte) continue;
      const e = EMP.find(x => x.id === k.split('|')[0]); if (!e || e.erp === 'Tiny') continue;
      try { await tocarBling(e.idx, S.erpId); S.em = Date.now(); S.n = (S.n || 0) + 1; S.status = 'sincronização pedida ao Bling (após relâmpago)'; S.erro = null; }
      catch (er) { S.erro = er.message; S.status = 'erro'; }
      delete S.aguardaAte; gravar(ARQ_SYNC, SYNC);
    }
  }, 5 * 60e3);
  app.get('/inicio/estoque/saldo', async (req, res) => {
    if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
    const e = EMP.find(x => x.id === req.query.emp);
    try { const c = require('./bling').client(e.idx); res.json((await blingReq(c, 'get', '/estoques/saldos', { params: { idsProdutos: [req.query.id] } })).data); } catch (er) { res.status(500).json({ erro: er.message }); }
  });
  // manual (admin): POST /inicio/estoque/sincronizar?emp=zagodini&sku=7303522-07
  app.post('/inicio/estoque/sincronizar', async (req, res) => {
    if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
    const e = EMP.find(x => x.id === req.query.emp); if (!e || e.erp === 'Tiny') return res.status(400).json({ erro: 'empresa inválida (só Bling)' });
    const R = EST[e.id] || {}, x = (R.itens || []).find(i => K(i.sku) === K(req.query.sku));
    let id = x?.erpId || req.query.id;
    if (!id) return res.status(404).json({ erro: 'SKU não está nas divergências; passe &id=<id do produto no Bling>' });
    try { const n = await tocarBling(e.idx, id); const k = e.id + '|' + (x?.sku || req.query.sku); SYNC[k] = { ...(SYNC[k] || {}), em: Date.now(), n: (SYNC[k]?.n || 0) + 1, status: 'sincronização pedida ao Bling (manual)', erpId: id }; gravar(ARQ_SYNC, SYNC); res.json({ ok: true, produtos: n }); }
    catch (er) { res.status(500).json({ erro: er.response?.data || er.message }); }
  });

  // Cada empresa roda sozinha (em paralelo): começa assim que o ML dela carregou (e a Shopee, se conectada)
  // e depois repete a cada 30 min.
  const ultimaEst = {};
  const pronta = e => dadosCache[e.idx]?.uid && (!shopee.loja(e.id).getTokens().access_token || SHP[e.id]?.cache || ['erro', 'sem_auth'].includes(SHP[e.id]?.status));
  setInterval(() => {
    for (const e of EMP) {
      if (rodando[e.id] || !pronta(e)) continue;
      if (ultimaEst[e.id] && Date.now() - ultimaEst[e.id] < 30 * 60e3) continue;
      ultimaEst[e.id] = Date.now();
      compararEmpresa(e).catch(() => {});
    }
  }, 30e3);

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
        estoque: { status: R.status || 'aguardando', etapa: R.etapa || (!R.status ? (dadosCache[e.idx]?.uid ? 'esperando a Shopee carregar' : 'esperando o Mercado Livre carregar') : null), em: R.em || null, erro: R.erro || null, erros: R.erros || {},
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
    for (const e of alvo) { ultimaEst[e.id] = Date.now(); compararEmpresa(e).catch(() => {}); }
    res.json({ ok: true });
  });
  app.get('/debug/inicio', (req, res) => res.json({ PEND, estoque: Object.fromEntries(Object.entries(EST).map(([k, v]) => [k, { ...v, itens: (v.itens || []).length, semSku: (v.semSku || []).length, semErp: (v.semErp || []).length }])), tiny: { codigos: Object.keys(TINY.codigos).length, saldos: Object.keys(TINY.saldos).length, ultimaAtualizacao: TINY.ultimaAtualizacao } }));
};
