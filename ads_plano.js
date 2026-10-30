/**
 * ADS do Mercado Livre — "o que fazer hoje" (todas as contas), olhando 7 e 15 dias.
 *
 * Base: métricas do Product Ads por anúncio (vendas ATRIBUÍDAS ao ADS) × lucro por unidade do painel
 * (preço − custo ERP − tarifa − frete − imposto − embalagem). Margem % = ACOS de equilíbrio.
 * ACOS alvo sugerido = metade da margem (metade do lucro fica com você, metade vira ADS).
 *
 * Recomendações:
 *   remover    gastou ≥ R$ 5 em 15 dias sem nenhuma venda pelo ADS · ou margem < 5% (não comporta ADS) · ou prejuízo nos 15 e nos 7 dias
 *   acos       campanha individual com ACOS alvo acima do que a margem aguenta → baixar o ACOS alvo (= subir o ROAS)
 *   orcamento  campanha lucrativa batendo no orçamento (gasto/dia nos 7 dias ≥ 80% do orçamento) → subir 50%
 *   criar      anúncio sem ADS, com estoque, margem ≥ 12% ≥ 3 vendas orgânicas em 15 dias e sem gasto de ADS no período (não volta quem foi tirado) → campanha individual
 *   manter     dando lucro com ACOS confortável (só contagem / lista)
 *   voltar     saiu do ADS (pelo painel ou direto no ML) e passou a quarentena (30 dias; 90 se saiu de novo pelo mesmo motivo)
 *              e o que causou a saída mudou → volta em modo teste (R$ 10/dia, ACOS alvo = 1/3 da margem)
 *                semvenda: vendas orgânicas 15d ≥ 3 e ≥ 1,5× as da saída · margem: margem ≥ 12%
 *                prejuizo: margem ≥ 12% e acima do ACOS que tinha · manual: margem ≥ 12% e ≥ 3 orgânicas
 *              Histórico de saídas/voltas: apuracao_cache/ads_saidas.json
 *
 * Roda sozinho todo dia às 7h (Brasília), grava em apuracao_cache/ads_plano.json e manda o resumo no Telegram.
 *  GET  /ml/ads-plano                    último plano (?recalcular=1 refaz)
 *  POST /ml/ads-plano/:idx/campanha/:id  { budget?, acos_target?, status? }   altera uma campanha
 *  POST /ml/ads-plano/:idx/criar         { item, budget, acos_target, nome? } cria campanha individual e coloca o anúncio nela
 *  POST /ml/ads-plano/:idx/remover       { item }                              tira o anúncio do ADS
 */
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');
const A = require('./ads_ml');

const CONTAS = [{ idx: 0, nome: 'Zagodini' }, { idx: 1, nome: 'Com Amor de Mãe' }, { idx: 2, nome: 'Lufe' }];
const ARQ = path.join(DATA, 'apuracao_cache', 'ads_plano.json');
const ler = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const gravar = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch (e) {} };
const delay = ms => new Promise(r => setTimeout(r, ms));
const r2 = v => Math.round((+v || 0) * 100) / 100;
const hojeSP = () => new Date(Date.now() - 3 * 3600e3);
let P = ler(ARQ, null), rodando = false;

const ORC_PADRAO = 20;
const ORC_TESTE = 10;                                      // orçamento da volta em modo teste
const ARQ_SAIDAS = path.join(DATA, 'apuracao_cache', 'ads_saidas.json');
let SAIDAS = ler(ARQ_SAIDAS, {});                          // { "idx|MLB": [{ data, tipo: 'saida'|'volta', motivo, razao, margem, organicas, acos, custo }] }
// saída feita hoje (30/10/2026) antes deste controle existir: entra na quarentena
if (!SAIDAS['2|MLB47278842']) { SAIDAS['2|MLB47278842'] = [{ data: '2026-10-30', tipo: 'saida', razao: 'manual', motivo: 'tirado pela tarefa do dia (antes do controle de quarentena)' }]; gravar(ARQ_SAIDAS, SAIDAS); }
const diaSP = () => hojeSP().toISOString().slice(0, 10);
const diasDesde = d => Math.floor((Date.parse(diaSP()) - Date.parse(d)) / 864e5);
const razaoDe = (motivo, x) => /sem nenhuma venda/.test(motivo || '') ? 'semvenda' : /margem de .* não comporta/.test(motivo || '') ? 'margem' : /prejuízo/.test(motivo || '') ? 'prejuizo'
  : x ? (!x.unidadesAds ? 'semvenda' : (x.margem?.pct ?? 99) < 5 ? 'margem' : (x.lucroAds ?? 0) < 0 ? 'prejuizo' : 'manual') : 'manual';
function registrarSaida(idx, item, motivo, x) {
  const L = SAIDAS[idx + '|' + item] ||= [], u = L[L.length - 1];
  if (u && u.tipo === 'saida' && diasDesde(u.data) < 15) return;   // já registrada
  L.push({ data: diaSP(), tipo: 'saida', razao: razaoDe(motivo, x), motivo: motivo || 'saiu do ADS', margem: x?.margem?.pct ?? null, organicas: x?.organicas ?? null, acos: x?.acos ?? null, custo: x?.custo ?? null });
  gravar(ARQ_SAIDAS, SAIDAS);
}
function registrarVolta(idx, item) { const L = SAIDAS[idx + '|' + item]; if (L) { L.push({ data: diaSP(), tipo: 'volta' }); gravar(ARQ_SAIDAS, SAIDAS); } }
const NOME_RAZAO = { semvenda: 'gastou sem vender', margem: 'margem baixa', prejuizo: 'prejuízo', manual: 'tirado manualmente' };
/** Situação de quem já saiu do ADS: null (nunca saiu / voltou), { quarentena } ou { pode, motivo } */
function avaliarVolta(idx, x) {
  const L = SAIDAS[idx + '|' + x.id]; if (!L?.length) return null;
  const u = L[L.length - 1]; if (u.tipo !== 'saida') return null;
  const mesmas = L.filter(e => e.tipo === 'saida' && e.razao === u.razao).length;
  const prazo = mesmas >= 2 ? 90 : 30, passou = diasDesde(u.data);
  if (passou < prazo) return { quarentena: true, faltam: prazo - passou, prazo, saida: u };
  const m = x.margem?.pct, org = x.organicas || 0;
  let ok = false, mudou = '';
  if (m == null || (x.estoque ?? 1) <= 0) ok = false;
  else if (u.razao === 'semvenda') { ok = m >= 12 && org >= 3 && org >= 1.5 * (u.organicas || 0); mudou = `vendas orgânicas ${u.organicas ?? '?'} → ${org} em 15 dias`; }
  else if (u.razao === 'margem') { ok = m >= 12; mudou = `margem ${u.margem ?? '?'}% → ${m}%`; }
  else if (u.razao === 'prejuizo') { ok = m >= 12 && m > (u.acos || 0); mudou = `margem ${m}% agora comporta o ROAS de ${roas(u.acos)} que tinha`; }
  else { ok = m >= 12 && org >= 3; mudou = `margem ${m}% · ${org} venda(s) orgânica(s) em 15 dias`; }
  return ok ? { pode: true, saida: u, motivo: `saiu em ${u.data.split('-').reverse().join('/')} (${NOME_RAZAO[u.razao]})${mesmas >= 2 ? ' pela ' + mesmas + 'ª vez' : ''} · ${mudou} → testar de novo` } : { aguardando: true, saida: u };
}                                     // orçamento diário sugerido para campanha nova
const roas = a => a > 0 ? String(Math.round(1000 / a) / 10).replace('.', ',') + 'x' : '—';   // ACOS % → ROAS (100 ÷ ACOS)
const ACOS_MIN = 100 / 35;                                 // ROAS objetivo máximo aceito pelo ML: 35x
const acosAlvo = m => Math.max(ACOS_MIN, Math.min(30, Math.floor(m / 2)));   // metade da margem → ROAS entre 3,3x e 35x

async function pronto(idx, dias) {
  let e = A.estado(idx, dias);
  if (!e || e.status !== 'pronto' || Date.now() - Date.parse(e.em || 0) > 3 * 3600e3) e = await A.carregar(idx, dias);
  if (e.status !== 'pronto') throw new Error(e.erro || 'ADS não carregou');
  return e;
}

function planoConta(c, Q, S) {   // Q = 15 dias, S = 7 dias
  const s7 = Object.fromEntries(S.itens.map(x => [x.id, x]));
  const camp15 = Object.fromEntries(Q.campanhas.map(k => [String(k.id), k])), camp7 = Object.fromEntries(S.campanhas.map(k => [String(k.id), k]));
  const naCamp = {};                       // campanha → anúncios ativos/pausados nela
  for (const x of Q.itens) if (x.campanha && ['active', 'paused'].includes(x.status)) (naCamp[x.campanha.id] ||= []).push(x);
  const recs = [], ok = [], quarentena = [];
  const base = x => ({ conta: c.nome, idx: c.idx, item: x.id, titulo: x.titulo, sku: x.sku, thumb: x.thumb, link: x.link, preco: x.preco, margem: x.margem?.pct ?? null, lucroUn: x.margem?.lucro ?? null,
    campanha: x.campanha ? { id: x.campanha.id, nome: camp15[String(x.campanha.id)]?.nome || x.campanha.nome, orcamento: camp15[String(x.campanha.id)]?.orcamento ?? null, acosAlvo: camp15[String(x.campanha.id)]?.acosAlvo ?? null, individual: (naCamp[x.campanha.id] || []).length <= 1 } : null,
    q: { custo: x.custo, un: x.unidadesAds, vendas: x.vendasAds, acos: x.acos, lucro: x.lucroAds, organicas: x.organicas },
    s: s7[x.id] ? { custo: s7[x.id].custo, un: s7[x.id].unidadesAds, vendas: s7[x.id].vendasAds, acos: s7[x.id].acos, lucro: s7[x.id].lucroAds } : null });
  for (const x of Q.itens) {
    const m = x.margem?.pct, ativo = x.campanha && x.status === 'active', b = base(x), y = b.s || {};
    if (ativo) {
      if (x.custo >= 5 && !x.unidadesAds) { recs.push({ ...b, tipo: 'remover', peso: x.custo, motivo: `R$ ${x.custo.toFixed(2)} em 15 dias sem nenhuma venda pelo ADS` }); continue; }
      if (m != null && m < 5 && x.custo >= 3 && (x.lucroAds ?? 0) <= 0) { recs.push({ ...b, tipo: 'remover', peso: x.custo, motivo: `margem de ${m}% não comporta ADS (R$ ${x.custo.toFixed(2)} gastos em 15 dias)` }); continue; }
      // ACOS bem abaixo da margem mas "prejuízo": o preço que vendeu não bate com o de hoje (variação/kit) — não recomenda no escuro
      const incoerente = x.acos != null && m != null && x.acos < m * 0.7;
      if (x.lucroAds != null && x.lucroAds < -5 && (y.lucro ?? 0) <= 0 && !incoerente) {
        const alvo = m != null ? acosAlvo(m) : null;
        if (b.campanha?.individual && alvo && m >= 8 && (b.campanha.acosAlvo == null || b.campanha.acosAlvo > alvo)) recs.push({ ...b, tipo: 'acos', peso: -x.lucroAds, sugestao: { acos_target: alvo }, motivo: `prejuízo de R$ ${(-x.lucroAds).toFixed(2)} em 15 dias (ROAS ${roas(x.acos)} · precisa de ${roas(m)} só para empatar com a margem de ${m}%)` });
        else recs.push({ ...b, tipo: 'remover', peso: -x.lucroAds, motivo: `prejuízo de R$ ${(-x.lucroAds).toFixed(2)} em 15 dias (ROAS ${roas(x.acos)} · empate em ${roas(m)})` + (b.campanha && !b.campanha.individual ? ' — está numa campanha com outros anúncios, não dá para ajustar só ele' : '') });
        continue;
      }
      if (b.campanha?.individual && m != null && b.campanha.acosAlvo != null && b.campanha.acosAlvo > m && x.custo >= 1) {
        recs.push({ ...b, tipo: 'acos', peso: x.custo, sugestao: { acos_target: acosAlvo(m) }, motivo: `ROAS objetivo da campanha (${roas(b.campanha.acosAlvo)}) está abaixo do mínimo para empatar com a margem de ${m}% (${roas(m)})` }); continue;
      }
      if (x.lucroAds > 0) ok.push({ ...b, tipo: 'manter', peso: x.lucroAds });
    } else if (x.status !== 'hold' && (!x.campanha || x.status !== 'active')) {
      // gastou nos 15 dias e não está mais ativo = saiu do ADS (pelo painel ou direto no ML): registra para a quarentena
      if (x.custo > 0) registrarSaida(c.idx, x.id, null, x);
      const v = avaliarVolta(c.idx, x);
      if (v?.quarentena) { quarentena.push({ ...b, tipo: 'quarentena', faltam: v.faltam, prazo: v.prazo, saida: v.saida }); continue; }
      if (v?.pode) { recs.push({ ...b, tipo: 'voltar', peso: (x.organicas || 0) * (x.margem?.lucro || 0), sugestao: { budget: ORC_TESTE, acos_target: Math.max(ACOS_MIN, Math.floor(m / 3)) }, motivo: v.motivo, saida: v.saida }); continue; }
      if (v || x.custo > 0) continue;   // saiu e ainda não mudou nada · ou acabou de sair
      if (!((!x.campanha || x.status === 'idle') && (x.estoque ?? 1) > 0 && m != null && m >= 12 && (x.organicas || 0) >= 3)) continue;
      // (custo > 0 nos 15 dias = esteve no ADS e foi tirado: não sugere voltar)
      recs.push({ ...b, tipo: 'criar', peso: (x.organicas || 0) * (x.margem?.lucro || 0) + (x.recomendado ? 5 : 0), sugestao: { budget: ORC_PADRAO, acos_target: acosAlvo(m) },
        motivo: `sem ADS · ${x.organicas || 0} venda(s) orgânica(s) em 15 dias${x.recomendado ? ' · recomendado pelo ML' : ''} · margem ${m}%` });
    }
  }
  // campanhas lucrativas batendo no orçamento
  for (const k of Q.campanhas) {
    const k7 = camp7[String(k.id)]; if (k.status !== 'active' || !k.orcamento || !k7) continue;
    const gDia = k7.custo / 7, its = naCamp[k.id] || [], luc = its.reduce((a, x) => a + (s7[x.id]?.lucroAds || 0), 0);
    if (gDia >= 0.8 * k.orcamento && luc > 0) {
      const novo = Math.ceil(k.orcamento * 1.5 / 5) * 5;
      recs.push({ conta: c.nome, idx: c.idx, tipo: 'orcamento', peso: luc, campanha: { id: k.id, nome: k.nome, orcamento: k.orcamento, acosAlvo: k.acosAlvo, individual: its.length <= 1 },
        titulo: k.nome, item: its.length === 1 ? its[0].id : null, thumb: its[0]?.thumb, link: its.length === 1 ? its[0].link : null,
        s: { custo: k7.custo, vendas: k7.vendas, acos: k7.acos, lucro: r2(luc) }, sugestao: { budget: novo },
        motivo: `gastando R$ ${gDia.toFixed(2)}/dia de R$ ${k.orcamento} (7 dias) com lucro de R$ ${luc.toFixed(2)} depois do ADS` });
    }
  }
  const ord = { remover: 0, acos: 1, orcamento: 2, criar: 3, voltar: 4 };
  recs.sort((a, b) => ord[a.tipo] - ord[b.tipo] || b.peso - a.peso);
  const soma = (L, f) => r2(L.reduce((a, x) => a + (f(x) || 0), 0));
  const atv = Q.itens.filter(x => x.campanha && x.status === 'active');
  return {
    conta: c.nome, idx: c.idx, recs, manter: ok.sort((a, b) => b.peso - a.peso).slice(0, 30), quarentena: quarentena.sort((a, b) => a.faltam - b.faltam),
    resumo: { custo15: soma(Q.itens, x => x.custo), vendas15: soma(Q.itens, x => x.vendasAds), lucro15: soma(Q.itens.filter(x => x.lucroAds != null), x => x.lucroAds),
      custo7: soma(S.itens, x => x.custo), vendas7: soma(S.itens, x => x.vendasAds), lucro7: soma(S.itens.filter(x => x.lucroAds != null), x => x.lucroAds),
      anunciosAtivos: atv.length, campanhas: Q.campanhas.filter(k => k.status === 'active').length,
      desperdicio15: soma(recs.filter(r => r.tipo === 'remover'), r => r.q?.custo) },
  };
}

async function calcular(motivo) {
  if (rodando) return P; rodando = true;
  const out = { em: new Date().toISOString(), motivo, contas: [] };
  try {
    for (const c of CONTAS) {
      try { const Q = await pronto(c.idx, 15), S = await pronto(c.idx, 7); out.contas.push(planoConta(c, Q, S)); }
      catch (e) { out.contas.push({ conta: c.nome, idx: c.idx, erro: e.message, recs: [], manter: [] }); }
    }
    P = out; gravar(ARQ, P);
  } finally { rodando = false; }
  return P;
}

function textoTelegram(p) {
  const n = (L, t) => L.filter(r => r.tipo === t).length, brl = v => 'R$ ' + Math.round(v).toLocaleString('pt-BR');
  const linhas = ['📣 <b>ADS ML — o que fazer hoje</b>'];
  for (const c of p.contas) {
    if (c.erro) { linhas.push(`\n<b>${c.conta}</b>: erro (${c.erro})`); continue; }
    const R = c.resumo, L = c.recs;
    linhas.push(`\n<b>${c.conta}</b> · 7 dias: ADS ${brl(R.custo7)} → vendas ${brl(R.vendas7)} · lucro depois do ADS ${brl(R.lucro7)}`);
    const t = [['⛔ tirar do ADS', 'remover'], ['🎯 subir ROAS objetivo', 'acos'], ['💰 subir orçamento', 'orcamento'], ['➕ criar campanha', 'criar'], ['🔁 testar volta ao ADS', 'voltar']].filter(([, k]) => n(L, k)).map(([r, k]) => `${r}: ${n(L, k)}`);
    linhas.push(t.length ? t.join(' · ') : '✅ nada a fazer');
    for (const r of L.filter(r => r.tipo === 'remover').slice(0, 3)) linhas.push(`   • ${(r.titulo || r.item || '').slice(0, 40)} — ${r.motivo}`);
  }
  linhas.push('\nDetalhes e botões: painel → ADS → "O que fazer hoje"');
  return linhas.join('\n');
}

function rotas(app) {
  const admin = (req, res) => { if (require('./auth').ativo() && !req.usuario?.admin) { res.status(403).json({ erro: 'só admin' }); return false; } return true; };
  const J = require('express').json();
  app.get('/ml/ads-plano', async (req, res) => {
    if (req.query.recalcular && !rodando) calcular('manual').catch(() => {});
    res.json({ rodando, plano: P });
  });
  const tira = (idx, item) => { if (!P) return; for (const c of P.contas) if (c.idx === idx) c.recs = c.recs.filter(r => r.item !== item || r.tipo === 'orcamento'); gravar(ARQ, P); };
  const erroML = e => { const d = e.response?.data; return (e.response?.status ? e.response.status + ' ' : '') + (d?.message || d?.error || e.message) + (d?.cause ? ' · ' + JSON.stringify(d.cause).slice(0, 200) : ''); };
  app.post('/ml/ads-plano/:idx/campanha/:id', J, async (req, res) => {
    if (!admin(req, res)) return;
    const idx = +req.params.idx;
    try {
      const r = await A.alterarCampanha(idx, req.params.id, req.body || {});
      if (P) for (const c of P.contas) if (c.idx === idx) c.recs = c.recs.filter(x => String(x.campanha?.id) !== String(req.params.id) || !['acos', 'orcamento'].includes(x.tipo));
      gravar(ARQ, P); res.json({ ok: true, resposta: r });
    } catch (e) { res.status(400).json({ erro: erroML(e) }); }
  });
  app.post('/ml/ads-plano/:idx/criar', J, async (req, res) => {
    if (!admin(req, res)) return;
    const idx = +req.params.idx, { item, budget, acos_target, nome } = req.body || {};
    if (!/^MLB\d+$/.test(item || '') || !(budget > 0) || !(acos_target > 0)) return res.status(400).json({ erro: 'parâmetros inválidos' });
    try { const r = await A.criarCampanha(idx, item, { nome: nome || item, budget, acos_target }); registrarVolta(idx, item); tira(idx, item); res.json({ ok: true, ...r }); }
    catch (e) { res.status(400).json({ erro: erroML(e) }); }
  });
  app.post('/ml/ads-plano/:idx/remover', J, async (req, res) => {
    if (!admin(req, res)) return;
    const idx = +req.params.idx, item = String(req.body?.item || '');
    if (!/^MLB\d+$/.test(item)) return res.status(400).json({ erro: 'item inválido' });
    const rec = P?.contas.find(c => c.idx === idx)?.recs.find(r => r.item === item && r.tipo === 'remover');
    const marcar = () => { const L = SAIDAS[idx + '|' + item] ||= []; L.push({ data: diaSP(), tipo: 'saida', razao: razaoDe(rec?.motivo), motivo: rec?.motivo || 'tirado pelo painel', margem: rec?.margem ?? null, organicas: rec?.q?.organicas ?? null, acos: rec?.q?.acos ?? null, custo: rec?.q?.custo ?? null }); gravar(ARQ_SAIDAS, SAIDAS); };
    try { const r = await A.moverAnuncio(idx, item, { campaign_id: 0 }); marcar(); tira(idx, item); res.json({ ok: true, resposta: r }); }
    catch (e) {
      try { const r = await A.moverAnuncio(idx, item, { status: 'paused' }); marcar(); tira(idx, item); res.json({ ok: true, pausado: true, resposta: r }); }
      catch (e2) { res.status(400).json({ erro: erroML(e2) }); }
    }
  });
  // todo dia às 7h (Brasília): recalcula e manda o resumo
  setInterval(() => {
    const h = hojeSP(), hoje = h.toISOString().slice(0, 10);
    if (h.getUTCHours() !== 7 || (P?.em && new Date(Date.parse(P.em) - 3 * 3600e3).toISOString().slice(0, 10) === hoje && P.motivo === 'diario')) return;
    calcular('diario').then(p => { try { require('./telegram').sendTelegram(textoTelegram(p)); } catch (e) {} }).catch(() => {});
  }, 10 * 60e3).unref?.();
}
module.exports = { rotas, calcular };
