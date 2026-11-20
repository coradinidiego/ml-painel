/**
 * Queima de estoque parado no Full (Mercado Livre) — Diego, 13/11/2026.
 * Itens com tempo de estoque no Full: vender a margem baixa, GANHANDO o catálogo, até o Full acabar.
 * Quando o Full zera, o painel AVISA no Telegram para voltar o preço cheio (não sobe o preço sozinho).
 *
 * A cada 30 min, para cada item da lista:
 *   1. estoque do anúncio (Full) = 0  → avisa uma vez "Full acabou" e para de controlar o item;
 *   2. catálogo perdendo e o preço para ganhar (price_to_win) respeita o piso → baixa o preço
 *      (edita a promoção de preço livre que já está ativa, ou entra numa) e avisa;
 *   3. preço para ganhar abaixo do piso → não mexe e avisa (uma vez por preço).
 * Piso: `piso` (preço mínimo aprovado pelo Diego) quando informado; sem ele, só baixa se o lucro ficar >= 0.
 *
 *  GET  /queima-full            lista e situação
 *  POST /queima-full/item       { idx, id, nome?, piso?, var? }  inclui/atualiza
 *  POST /queima-full/remover    { id }
 *  POST /queima-full/rodar      roda agora
 */
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');
const cm = require('./custos_ml');

const ARQ = path.join(DATA, 'apuracao_cache', 'queima_full.json');
const CONTA = ['Zagodini', 'Com Amor de Mãe', 'Lufe'];
const EDITA = new Set(['DEAL', 'SELLER_CAMPAIGN', 'PRICE_DISCOUNT']);
const r2 = v => Math.round(v * 100) / 100;
const brl = v => 'R$ ' + (+v).toFixed(2).replace('.', ',');
const delay = ms => new Promise(r => setTimeout(r, ms));
const horaBR = (t = Date.now()) => new Date(t - 3 * 3600e3).toISOString().slice(0, 19);
const ler = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };

// lista inicial (prints do Diego em 13/11): anúncio de catálogo de cada item; sem catálogo = só avisa o fim do Full
const INICIAL = [
  { idx: 1, id: 'MLB4745119397', nome: 'Adesivos Repelente Amo Protect 56und' },
  { idx: 1, id: 'MLB3830090895', nome: 'Organizador de Banho Patinhos Buba' },
  { idx: 1, id: 'MLB5118440054', nome: 'Kit 6 Potes Leite Materno Buba' },
  { idx: 1, id: 'MLB3832077005', nome: 'Jogo Memória Fazenda Junges' },
  { idx: 1, id: 'MLB5773105224', nome: 'Lenço Repelente Repellik 20 un' },
  { idx: 1, id: 'MLB5346717440', nome: 'Kit 5 Meias 3/4 (2-3 anos)', var: 187491227565 },
  { idx: 0, id: 'MLB3317777491', nome: 'Adubo Forth Flores 400g', piso: 23.64 },   // Diego aprovou baixar a R$ 23,64 (prejuízo de R$ 0,29/un)
  { idx: 0, id: 'MLB5495231514', nome: 'Adubo Equilíbrio Solo 500ml' },
  { idx: 0, id: 'MLB3886067284', nome: 'Porta Guarda Chuva Branco' },
  { idx: 0, id: 'MLB4553016636', nome: 'Porta Guarda Chuva Preto' },
  { idx: 0, id: 'MLB3692436256', nome: 'Micro Mini Capacitor 270-324uf' },
  { idx: 0, id: 'MLB6917906000', nome: 'Vaso Face Menino N21 Preto' },
  { idx: 0, id: 'MLB3945703483', nome: 'Vaso Face Menino N21 Cimento' },
  { idx: 0, id: 'MLB3836220627', nome: 'Vaso Face Mulher N17 Preto' },
  { idx: 0, id: 'MLB6507269006', nome: 'Kit 2 Adubos Verde Raiz' },
];

const S = Object.assign({ itens: null, hist: [] }, ler(ARQ, {}));
if (!Array.isArray(S.itens)) S.itens = INICIAL.map(x => ({ ...x, desde: new Date().toISOString() }));
for (const x of S.itens) if (!x.precoAntes) { const h = S.hist.filter(y => y.id === x.id && y.acao === 'baixou' && y.de > 0).pop(); if (h) x.precoAntes = h.de; }
const salvar = () => { S.hist = S.hist.slice(0, 300); try { fs.mkdirSync(path.dirname(ARQ), { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(S)); } catch (e) {} };
const tg = msg => { try { require('./telegram').sendTelegram(msg); } catch (e) {} };
const log = (x, o) => { S.hist.unshift({ em: new Date().toISOString(), id: x.id, nome: x.nome, ...o }); };

let F;   // { ml, mlReq, uid }

async function margem(idx, it, preco) {
  try { const m = await cm.margemPreco(F.ml, idx, await F.uid(idx), it, preco, 0); return m && m.lucro != null ? m : null; } catch (e) { return null; }
}

// unidades vendidas (pedidos pagos) do anúncio/variação desde uma data
async function vendidosDesde(x, desde) {
  const uid = await F.uid(x.idx); let vend = 0, off = 0;
  for (;;) {
    const r = await F.ml(x.idx, '/orders/search', { seller: uid, item: x.id, 'order.date_created.from': new Date(Date.parse(desde)).toISOString().slice(0, 19) + '.000-00:00', sort: 'date_desc', limit: 50, offset: off });
    for (const o of r.results || []) {
      if (o.status !== 'paid') continue;
      for (const i of o.order_items || []) if (i.item?.id === x.id && (!x.var || String(i.item.variation_id) === String(x.var))) vend += +i.quantity || 0;
    }
    off += 50; if (off >= (r.paging?.total || 0) || off >= 1000) break;
    await delay(400);
  }
  return vend;
}

// Menor preço com lucro >= 0 (Diego, 19/11: "coloca tudo no mínimo para zerar logo"). O frete grátis a partir de R$ 79
// quebra a curva, então procura primeiro abaixo de R$ 79 e só depois de R$ 79 até o preço cheio. null = não existe.
async function precoMinimo(idx, it, teto) {
  const luc = async p => { const m = await margem(idx, it, p); await delay(200); return m ? m.lucro : null; };
  const busca = async (lo, hi) => {   // menor preço em [lo, hi] com lucro >= 0 (lucro cresce com o preço dentro do trecho)
    const lh = await luc(hi); if (lh == null) return undefined; if (lh < 0) return null;
    for (let i = 0; i < 10 && hi - lo > 0.04; i++) { const mid = r2((lo + hi) / 2), l = await luc(mid); if (l == null) return undefined; if (l >= 0) hi = mid; else lo = mid; }
    return r2(hi);
  };
  const lo = r2(Math.max(1, teto * 0.15));
  if (teto >= 79) { const a = lo < 78.99 ? await busca(lo, 78.99) : null; if (a) return a; if (a === undefined) return undefined; return await busca(79, teto); }
  return await busca(lo, teto);
}

// muda o preço do anúncio por uma promoção de preço livre (a mesma lógica da tela de Promoções)
async function aplicarPreco(idx, id, preco) {
  let L = await F.ml(idx, '/seller-promotions/items/' + id, { app_version: 'v2' });
  if (!Array.isArray(L)) L = [];
  const dentro = p => !p.min_discounted_price || (preco >= +p.min_discounted_price - 0.001 && preco <= +p.max_discounted_price + 0.001);
  const url = '/seller-promotions/items/' + id + '?app_version=v2';
  // 1º: promoção de preço livre já ativa (campanha ou desconto próprio) → edita o preço
  const ativa = L.filter(p => p.status === 'started' && EDITA.has(p.type) && dentro(p)).sort((a, b) => (a.type === 'PRICE_DISCOUNT') - (b.type === 'PRICE_DISCOUNT'))[0];
  if (ativa) {
    if (ativa.type === 'PRICE_DISCOUNT') {   // o ML não aceita PUT no desconto próprio: um novo POST substitui
      await require('./promos_ml').trocarDescontoProprio(idx, id, { promotion_type: 'PRICE_DISCOUNT', deal_price: preco, start_date: horaBR(), finish_date: ativa.finish_date ? String(ativa.finish_date).slice(0, 19) : horaBR(Date.now() + 30 * 864e5) }, +ativa.price || null, F);
    } else await F.mlReq(idx, 'put', url, { promotion_id: ativa.id, promotion_type: ativa.type, deal_price: preco });
    return (ativa.name || 'Desconto próprio') + ' (editada)';
  }
  // 2º: campanha disponível com preço livre; 3º: desconto próprio novo
  const camp = L.find(p => p.status === 'candidate' && ['DEAL', 'SELLER_CAMPAIGN'].includes(p.type) && p.min_discounted_price && dentro(p));
  if (camp) { await F.mlReq(idx, 'post', url, { promotion_id: camp.id, promotion_type: camp.type, deal_price: preco }); return camp.name || camp.type; }
  await F.mlReq(idx, 'post', url, { promotion_type: 'PRICE_DISCOUNT', deal_price: preco, start_date: horaBR(), finish_date: horaBR(Date.now() + 30 * 864e5) });
  return 'Desconto próprio';
}

// Diego, 20/11: além do catálogo, os itens da queima entram em TODAS as promoções disponíveis — sempre no MESMO preço da queima
// (não baixa mais por causa da promoção). Campanhas com preço livre/faixa (ML e do vendedor) e oferta relâmpago.
// Promoção de preço fixo do ML abaixo do preço da queima fica de fora (seria vender com prejuízo sem o seu OK).
async function entrarTodas(x, preco, qtd) {
  let L = await F.ml(x.idx, '/seller-promotions/items/' + x.id, { app_version: 'v2' }); if (!Array.isArray(L)) L = [];
  const url = '/seller-promotions/items/' + x.id + '?app_version=v2', novas = [], fora = [];
  x.promoErr = x.promoErr || {}; for (const k of Object.keys(x.promoErr)) if (Date.now() - x.promoErr[k].em > 6 * 3600e3) delete x.promoErr[k];
  for (const p of L) {
    if (p.status !== 'candidate' || !p.id) continue;
    const nome = p.name || p.type, faixa = +p.max_discounted_price > 0, cabe = !faixa || (preco >= +p.min_discounted_price - 0.001 && preco <= +p.max_discounted_price + 0.001);
    let body = null;
    if (['DEAL', 'SELLER_CAMPAIGN'].includes(p.type)) { if (cabe) body = { promotion_id: p.id, promotion_type: p.type, deal_price: preco }; else fora.push(nome + ': só aceita de ' + brl(p.min_discounted_price) + ' a ' + brl(p.max_discounted_price)); }
    else if (p.type === 'LIGHTNING') { if (faixa && cabe) body = { promotion_id: p.id, promotion_type: 'LIGHTNING', deal_price: preco, stock: Math.max(1, qtd) }; else fora.push(nome + ': faixa ' + brl(p.min_discounted_price) + ' a ' + brl(p.max_discounted_price)); }
    else if (/COUPON/.test(p.type)) continue;   // cupom dá desconto por cima do preço: não entra sozinho
    else { fora.push(nome + ' (' + p.type + ')' + (+p.price > 0 ? ': preço fixo ' + brl(p.price) : '')); continue; }
    if (!body) continue;
    if (x.promoErr[p.id]) { fora.push(nome + ': ML recusou (' + x.promoErr[p.id].erro + ')'); continue; }
    try { await F.mlReq(x.idx, 'post', url, body); novas.push(nome); await delay(1200); }
    catch (e) { const d = e.response?.data, er = String(d?.message || d?.error || e.message).slice(0, 120); x.promoErr[p.id] = { em: Date.now(), erro: er }; fora.push(nome + ': ML recusou (' + er + ')'); }
  }
  x.promos = L.filter(p => p.status === 'started').map(p => p.name || (p.type === 'PRICE_DISCOUNT' ? 'Desconto próprio' : p.type)).concat(novas);
  x.promosFora = fora;
  if (novas.length) { log(x, { acao: 'entrou em promoção', promos: novas, preco }); tg(`🏷️ Queima Full — ${CONTA[x.idx]}\n${x.nome} (${x.id}): entrou em ${novas.join(', ')} a ${brl(preco)} (mesmo preço da queima).`); }
}

// Sobe o preço de volta: o ML não deixa AUMENTAR o preço de uma promoção, então sai das promoções que estão abaixo do
// alvo e entra de novo no preço de antes. Se a nova entrada for recusada, o anúncio fica no preço cheio (sem prejuízo).
async function voltarPreco(idx, id, alvo) {
  let L = await F.ml(idx, '/seller-promotions/items/' + id, { app_version: 'v2' }); if (!Array.isArray(L)) L = [];
  const baixas = L.filter(p => p.status === 'started' && +p.price > 0 && +p.price < alvo - 0.01), sairam = [];
  for (const p of baixas) {
    await F.mlReq(idx, 'delete', '/seller-promotions/items/' + id + '?app_version=v2&promotion_type=' + p.type + (p.id ? '&promotion_id=' + p.id : ''));
    sairam.push(p.name || (p.type === 'PRICE_DISCOUNT' ? 'Desconto próprio' : p.type)); await delay(1500);
  }
  await delay(5000);
  let sp = null; try { sp = +(await F.ml(idx, '/items/' + id + '/sale_price', { context: 'channel_marketplace' }))?.amount || null; } catch (e) {}
  if (sp && sp < alvo - 0.01) throw new Error('saí de ' + (sairam.join(', ') || 'nenhuma promoção') + ' mas o preço ainda está em ' + brl(sp));
  let via = null; try { if (!sp || sp > alvo + 0.05) via = await aplicarPreco(idx, id, alvo); } catch (e) {}
  try { sp = +(await F.ml(idx, '/items/' + id + '/sale_price', { context: 'channel_marketplace' }))?.amount || sp; } catch (e) {}
  return { preco: sp, via, sairam };
}

async function conferir(x) {
  const conta = CONTA[x.idx];
  const it = await F.ml(x.idx, '/items/' + x.id, { include_attributes: 'all' });
  if (!it?.id) throw new Error('anúncio não encontrado');
  it._sku = (it.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name || it.seller_custom_field || '';
  const v = x.var ? (it.variations || []).find(y => String(y.id) === String(x.var)) : null;
  const anuncio = v ? +v.available_quantity || 0 : +it.available_quantity || 0;
  // preço que o comprador vê hoje (o /items traz o preço de lista, sem a promoção)
  let cur = +(v?.price || it.price) || null;
  try { const sp = await F.ml(x.idx, '/items/' + x.id + '/sale_price', { context: 'channel_marketplace' }); if (+sp?.amount > 0) cur = +sp.amount; } catch (e) {}
  // estoque NO FULL: enquanto o anúncio está no Full, a quantidade dele é a do Full; se saiu do Full (passou a vender
  // do estoque próprio), o Full acabou — aí não pode continuar no preço de queima
  // Diego, 20/11: a queima vale só para o ESTOQUE ANTIGO (saldo da tela "Estoque antigo" do ML), não para tudo que está no Full
  // (reposição nova não tem tempo de estoque). `limite` = unidades antigas a queimar; desconta o que vendeu desde que foi informado.
  let restante = null;
  if (x.limite != null) { try { x.vendidosLimite = await vendidosDesde(x, x.limiteDesde || x.desde); } catch (e) {} restante = Math.max(0, x.limite - (x.vendidosLimite || 0)); }
  const noFull = it.shipping?.logistic_type === 'fulfillment' ? anuncio : 0;
  const qtd = restante != null ? Math.min(noFull, restante) : noFull;
  x.fullTotal = noFull;
  x.full = qtd; x.anuncio = anuncio; x.cheio = +(it.original_price || it.price) || null; x.conferidoEm = new Date().toISOString();
  // 1. Full acabou → volta o preço de antes da queima (não vende no preço baixo além do estoque do Full)
  if (qtd <= 0) {
    if (!x.acabou || (x.precoAntes && !x.voltou && cur && cur < x.precoAntes - 0.05 && !x.var)) {   // (repete enquanto o preço não tiver voltado)
      x.acabou = x.acabou || new Date().toISOString(); x.situacao = x.limite != null && noFull > 0 ? 'estoque antigo acabou' : 'Full acabou'; x.piso = null; x.pergunta = null;
      let volta = `Pode voltar o preço cheio${x.cheio ? ' (' + brl(x.cheio) + ')' : ''} / margem padrão.`;
      if (x.precoAntes && cur && cur < x.precoAntes - 0.05 && !x.var) {
        try { const r = await voltarPreco(x.idx, x.id, x.precoAntes); volta = `Voltei o preço para ${brl(r.preco || x.precoAntes)}` + (r.via ? ` (${r.via})` : r.preco > x.precoAntes + 0.05 ? ' (preço cheio: o ML não aceitou a promoção de antes, ' + brl(x.precoAntes) + ')' : '') + `. Saí de: ${r.sairam.join(', ') || '—'}.`; x.situacao += ' — preço voltou para ' + brl(r.preco || x.precoAntes); x.preco = r.preco || x.precoAntes; x.voltou = new Date().toISOString(); }
        catch (e) { volta = `⚠️ NÃO consegui voltar o preço sozinho (${e.response?.data?.message || e.message}). Volte na mão para ${brl(x.precoAntes)}` + (anuncio > 0 ? ` — o anúncio ainda tem ${anuncio} un fora do Full vendendo a ${brl(cur)}!` : '.'); }
      }
      log(x, { acao: 'Full acabou', volta });
      tg(`✅ Queima Full — ${conta}\n${x.nome} (${x.id}): ${x.limite != null && noFull > 0 ? 'o ESTOQUE ANTIGO acabou (ainda há ' + noFull + ' un novas no Full, que não entram na queima)' : 'o Full ACABOU'}.\n${volta}`);
    }
    return;
  }
  if (x.acabou) { x.acabou = null; x.voltou = null; }   // voltou a ter estoque (reposição): controla de novo
  // preço mínimo sem prejuízo (refeito a cada 6 h)
  if (!x.var && x.cheio && (!x.minEm || Date.now() - Date.parse(x.minEm) > 6 * 3600e3)) { const mn = await precoMinimo(x.idx, it, x.cheio); if (mn !== undefined) { x.min = mn; x.minEm = new Date().toISOString(); } }
  const baixar = async (alvo, motivo) => {
    const antes = cur, m = await margem(x.idx, it, alvo); if (!x.precoAntes) x.precoAntes = antes;
    let via = await aplicarPreco(x.idx, x.id, alvo);
    try { const tb = await require('./promos_ml').entrarCampanhasMesmoPreco(x.idx, x.id, alvo, F); if (tb.length) via += ' + ' + tb.join(', '); } catch (e) {}
    const lucroTxt = m ? ` (lucro ${brl(m.lucro)}/un, ${m.pct}%)` : '';
    let st = null;
    if (it.catalog_listing) { await delay(8000); try { const q = await F.ml(x.idx, '/items/' + x.id + '/price_to_win', { siteId: 'MLB', version: 'v2' }); st = q.status; } catch (e) {} x.catalogo = st; }
    x.preco = alvo; x.avisoPiso = null; x.pergunta = null;
    x.situacao = (st === 'winning' ? 'ganhando a ' : st ? 'baixado para ' : 'sem catálogo — baixado para ') + brl(alvo) + (motivo === 'minimo' ? ' (mínimo sem prejuízo)' : '');
    log(x, { acao: 'baixou', de: antes, para: alvo, via, catalogo: st, lucro: m?.lucro ?? null, motivo });
    tg(`🔥 Queima Full — ${conta}\n${x.nome} (${x.id}): ${brl(antes)} → ${brl(alvo)}${lucroTxt} via ${via}.\n${motivo === 'minimo' ? 'Preço mínimo sem prejuízo, para zerar o Full. ' : ''}${st ? 'Catálogo: ' + (st === 'winning' ? 'GANHANDO' : 'ainda ' + st) + '. ' : ''}Full: ${qtd} un.`);
  };
  const noMinimo = x.min > 0 && cur > x.min + 0.05;   // ainda dá para baixar sem prejuízo
  if (!it.catalog_listing) {
    x.preco = cur; x.catalogo = null;
    if (x.var) { x.situacao = 'sem catálogo, anúncio com variação — não baixo sozinho (mudaria o preço dos outros tamanhos)'; return; }
    if (noMinimo) return baixar(x.min, 'minimo');
    x.situacao = 'sem catálogo — ' + (x.min > 0 ? 'no mínimo sem prejuízo (' + brl(cur) + ')' : 'não existe preço sem prejuízo até o preço cheio');
    return;
  }
  // 2. catálogo
  const p = await F.ml(x.idx, '/items/' + x.id + '/price_to_win', { siteId: 'MLB', version: 'v2' });
  x.preco = +p.current_price || cur; x.catalogo = p.status;
  if (p.status === 'winning') {
    if (noMinimo) return baixar(x.min, 'minimo');
    x.situacao = 'ganhando a ' + brl(x.preco) + (x.min > 0 && x.preco <= x.min + 0.05 ? ' (no mínimo)' : ''); x.avisoPiso = null; x.pergunta = null; return;
  }
  const ptw = r2(+p.price_to_win || 0);
  if (!(ptw > 0) || !(ptw < x.preco - 0.005) || (p.reason || []).includes('no_improvement_price')) {
    if (noMinimo) return baixar(x.min, 'minimo');
    x.situacao = 'perdendo — preço não resolve (ML não informa preço para ganhar)'; return;
  }
  const m = await margem(x.idx, it, ptw);
  const pode = x.piso > 0 ? ptw >= x.piso - 0.001 : (m && m.lucro >= 0);
  const lucroTxt = m ? ` (lucro ${brl(m.lucro)}/un, ${m.pct}%)` : ' (sem custo no ERP para calcular o lucro)';
  if (!pode) {
    if (noMinimo) await baixar(x.min, 'minimo');   // desce até onde não dá prejuízo; abaixo disso, só com o OK do Diego
    x.situacao = `perdendo — para ganhar ${brl(ptw)}${lucroTxt}: aguardando seu OK no Telegram`;
    if (!x.avisoPiso || Math.abs(x.avisoPiso - ptw) / ptw > 0.02) {   // pergunta uma vez por preço (de novo só se mudar mais de 2%)
      x.avisoPiso = ptw; x.pergunta = { preco: ptw, em: new Date().toISOString() }; log(x, { acao: 'perguntou (prejuízo)', ptw, lucro: m?.lucro ?? null });
      const cod = 'QF:' + x.id + ':' + Math.round(ptw * 100);
      try { require('./telegram').sendTelegram(`⚠️ Queima Full — ${conta}\n${x.nome} (${x.id}) está PERDENDO o catálogo a ${brl(x.preco)}.\nPara ganhar: <b>${brl(ptw)}</b>${lucroTxt}.\nFull: ${qtd} un${m ? ' → prejuízo total de até ' + brl(Math.abs(m.lucro) * qtd) : ''}.\n\nBaixo para ${brl(ptw)}?\n${cod}`,
        { inline_keyboard: [[{ text: '✅ Baixar para ' + brl(ptw), callback_data: cod + ':sim' }, { text: '❌ Não', callback_data: cod + ':nao' }]] }); } catch (e) {}
    }
    return;
  }
  // 3. baixa para ganhar (direto no mínimo sem prejuízo, se ele for menor que o preço para ganhar)
  await baixar(x.min > 0 && x.min < ptw - 0.05 && !(x.piso > 0) ? x.min : ptw, x.min > 0 && x.min < ptw - 0.05 && !(x.piso > 0) ? 'minimo' : 'catalogo');
}

/** Resposta do Telegram (botão ou "sim"/"não" respondendo a pergunta): aprova baixar com prejuízo só até aquele preço. */
async function responder(id, preco, resp) {
  const x = S.itens.find(y => y.id === id); if (!x) return 'Esse item não está mais na queima do Full.';
  if (x.acabou) return 'O Full desse item já acabou — não baixei.';
  if (resp !== 'sim') { x.pergunta = null; log(x, { acao: 'recusou baixar', preco }); salvar(); return '👌 Ok, não baixo ' + x.nome + '. Só pergunto de novo se o preço para ganhar mudar.'; }
  x.piso = r2(preco); x.avisoPiso = null; x.pergunta = null; log(x, { acao: 'aprovou piso', piso: x.piso }); salvar();
  const t = setInterval(async () => { if (rodando) return; clearInterval(t); rodando = true; try { await conferir(x); x.erro = null; } catch (e) { x.erro = e.response?.data?.message || e.message; tg('⚠️ Queima Full: não consegui baixar ' + x.nome + ' — ' + x.erro); } finally { salvar(); rodando = false; } }, 2000);
  return '👍 Ok! Baixando ' + x.nome + ' para ' + brl(x.piso) + ' (só enquanto tiver Full)…';
}

// Ritmo de venda (Diego, 17/11): vendas do anúncio desde que entrou na queima (pedidos pagos do ML), saldo por dia,
// média por dia e previsão de quando o Full acaba. Refeito no máximo a cada 6 h por item.
const diaBR = (t = Date.now()) => horaBR(t).slice(0, 10);
async function ritmo(x) {
  x.saldo = x.saldo || {}; x.saldo[diaBR()] = x.full;
  const ds = Object.keys(x.saldo).sort(); while (ds.length > 60) delete x.saldo[ds.shift()];
  if (x.ritmoEm && Date.now() - Date.parse(x.ritmoEm) < 6 * 3600e3) return;
  const vend = await vendidosDesde(x, x.desde);
  const dias = Math.max(1, (Date.now() - Date.parse(x.desde)) / 864e5);
  x.vendidos = vend; x.porDia = r2(vend / dias); x.diasRestantes = vend > 0 && x.full > 0 ? Math.ceil(x.full / (vend / dias)) : null; x.ritmoEm = new Date().toISOString();
}
// Resumo diário no Telegram (primeira rodada depois das 8h de Brasília)
function resumoDiario() {
  const hoje = diaBR(); if (S.resumoDia === hoje || +horaBR().slice(11, 13) < 8) return;
  S.resumoDia = hoje;
  const L = S.itens.filter(x => !x.acabou && x.full > 0); if (!L.length) return;
  const lin = x => `• ${x.nome}: ${x.full} un ${x.limite != null ? 'de estoque antigo' : 'no Full'} · vendeu ${x.vendidos ?? '?'} (${x.porDia ?? '?'}/dia)` + (x.diasRestantes ? ` · acaba em ~${x.diasRestantes} d` : x.vendidos === 0 ? ' · SEM VENDA' : '') + (x.catalogo && x.catalogo !== 'winning' ? ' · perdendo catálogo' : '');
  let msg = '📦 Queima Full — resumo do dia';
  for (const idx of [0, 1, 2]) { const l = L.filter(x => x.idx === idx); if (l.length) msg += `\n\n${CONTA[idx]}\n` + l.sort((a, b) => (a.diasRestantes || 9999) - (b.diasRestantes || 9999)).map(lin).join('\n'); }
  tg(msg);
}

let rodando = false;
async function rodar() {
  if (rodando || !F) return; rodando = true;
  try {
    for (const x of S.itens) {
      if (x.acabou && Date.now() - Date.parse(x.acabou) > 3 * 864e5) continue;   // acabou há mais de 3 dias: não consulta mais
      try { await conferir(x); x.erro = null; }
      catch (e) { const d = e.response?.data; x.erro = d?.message || d?.error || e.message; x.situacao = 'erro: ' + x.erro; log(x, { acao: 'erro', erro: x.erro }); }
      if (!x.acabou) { try { await ritmo(x); } catch (e) { x.ritmoErro = e.response?.data?.message || e.message; } }
      if (!x.acabou && !x.var && x.full > 0 && x.preco > 0 && !x.erro) { try { await entrarTodas(x, x.preco, x.full); } catch (e) { x.promosErro = e.response?.data?.message || e.message; } }
      await delay(1200);
    }
    try { resumoDiario(); } catch (e) {}
    S.rodadaEm = new Date().toISOString();
  } finally { salvar(); rodando = false; }
}

function rotas(app, fontes) {
  F = fontes;
  const admin = (req, res) => { if (require('./auth').ativo() && !req.usuario?.admin) { res.status(403).json({ erro: 'só admin' }); return false; } return true; };
  const json = require('express').json();
  app.get('/queima-full', (req, res) => res.json({ rodando, rodadaEm: S.rodadaEm || null, itens: S.itens, hist: S.hist.slice(0, 80) }));
  app.post('/queima-full/item', json, (req, res) => {
    if (!admin(req, res)) return;
    const b = req.body || {}, id = String(b.id || ''), idx = parseInt(b.idx);
    if (!/^MLB\d+$/.test(id) || ![0, 1, 2].includes(idx)) return res.status(400).json({ erro: 'informe idx (0, 1, 2) e id (MLB...)' });
    let x = S.itens.find(y => y.id === id);
    if (!x) { x = { idx, id, desde: new Date().toISOString() }; S.itens.push(x); }
    if (b.nome) x.nome = String(b.nome); if (!x.nome) x.nome = id;
    if (b.piso !== undefined) x.piso = +b.piso > 0 ? r2(+b.piso) : null;
    if (b.var !== undefined) x.var = b.var || null;
    if (b.limite !== undefined) { x.limite = b.limite === null || b.limite === '' ? null : Math.max(0, parseInt(b.limite) || 0); x.limiteDesde = new Date().toISOString(); x.vendidosLimite = 0; }
    x.acabou = null; x.avisoPiso = null;
    salvar(); res.json({ ok: true, item: x });
  });
  app.post('/queima-full/remover', json, (req, res) => {
    if (!admin(req, res)) return;
    S.itens = S.itens.filter(y => y.id !== String(req.body?.id || '')); salvar(); res.json({ ok: true });
  });
  app.post('/queima-full/rodar', (req, res) => { if (!admin(req, res)) return; rodar().catch(() => {}); res.json({ ok: true }); });
  setTimeout(() => rodar().catch(() => {}), 150e3);
  setInterval(() => rodar().catch(() => {}), 30 * 60e3).unref?.();
}

module.exports = { rotas, responder };
