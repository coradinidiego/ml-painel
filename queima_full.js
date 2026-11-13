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
const salvar = () => { S.hist = S.hist.slice(0, 300); try { fs.mkdirSync(path.dirname(ARQ), { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(S)); } catch (e) {} };
const tg = msg => { try { require('./telegram').sendTelegram(msg); } catch (e) {} };
const log = (x, o) => { S.hist.unshift({ em: new Date().toISOString(), id: x.id, nome: x.nome, ...o }); };

let F;   // { ml, mlReq, uid }

async function margem(idx, it, preco) {
  try { const m = await cm.margemPreco(F.ml, idx, await F.uid(idx), it, preco, 0); return m && m.lucro != null ? m : null; } catch (e) { return null; }
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
      await F.mlReq(idx, 'post', url, { promotion_type: 'PRICE_DISCOUNT', deal_price: preco, start_date: horaBR(), finish_date: ativa.finish_date ? String(ativa.finish_date).slice(0, 19) : horaBR(Date.now() + 30 * 864e5) });
    } else await F.mlReq(idx, 'put', url, { promotion_id: ativa.id, promotion_type: ativa.type, deal_price: preco });
    return (ativa.name || 'Desconto próprio') + ' (editada)';
  }
  // 2º: campanha disponível com preço livre; 3º: desconto próprio novo
  const camp = L.find(p => p.status === 'candidate' && ['DEAL', 'SELLER_CAMPAIGN'].includes(p.type) && p.min_discounted_price && dentro(p));
  if (camp) { await F.mlReq(idx, 'post', url, { promotion_id: camp.id, promotion_type: camp.type, deal_price: preco }); return camp.name || camp.type; }
  await F.mlReq(idx, 'post', url, { promotion_type: 'PRICE_DISCOUNT', deal_price: preco, start_date: horaBR(), finish_date: horaBR(Date.now() + 30 * 864e5) });
  return 'Desconto próprio';
}

async function conferir(x) {
  const conta = CONTA[x.idx];
  const it = await F.ml(x.idx, '/items/' + x.id, { include_attributes: 'all' });
  if (!it?.id) throw new Error('anúncio não encontrado');
  it._sku = (it.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name || it.seller_custom_field || '';
  const v = x.var ? (it.variations || []).find(y => String(y.id) === String(x.var)) : null;
  const qtd = v ? +v.available_quantity || 0 : +it.available_quantity || 0;
  x.full = qtd; x.cheio = +(it.original_price || it.price) || null; x.conferidoEm = new Date().toISOString();
  // 1. Full acabou
  if (qtd <= 0) {
    if (!x.acabou) {
      x.acabou = new Date().toISOString(); x.situacao = 'Full acabou';
      log(x, { acao: 'Full acabou' });
      tg(`✅ Queima Full — ${conta}\n${x.nome} (${x.id}): o Full ACABOU.\nPode voltar o preço cheio${x.cheio ? ' (' + brl(x.cheio) + ')' : ''} / margem padrão.`);
    }
    return;
  }
  if (x.acabou) { x.acabou = null; }   // voltou a ter estoque (reposição): controla de novo
  if (!it.catalog_listing) { x.situacao = 'sem catálogo — só acompanha o estoque'; return; }
  // 2. catálogo
  const p = await F.ml(x.idx, '/items/' + x.id + '/price_to_win', { siteId: 'MLB', version: 'v2' });
  x.preco = +p.current_price || null; x.catalogo = p.status;
  if (p.status === 'winning') { x.situacao = 'ganhando a ' + brl(x.preco); x.avisoPiso = null; return; }
  const ptw = r2(+p.price_to_win || 0);
  if (!(ptw > 0) || !(ptw < x.preco - 0.005) || (p.reason || []).includes('no_improvement_price')) { x.situacao = 'perdendo — preço não resolve (ML não informa preço para ganhar)'; return; }
  const m = await margem(x.idx, it, ptw);
  const pode = x.piso > 0 ? ptw >= x.piso - 0.001 : (m && m.lucro >= 0);
  const lucroTxt = m ? ` (lucro ${brl(m.lucro)}/un, ${m.pct}%)` : ' (sem custo no ERP para calcular o lucro)';
  if (!pode) {
    x.situacao = `perdendo — para ganhar ${brl(ptw)}${lucroTxt}, abaixo do piso`;
    if (!x.avisoPiso || Math.abs(x.avisoPiso - ptw) / ptw > 0.02) {   // avisa uma vez por preço (de novo só se mudar mais de 2%)
      x.avisoPiso = ptw; log(x, { acao: 'abaixo do piso', ptw });
      tg(`⚠️ Queima Full — ${conta}\n${x.nome} (${x.id}) está PERDENDO o catálogo a ${brl(x.preco)}.\nPara ganhar: ${brl(ptw)}${lucroTxt}.\n${x.piso > 0 ? 'Piso aprovado: ' + brl(x.piso) : 'Sem piso aprovado: só baixo sozinho com lucro >= 0'} — não baixei. Full: ${qtd} un.`);
    }
    return;
  }
  // 3. baixa para ganhar
  const antes = x.preco, via = await aplicarPreco(x.idx, x.id, ptw);
  await delay(8000);
  let st = '?', agora = ptw;
  try { const q = await F.ml(x.idx, '/items/' + x.id + '/price_to_win', { siteId: 'MLB', version: 'v2' }); st = q.status; agora = +q.current_price || ptw; } catch (e) {}
  x.preco = agora; x.catalogo = st; x.avisoPiso = null;
  x.situacao = (st === 'winning' ? 'ganhando a ' : 'baixado para ') + brl(agora);
  log(x, { acao: 'baixou', de: antes, para: ptw, via, catalogo: st, lucro: m?.lucro ?? null });
  tg(`🔥 Queima Full — ${conta}\n${x.nome} (${x.id}): ${brl(antes)} → ${brl(ptw)}${lucroTxt} via ${via}.\nCatálogo: ${st === 'winning' ? 'GANHANDO' : 'ainda ' + st + ' (confiro de novo na próxima rodada)'}. Full: ${qtd} un.`);
}

let rodando = false;
async function rodar() {
  if (rodando || !F) return; rodando = true;
  try {
    for (const x of S.itens) {
      if (x.acabou && Date.now() - Date.parse(x.acabou) > 3 * 864e5) continue;   // acabou há mais de 3 dias: não consulta mais
      try { await conferir(x); x.erro = null; }
      catch (e) { const d = e.response?.data; x.erro = d?.message || d?.error || e.message; x.situacao = 'erro: ' + x.erro; log(x, { acao: 'erro', erro: x.erro }); }
      await delay(1200);
    }
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

module.exports = { rotas };
