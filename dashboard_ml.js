/**
 * Dashboard por conta do Mercado Livre (modelo: tela "Dashboard" do Mercado Turbo). Só leitura.
 *
 *  GET  /dashboard/:idx            tudo já calculado (cache em DATA/dashboard), cada bloco com {erro} próprio
 *  POST /dashboard/:idx/atualizar  recalcula agora em segundo plano (rápido + dias fechados + apuração)
 *  GET  /dashboard/:idx/status     andamento do cálculo
 *
 * Fontes:
 *  - Pedidos: /orders/search por dia (agregados diários guardados; dias fechados não são buscados de novo,
 *    só revisados 1x por dia nos últimos 35 dias por causa de cancelamentos que chegam depois).
 *  - Para fazer agora: o mesmo retrato do ML que a TV usa (tv.js / ml_envios.js) + reclamações e "a combinar".
 *  - Margem, custos, frete do vendedor, DRE: apuração do painel (apuracao_mkt.resultado) + despesas.js.
 *  - Visitas: /users/{uid}/items_visits (date_to inclusivo) e /items_visits/time_window.
 *  - Anúncios ativos por dia: snapshot gravado aqui (não existe histórico na API).
 */
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');

const DIR = path.join(DATA, 'dashboard');
fs.mkdirSync(DIR, { recursive: true });
const CONTAS = [
  { idx: 0, nome: 'Comercial Zagodini', tv: 'zagodini', envios: 'Zagodini', emp: 'zagodini', empNome: 'Zagodini' },
  { idx: 1, nome: 'Com Amor de Mãe', tv: 'mae', envios: 'Mae', emp: 'mae', empNome: 'Com Amor de Mãe' },
  { idx: 2, nome: 'Lufe Casa & Decoração', tv: 'lufe', envios: 'Lufe', emp: 'lufe', empNome: 'Lufe' },
];
// limites de referência para manter a reputação verde (ML Brasil, últimos 60 dias)
const LIMITES = { claims: 0.01, delayed_handling_time: 0.06, cancellations: 0.005 };
const RAPIDO_MIN = 20;          // "hoje" e "para fazer agora"
const delay = ms => new Promise(r => setTimeout(r, ms));
const r2 = v => Math.round((v || 0) * 100) / 100;
const lerJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const gravarJson = (f, o) => { try { fs.writeFileSync(f + '.tmp', JSON.stringify(o)); fs.renameSync(f + '.tmp', f); } catch (e) { console.warn('[dashboard] gravar', f, e.message); } };

// ─── Datas (Brasília, UTC−3 fixo) ────────────────────────────────────────────
const sp = (t = Date.now()) => new Date(t - 3 * 3600e3);
const ymd = d => d.toISOString().slice(0, 10);
const hojeSP = () => ymd(sp());
const somaDias = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return ymd(x); };
const diasEntre = (a, b) => { const out = []; for (let d = a; d <= b; d = somaDias(d, 1)) out.push(d); return out; };
const mesDe = d => d.slice(0, 7);
const mesSoma = (m, n) => { const [a, b] = m.split('-').map(Number), x = new Date(Date.UTC(a, b - 1 + n, 1)); return x.toISOString().slice(0, 7); };
const ultimoDia = m => { const [a, b] = m.split('-').map(Number); return new Date(Date.UTC(a, b, 0)).getUTCDate(); };
const fimMes = m => m + '-' + String(ultimoDia(m)).padStart(2, '0');
const diaSP = iso => ymd(sp(Date.parse(iso)));
const minutoSP = iso => { const d = sp(Date.parse(iso)); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const agoraMin = () => { const d = sp(); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

// ─── Arquivos ───────────────────────────────────────────────────────────────
const arqDias = i => path.join(DIR, `dias_${i}.json`);       // { 'AAAA-MM-DD': agregado do dia }
const arqEnv = i => path.join(DIR, `envios_${i}.json`);      // { shipId: logistic_type }
const arqPartes = i => path.join(DIR, `partes_${i}.json`);   // blocos calculados (conta, fazer, visitas, perguntas, apu...)
const _mem = {};
const dias = i => (_mem['d' + i] ||= lerJson(arqDias(i), {}));
const envios = i => (_mem['e' + i] ||= lerJson(arqEnv(i), {}));
const partes = i => (_mem['p' + i] ||= lerJson(arqPartes(i), {}));
const salvar = i => { gravarJson(arqDias(i), dias(i)); gravarJson(arqEnv(i), envios(i)); gravarJson(arqPartes(i), partes(i)); };

let F = null;   // { ml }
const _uid = {};
async function get(idx, p, params) {
  for (let t = 0; ; t++) {
    try { return await F.ml(idx, p, params); }
    catch (e) { const st = e.response?.status; if (t < 6 && (st === 429 || st >= 500 || !st)) { await delay(4000 * (t + 1)); continue; } throw e; }
  }
}
const uid = async idx => (_uid[idx] ||= (await get(idx, '/users/me')).id);
async function paralelo(lista, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < lista.length) { const x = lista[i++]; await fn(x); } })); }

const ST = {};   // status por conta { rodando, fase, erro }
const fase = (i, f) => { ST[i] = { ...(ST[i] || {}), fase: f }; };

// ─── Pedidos de um dia → agregado ──────────────────────────────────────────
async function pedidosDia(idx, dia) {
  const seller = await uid(idx), vistos = new Map();
  let total = null;
  // a paginação por offset do ML pode repetir/pular pedidos: dedup pelo id e, se faltar, passa de novo na ordem inversa
  for (const ordem of ['date_asc', 'date_desc']) {
    if (ordem === 'date_desc' && (total == null || vistos.size >= total)) break;
    for (let off = 0; off < 5000; off += 50) {
      const r = await get(idx, '/orders/search', { seller, 'order.date_created.from': dia + 'T00:00:00.000-03:00', 'order.date_created.to': dia + 'T23:59:59.999-03:00', limit: 50, offset: off, sort: ordem });
      if (r.paging?.total != null) total = r.paging.total;
      for (const o of r.results || []) vistos.set(o.id, o);
      if ((r.results || []).length < 50) break;
    }
  }
  return [...vistos.values()];
}
function agregar(pedidos, fechado) {
  const D = { n: 0, fat: 0, fatF: 0, freteC: 0, canc: 0, cancV: 0, tar: 0, h: Array.from({ length: 24 }, () => [0, 0]), m: [], it: {}, sh: [], semEnvio: 0, v: 2, fechado, calc: hojeSP(), em: new Date().toISOString() };
  // como o ML (e o Turbo): 1 venda = 1 carrinho (pack_id); um carrinho pode ter vários pedidos
  const packs = new Set(), packsC = new Set();
  for (const o of pedidos) {
    if (o.status === 'invalid') continue;
    const pk = String(o.pack_id || o.id);
    const tot = +o.total_amount || 0, itens = o.order_items || [];
    const item = x => { const k = x.item?.id || '?'; return (D.it[k] ||= { t: (x.item?.title || '').slice(0, 90), s: x.item?.seller_sku || x.item?.seller_custom_field || '', q: 0, v: 0, cq: 0, cv: 0 }); };
    if (o.status === 'cancelled') {
      if (!packsC.has(pk)) { packsC.add(pk); D.canc++; } D.cancV += tot;
      for (const x of itens) { const I = item(x); I.cq += +x.quantity || 1; I.cv += (+x.unit_price || 0) * (+x.quantity || 1); }
      continue;
    }
    const fc = Math.max(0, (+o.paid_amount || 0) - tot);
    const novo = !packs.has(pk); if (novo) { packs.add(pk); D.n++; } D.fat += tot; D.freteC += fc; D.fatF += tot + fc;
    for (const x of itens) { const q = +x.quantity || 1, I = item(x); I.q += q; I.v += (+x.unit_price || 0) * q; D.tar += (+x.sale_fee || 0) * q; }
    const mi = minutoSP(o.date_created); if (novo) D.h[Math.floor(mi / 60)][0]++; D.h[Math.floor(mi / 60)][1] += tot; D.m.push([mi, r2(tot), novo ? 1 : 0]);
    if (o.shipping?.id) D.sh.push(o.shipping.id); else D.semEnvio++;
  }
  for (const k of ['fat', 'fatF', 'freteC', 'cancV', 'tar']) D[k] = r2(D[k]);
  for (const h of D.h) h[1] = r2(h[1]);
  for (const I of Object.values(D.it)) { I.v = r2(I.v); I.cv = r2(I.cv); }
  return D;
}
async function calcDia(idx, dia, fechado) {
  const D = agregar(await pedidosDia(idx, dia), fechado);
  const ant = dias(idx)[dia]; if (ant?.log && fechado) { D.log = ant.log; D.freteV = ant.freteV; }
  dias(idx)[dia] = D;
  return D;
}

// ─── Como entregou: logística por envio (cache permanente) ───────────────────
async function logisticas(idx, listaDias) {
  const E = envios(idx), C = CONTAS[idx], tvCache = lerJson(path.join(DATA, 'apuracao_cache', 'tv_ml_envios.json'), {});
  const ids = [...new Set(listaDias.flatMap(d => dias(idx)[d]?.sh || []))].filter(id => !E[id]);
  for (const id of ids) { const t = tvCache[C.envios + ':' + id]; if (t?.logistica) E[id] = t.logistica; }
  const faltam = ids.filter(id => !E[id]);
  let k = 0;
  await paralelo(faltam, 3, async id => {
    try { const s = await get(idx, '/shipments/' + id); E[id] = s.logistic_type || s.logistic?.type || s.mode || 'outros'; }
    catch (e) { if (e.response?.status === 404) E[id] = 'outros'; }
    if (++k % 100 === 0) { fase(idx, `logística dos envios ${k}/${faltam.length}`); gravarJson(arqEnv(idx), E); }
  });
  for (const d of listaDias) {
    const D = dias(idx)[d]; if (!D) continue;
    const log = { fulfillment: 0, cross_docking: 0, self_service: 0, outros: 0, semInfo: 0 };
    for (const id of D.sh || []) { const t = E[id]; if (!t) log.semInfo++; else if (log[t] != null && t !== 'semInfo') log[t]++; else if (t === 'xd_drop_off' || t === 'drop_off') log.cross_docking++; else log.outros++; }
    log.outros += D.semEnvio || 0;
    D.log = log;
  }
}

// ─── Trabalho rápido: conta, para fazer agora, hoje ─────────────────────────
async function rapido(idx) {
  const P = partes(idx), C = CONTAS[idx], hoje = hojeSP(), seller = await uid(idx);
  // conta: reputação e anúncios
  fase(idx, 'reputação e anúncios');
  try {
    const u = await get(idx, '/users/' + seller), rep = u.seller_reputation || {};
    const tot = async extra => (await get(idx, `/users/${seller}/items/search`, { status: 'active', limit: 1, ...extra })).paging?.total ?? null;
    const ativos = await tot({}), gp = await tot({ listing_type_id: 'gold_pro' }), gs = await tot({ listing_type_id: 'gold_special' });
    P.conta = { em: new Date().toISOString(), nick: u.nickname, nivel: rep.level_id || null, medalha: rep.power_seller_status || null, transacoes: rep.transactions || null,
      metricas: Object.fromEntries(['claims', 'delayed_handling_time', 'cancellations'].map(k => [k, { ...(rep.metrics?.[k] || {}), limite: LIMITES[k] }])),
      vendas60: rep.metrics?.sales || null, anuncios: { ativos, premium: gp, classico: gs } };
    P.snap ||= {}; P.snap[hoje] = { at: ativos, gp, gs };
  } catch (e) { P.conta = { ...(P.conta || {}), erro: msgErro(e) }; }
  // para fazer agora
  fase(idx, 'para fazer agora');
  try {
    let ml = require('./tv').ultimoMl(C.tv);
    if (!ml || Date.now() - ml.em > RAPIDO_MIN * 60e3) ml = { linhas: await require('./ml_envios').coletar(C.envios, require('./tv').prazo), em: Date.now() };
    const L = ml.linhas || [], pend = ['emitirNF', 'aEmpacotar', 'empacotado'];
    const f = { em: new Date(ml.em).toISOString(),
      etiquetas: L.filter(l => l.tipo === 'aEmpacotar' && !l.flex).length,
      emitirNF: L.filter(l => l.tipo === 'emitirNF' && !l.flex).length,
      aColetar: L.filter(l => l.tipo === 'empacotado' && !l.flex).length,
      flex: L.filter(l => l.flex && pend.includes(l.tipo)).length,
      flexAtrasado: L.filter(l => l.flex && pend.includes(l.tipo) && l.prazo === 'atrasado').length,
      despachadas: L.filter(l => l.tipo === 'enviado').length,
      atrasados: L.filter(l => pend.includes(l.tipo) && l.prazo === 'atrasado').length };
    // entregas a combinar: pedido pago, ainda não entregue, sem envio do Mercado Envios
    const desde = ymd(sp(Date.now() - 30 * 864e5));
    let comb = 0;
    for (let off = 0; off < 3000; off += 50) {
      const r = await get(idx, '/orders/search', { seller, 'order.status': 'paid', tags: 'not_delivered', 'order.date_created.from': desde + 'T00:00:00.000-03:00', limit: 50, offset: off });
      comb += (r.results || []).filter(o => !o.shipping?.id).length;
      if ((r.results || []).length < 50) break;
    }
    f.combinar = comb;
    const cl = { total: 0, mediacoes: 0, devolucoes: 0, disputa: 0 };
    for (let off = 0; off < 500; off += 50) {
      const s = await get(idx, '/post-purchase/v1/claims/search', { status: 'opened', limit: 50, offset: off });
      for (const c of s.data || []) { cl.total++; if (c.type === 'returns') cl.devolucoes++; else cl.mediacoes++; if (c.stage === 'dispute') cl.disputa++; }
      if ((s.data || []).length < 50) break;
    }
    f.reclamacoes = cl;
    P.fazer = f;
  } catch (e) { P.fazer = { ...(P.fazer || {}), erro: msgErro(e) }; }
  // perguntas sem resposta
  try { const q = await get(idx, '/questions/search', { seller_id: seller, status: 'UNANSWERED', limit: 1 }); P.semResposta = { n: q.total ?? q.paging?.total ?? 0, em: new Date().toISOString() }; }
  catch (e) { P.semResposta = { erro: msgErro(e) }; }
  // hoje (e ontem, se ainda não estiver fechado)
  fase(idx, 'vendas de hoje');
  try {
    const ontem = somaDias(hoje, -1);
    if (!dias(idx)[ontem]?.fechado) await calcDia(idx, ontem, true);
    await calcDia(idx, hoje, false);
    try { await logisticas(idx, [hoje]); } catch (e) {}
    P.hojeErro = null;
  } catch (e) { P.hojeErro = msgErro(e); }
  P.rapidoEm = new Date().toISOString();
}

// ─── Trabalho diário: dias fechados, visitas, perguntas ──────────────────────
async function diario(idx) {
  const P = partes(idx), D = dias(idx), hoje = hojeSP(), ontem = somaDias(hoje, -1), seller = await uid(idx);
  const ini = mesSoma(mesDe(hoje), -3) + '-01';
  const lista = diasEntre(ini, ontem);
  let k = 0;
  for (const d of lista) {
    k++;
    const x = D[d], idade = Math.round((Date.parse(hoje) - Date.parse(d)) / 864e5);
    const precisa = !x || !x.fechado || x.v !== 2 || (idade <= 35 && x.calc !== hoje) || (idade > 35 && x.calc < somaDias(d, 35));
    if (!precisa) continue;
    fase(idx, `pedidos ${d} (${k}/${lista.length})`);
    try { await calcDia(idx, d, true); } catch (e) { P.diasErro = msgErro(e) + ' em ' + d; if (e.response?.status === 401) throw e; }
    if (k % 10 === 0) gravarJson(arqDias(idx), D);
  }
  for (const d of Object.keys(D)) if (d < somaDias(ini, -40)) delete D[d];
  // logística do mês corrente (como entregou)
  fase(idx, 'logística dos envios do mês');
  try { await logisticas(idx, diasEntre(mesDe(hoje) + '-01', hoje).filter(d => D[d])); P.logErro = null; } catch (e) { P.logErro = msgErro(e); }
  // visitas
  fase(idx, 'visitas');
  try {
    const V = P.visitas ||= { meses: {} };
    const vis = async (a, b) => (await get(idx, `/users/${seller}/items_visits`, { date_from: a, date_to: b })).total_visits ?? null;
    const mAt = mesDe(hoje), dd = Number(ontem.slice(8, 10));
    for (let n = 1; n <= 3; n++) { const m = mesSoma(mAt, -n); if (V.meses[m]?.fechado == null || !V.meses[m].fechado) V.meses[m] = { v: await vis(m + '-01', fimMes(m)), fechado: true }; }
    if (mesDe(ontem) === mAt) {
      V.mesAteOntem = await vis(mAt + '-01', ontem);
      const mA = mesSoma(mAt, -1), diaA = Math.min(dd, ultimoDia(mA));
      V.mesAntMesmoPeriodo = await vis(mA + '-01', mA + '-' + String(diaA).padStart(2, '0'));
    } else { V.mesAteOntem = null; V.mesAntMesmoPeriodo = null; }
    // diário dos últimos 60 dias (a API agrupa por dia UTC)
    try { const tw = await get(idx, `/users/${seller}/items_visits/time_window`, { last: 60, unit: 'day' });
      V.dia = Object.fromEntries((tw.results || []).map(r => [String(r.date).slice(0, 10), r.total])); V.diaErro = null; } catch (e) { V.diaErro = msgErro(e); }
    V.em = new Date().toISOString(); V.erro = null;
  } catch (e) { P.visitas = { ...(P.visitas || { meses: {} }), erro: msgErro(e) }; }
  // perguntas do mês e do mês passado
  fase(idx, 'perguntas');
  try {
    const mAt = mesDe(hoje), mA = mesSoma(mAt, -1), limite = Date.parse(mA + '-01T00:00:00-03:00');
    const S = { [mAt]: { n: 0, horas: 0, nResp: 0, recebidas: 0 }, [mA]: { n: 0, horas: 0, nResp: 0, recebidas: 0 } };
    for (let off = 0; off < 5000; off += 50) {
      const r = await get(idx, '/questions/search', { seller_id: seller, api_version: 4, sort_fields: 'date_created', sort_types: 'DESC', limit: 50, offset: off });
      const L = r.questions || [];
      for (const q of L) {
        const t = Date.parse(q.date_created); if (t < limite) continue;
        const m = mesDe(ymd(sp(t))), s = S[m]; if (!s) continue;
        s.recebidas++;
        if (q.status === 'ANSWERED' && q.answer?.date_created) { s.n++; const h = (Date.parse(q.answer.date_created) - t) / 3600e3; if (h >= 0) { s.horas += h; s.nResp++; } }
      }
      if (L.length < 50 || Date.parse(L[L.length - 1].date_created) < limite) break;
    }
    P.perguntas = { em: new Date().toISOString(), atual: { mes: mAt, respondidas: S[mAt].n, recebidas: S[mAt].recebidas, mediaHoras: S[mAt].nResp ? r2(S[mAt].horas / S[mAt].nResp) : null },
      anterior: { mes: mA, respondidas: S[mA].n, recebidas: S[mA].recebidas, mediaHoras: S[mA].nResp ? r2(S[mA].horas / S[mA].nResp) : null } };
  } catch (e) { P.perguntas = { ...(P.perguntas || {}), erro: msgErro(e) }; }
  P.diarioDia = hoje; P.diarioEm = new Date().toISOString();
}

// ─── Apuração (margem, custos, frete do vendedor, DRE) — uma vez por dia, as 3 contas ─────
let _apuRod = false;
const arqApu = path.join(DIR, 'apuracao.json');
async function apuracao() {
  if (_apuRod) return; _apuRod = true;
  const A = { dia: hojeSP(), em: null, periodos: {}, contas: {} };
  try {
    const hoje = hojeSP(), ontem = somaDias(hoje, -1), mAt = mesDe(hoje);
    const per = { m1: [mesSoma(mAt, -1) + '-01', fimMes(mesSoma(mAt, -1))], m2: [mesSoma(mAt, -2) + '-01', fimMes(mesSoma(mAt, -2))], m3: [mesSoma(mAt, -3) + '-01', fimMes(mesSoma(mAt, -3))] };
    if (mesDe(ontem) === mAt) per.cur = [mAt + '-01', ontem];
    const desp = lerJson(path.join(DATA, 'despesas.json'), { lanc: [] }).lanc || [];
    const apm = require('./apuracao_mkt');
    for (const [k, [ini, fim]] of Object.entries(per)) {
      for (const C of CONTAS) fase(C.idx, 'apuração ' + ini.slice(0, 7));
      let res;
      try { res = await apm.resultado({ emp: 'todas', ini, fim }); } catch (e) { A.periodos[k] = { ini, fim, erro: e.message }; continue; }
      A.periodos[k] = { ini, fim, pendentes: res.pendentes || [] };
      const rl = l => (l.receita || 0) - (l.devolucao || 0);
      const totRL = (res.linhas || []).reduce((s, l) => s + rl(l), 0);
      for (const C of CONTAS) {
        const out = (A.contas[C.idx] ||= {});
        if ((res.pendentes || []).includes(C.empNome)) { out[k] = { pendente: true, ini, fim }; continue; }
        const L = res.linhas.filter(l => l.empresa === C.empNome), ML = L.filter(l => l.canal === 'Mercado Livre');
        const s = { ini, fim, receita: 0, devolucao: 0, cmv: 0, comissao: 0, taxa: 0, frete: 0, imposto: 0, embalagem: 0, ads: 0, lucro: 0 };
        const ped = new Set(), semCusto = new Set(); let recCusto = 0, recTot = 0;
        for (const l of ML) {
          for (const c of ['receita', 'devolucao', 'cmv', 'comissao', 'taxa', 'frete', 'imposto', 'embalagem', 'ads', 'lucro']) s[c] += l[c] || 0;
          if (l.pedido === 'ADS') continue;
          ped.add(l.pedido); recTot += l.receita || 0;
          if (l.custoUn == null) semCusto.add(l.pedido); else recCusto += l.receita || 0;
        }
        for (const c of Object.keys(s)) if (typeof s[c] === 'number') s[c] = r2(s[c]);
        s.pedidos = ped.size; s.pedidosSemCusto = semCusto.size; s.pctReceitaComCusto = recTot ? r2(recCusto / recTot * 100) : null;
        s.aliquota = ML.find(l => l.receita > 0 && l.imposto > 0) ? r2(ML.find(l => l.receita > 0 && l.imposto > 0).imposto / ML.find(l => l.receita > 0 && l.imposto > 0).receita * 100) : null;
        // ontem: pedidos com margem negativa
        const doDia = d => { const p = {}; for (const l of ML) if (l.data === d && l.pedido !== 'ADS') { const x = p[l.pedido] ||= { lucro: 0, receita: 0, semCusto: false, desc: l.descricao }; x.lucro += l.lucro || 0; x.receita += l.receita || 0; if (l.custoUn == null) x.semCusto = true; } return p; };
        if (ontem >= ini && ontem <= fim) {
          const p = doDia(ontem), neg = Object.entries(p).filter(([, x]) => x.lucro < -0.005 && !x.semCusto);
          s.ontem = { dia: ontem, pedidos: Object.keys(p).length, negativos: neg.length, perdido: r2(neg.reduce((a, [, x]) => a + x.lucro, 0)), semCusto: Object.values(p).filter(x => x.semCusto).length,
            piores: neg.sort((a, b) => a[1].lucro - b[1].lucro).slice(0, 5).map(([id, x]) => ({ pedido: id, lucro: r2(x.lucro), receita: r2(x.receita), desc: x.desc })) };
        }
        // despesas fixas rateadas: da empresa + compartilhadas (pela receita líquida), depois pela participação do ML na empresa
        const mes = ini.slice(0, 7), empRL = L.reduce((a, l) => a + rl(l), 0), mlRL = ML.reduce((a, l) => a + rl(l), 0);
        const dEmp = desp.filter(l => l.mes === mes && l.empresa === C.emp).reduce((a, l) => a + (l.valor || 0), 0);
        const dTodas = desp.filter(l => l.mes === mes && l.empresa === 'todas').reduce((a, l) => a + (l.valor || 0), 0);
        const fixasEmp = dEmp + (totRL ? dTodas * empRL / totRL : 0);
        s.despesas = { lancadas: desp.some(l => l.mes === mes), empresa: r2(fixasEmp), partML: empRL ? r2(mlRL / empRL * 100) : null, rateadoML: empRL ? r2(fixasEmp * mlRL / empRL) : null };
        s.adsInfo = res.ads?.[C.empNome] || null;
        out[k] = s;
      }
    }
  } catch (e) { A.erro = e.message; }
  A.em = new Date().toISOString();
  gravarJson(arqApu, A); _apu = A; _apuRod = false;
}
let _apu = null;
const apu = () => (_apu ||= lerJson(arqApu, null));

// ─── Montagem da resposta ───────────────────────────────────────────────────
const soma = (L, f) => L.reduce((a, x) => a + (f(x) || 0), 0);
const pct = (a, b) => b ? r2((a - b) / b * 100) : null;
function bloco(fn) { try { return fn(); } catch (e) { return { erro: e.message }; } }
function periodo(D, a, b) {
  const L = diasEntre(a, b), tem = L.filter(d => D[d]), x = tem.map(d => D[d]);
  const n = soma(x, d => d.n), fat = r2(soma(x, d => d.fat));
  return { ini: a, fim: b, dias: L.length, diasComDados: tem.length, n, fat, fatF: r2(soma(x, d => d.fatF)), freteC: r2(soma(x, d => d.freteC)), canc: soma(x, d => d.canc), cancV: r2(soma(x, d => d.cancV)),
    tar: r2(soma(x, d => d.tar)), ticket: n ? r2(fat / n) : null };
}
function montar(idx) {
  const P = partes(idx), D = dias(idx), A = apu(), AC = A?.contas?.[idx] || {};
  const hoje = hojeSP(), ontem = somaDias(hoje, -1), mAt = mesDe(hoje), mA = mesSoma(mAt, -1);
  const dd = mesDe(ontem) === mAt ? Number(ontem.slice(8, 10)) : 0;
  const out = { idx, conta: CONTAS[idx].nome, hoje, ontem, agora: new Date().toISOString(), status: ST[idx] || null,
    calc: { rapido: P.rapidoEm || null, diario: P.diarioEm || null, apuracao: A?.em || null } };
  out.cartao = bloco(() => {
    if (!P.conta) throw new Error('ainda calculando');
    const tx = P.conta.transacoes;
    return { ...P.conta, vendasTotais: tx?.total ?? null, concluidas: tx?.completed ?? null, canceladas: tx?.canceled ?? null };
  });
  out.fazer = bloco(() => { if (!P.fazer) throw new Error('ainda calculando'); return P.fazer; });
  out.hoje = bloco(() => {
    const H = D[hoje], O = D[ontem]; if (!H) throw new Error(P.hojeErro || 'ainda calculando');
    const ateMin = minutoSP(H.em);   // ontem até a mesma hora em que os pedidos de hoje foram lidos
    const oN = O ? O.m.filter(x => x[0] <= ateMin).reduce((a, x) => a + (x[2] ?? 1), 0) : null, oF = O ? r2(soma(O.m.filter(x => x[0] <= ateMin), x => x[1])) : null;
    return { n: H.n, fat: H.fat, canc: H.canc, ateHora: String(Math.floor(ateMin / 60)).padStart(2, '0') + ':' + String(ateMin % 60).padStart(2, '0'), ontemN: oN, ontemFat: oF,
      varN: pct(H.n, oN), varFat: pct(H.fat, oF), em: H.em, ticket: H.n ? r2(H.fat / H.n) : null, ontemDia: O ? { n: O.n, fat: O.fat } : null, erro: P.hojeErro || undefined };
  });
  out.mes = bloco(() => {
    if (!dd) return { semDias: true, msg: 'Hoje é o 1º dia do mês: ainda não há dias fechados.', anterior: periodo(D, mA + '-01', fimMes(mA)) };
    const at = periodo(D, mAt + '-01', ontem), diaA = Math.min(dd, ultimoDia(mA));
    const an = periodo(D, mA + '-01', mA + '-' + String(diaA).padStart(2, '0')), inteiro = periodo(D, mA + '-01', fimMes(mA));
    const V = P.visitas || {};
    at.visitas = V.mesAteOntem ?? null; an.visitas = V.mesAntMesmoPeriodo ?? null; inteiro.visitas = V.meses?.[mA]?.v ?? null;
    for (const x of [at, an, inteiro]) x.conv = x.visitas ? r2(x.n / x.visitas * 100) : null;
    const ritmo = r2(at.fat / dd * ultimoDia(mAt)), ritmoF = r2(at.fatF / dd * ultimoDia(mAt));
    return { atual: at, anterior: an, mesAnterior: inteiro, ritmo, ritmoF, diasFechados: dd, diasMes: ultimoDia(mAt),
      var: { fat: pct(at.fat, an.fat), fatF: pct(at.fatF, an.fatF), n: pct(at.n, an.n), ticket: pct(at.ticket, an.ticket), visitas: pct(at.visitas, an.visitas), conv: at.conv != null && an.conv != null ? r2(at.conv - an.conv) : null, canc: pct(at.canc, an.canc) },
      visitasErro: V.erro || null };
  });
  out.entrega = bloco(() => {
    const L = diasEntre(mAt + '-01', hoje).filter(d => D[d]);
    if (!L.length) throw new Error('sem vendas no mês ainda');
    const log = { fulfillment: 0, cross_docking: 0, self_service: 0, outros: 0, semInfo: 0 };
    for (const d of L) { const g = D[d].log; if (!g) { log.semInfo += (D[d].sh || []).length + (D[d].semEnvio || 0); continue; } for (const k in log) log[k] += g[k] || 0; }
    const ap = AC.cur && !AC.cur.pendente ? AC.cur : null, nCur = periodo(D, mAt + '-01', ontem).n;
    return { ...log, total: Object.values(log).reduce((a, b) => a + b, 0), ate: hoje,
      frete: ap ? { total: ap.frete, porVenda: nCur ? r2(ap.frete / nCur) : null, pctFat: ap.receita ? r2(ap.frete / ap.receita * 100) : null, ate: ontem } : null,
      freteMsg: ap ? null : (AC.cur?.pendente ? 'apuração do mês ainda não baixada' : dd ? 'apuração ainda não calculada' : 'mês começou hoje'), logErro: P.logErro || null };
  });
  out.grafico = bloco(() => {
    // semana: segunda → ontem (dias fechados) × semana anterior inteira
    // na segunda-feira ainda não há dia fechado na semana: mostra a semana passada × a retrasada
    const wd = (new Date(hoje + 'T12:00:00Z').getUTCDay() + 6) % 7, seg = somaDias(hoje, -wd - (wd === 0 ? 7 : 0)), segA = somaDias(seg, -7);
    const semana = Array.from({ length: 7 }, (_, i) => { const d = somaDias(seg, i), a = somaDias(segA, i); return { d, atual: d < hoje && D[d] ? D[d].fat : null, ant: D[a]?.fat ?? null, dAnt: a }; });
    const mesG = Array.from({ length: 31 }, (_, i) => { const n = String(i + 1).padStart(2, '0'), d = mAt + '-' + n, a = mA + '-' + n; return { dia: i + 1, atual: d < hoje && D[d] ? D[d].fat : null, ant: i < ultimoDia(mA) ? (D[a]?.fat ?? null) : null }; });
    const acum = h => { let s = 0; return h.map(x => r2(s += x[1])); };
    const H = D[hoje], O = D[ontem], hAgora = sp().getUTCHours();
    const hora = Array.from({ length: 24 }, (_, i) => ({ h: i, atual: H && i <= hAgora ? acum(H.h)[i] : null, ant: O ? acum(O.h)[i] : null, nAtual: H && i <= hAgora ? H.h[i][0] : null, nAnt: O ? O.h[i][0] : null }));
    return { semana, semanaPassada: wd === 0, mes: mesG, hora };
  });
  out.atencao = bloco(() => {
    const ref = AC.cur && !AC.cur.pendente ? AC.cur : null, m1 = AC.m1 && !AC.m1.pendente ? AC.m1 : null;
    const ontemInfo = (ref?.ontem) || (m1?.ontem) || null;
    return { ontem: ontemInfo, ontemDia: ontem,
      mes: ref ? { pedidos: ref.pedidos, semCusto: ref.pedidosSemCusto, pctComCusto: ref.pedidos ? r2((ref.pedidos - ref.pedidosSemCusto) / ref.pedidos * 100) : null, pctReceitaComCusto: ref.pctReceitaComCusto, aliquota: ref.aliquota,
        margem: ref.receita - ref.devolucao ? r2(ref.lucro / (ref.receita - ref.devolucao) * 100) : null, lucro: ref.lucro, ini: ref.ini, fim: ref.fim } : null,
      msg: !A ? 'apuração ainda não calculada' : AC.cur?.pendente ? 'a apuração do mês ainda não foi baixada (aba Apuração)' : (!ref && dd ? 'sem apuração do mês' : null) };
  });
  out.evolucao = bloco(() => {
    const meses = [3, 2, 1].map(n => mesSoma(mAt, -n)), V = P.visitas || {}, snap = P.snap || {};
    const linhas = meses.map((m, i) => {
      const p = periodo(D, m + '-01', fimMes(m)), ap = AC['m' + (3 - i)], ok = ap && !ap.pendente && !ap.erro;
      const snaps = Object.keys(snap).filter(d => mesDe(d) === m).sort(), sn = snaps.length ? snap[snaps[snaps.length - 1]] : null;
      const vis = V.meses?.[m]?.v ?? null;
      return { mes: m, vendas: p.n, fat: p.fat, ticket: p.ticket, tarifas: ok ? r2(ap.comissao + ap.taxa) : p.tar, tarifasFonte: ok ? 'apuração' : 'pedidos (sale_fee)', frete: ok ? ap.frete : null,
        lucro: ok ? ap.lucro : null, margem: ok && ap.receita - ap.devolucao ? r2(ap.lucro / (ap.receita - ap.devolucao) * 100) : null, ads: ok ? ap.ads : null,
        canc: p.canc, cancV: p.cancV, visitas: vis, conv: vis ? r2(p.n / vis * 100) : null, ativos: sn?.at ?? null, completo: p.diasComDados === p.dias, apuracao: ok ? 'ok' : ap?.pendente ? 'não baixada' : 'sem dados' };
    });
    // diário: visitas × vendas (últimos 60 dias) e anúncios ativos × vendas (desde que o snapshot começou)
    const ult = diasEntre(somaDias(ontem, -59), ontem);
    const visDia = ult.map(d => ({ d, vis: V.dia?.[d] ?? null, vendas: D[d]?.n ?? null }));
    const snDias = Object.keys(snap).sort();
    const ativosDia = snDias.map(d => ({ d, ativos: snap[d].at, vendas: D[d]?.n ?? null, parcial: d === hoje }));
    return { meses: linhas, visDia, ativosDia, snapshotDesde: snDias[0] || null };
  });
  out.cascata = bloco(() => {
    const ap = AC.m1; if (!A) throw new Error('apuração ainda não calculada');
    if (!ap || ap.pendente) throw new Error('apuração de ' + mA.split('-').reverse().join('/') + ' não está baixada (rode na aba Apuração)');
    const rl = ap.receita - ap.devolucao, mc = rl - ap.comissao - ap.taxa - ap.frete - ap.imposto - ap.cmv - ap.embalagem - ap.ads;
    return { mes: mA, faturamento: ap.receita, devolucao: ap.devolucao, tarifas: r2(ap.comissao + ap.taxa), frete: ap.frete, imposto: ap.imposto, cmv: ap.cmv, embalagem: ap.embalagem, ads: ap.ads,
      margem: r2(mc), margemPct: rl ? r2(mc / rl * 100) : null, despesas: ap.despesas, resultado: ap.despesas?.rateadoML != null && ap.despesas.lancadas ? r2(mc - ap.despesas.rateadoML) : null, pedidosSemCusto: ap.pedidosSemCusto, pedidos: ap.pedidos };
  });
  out.destaques = bloco(() => {
    const L = diasEntre(mA + '-01', fimMes(mA)).filter(d => D[d]); if (!L.length) throw new Error('sem pedidos do mês anterior');
    const it = {};
    for (const d of L) for (const [id, x] of Object.entries(D[d].it || {})) { const t = it[id] ||= { id, t: x.t, s: x.s, q: 0, v: 0, cq: 0, cv: 0 }; t.q += x.q; t.v += x.v; t.cq += x.cq; t.cv += x.cv; }
    const I = Object.values(it).map(x => ({ ...x, v: r2(x.v), cv: r2(x.cv) }));
    return { mes: mA, faturaram: [...I].sort((a, b) => b.v - a.v).slice(0, 5), vendidos: [...I].sort((a, b) => b.q - a.q).slice(0, 5), cancelamentos: I.filter(x => x.cq > 0).sort((a, b) => b.cq - a.cq || b.cv - a.cv).slice(0, 5) };
  });
  out.perguntas = bloco(() => { if (!P.perguntas && !P.semResposta) throw new Error('ainda calculando'); return { ...(P.perguntas || {}), semResposta: P.semResposta?.n ?? null, semRespostaErro: P.semResposta?.erro || null }; });
  return out;
}

function msgErro(e) {
  const st = e.response?.status, b = e.response?.data;
  return (st ? st + ' ' : '') + (b?.message || b?.error || e.message || 'erro');
}

// ─── Agendador ──────────────────────────────────────────────────────────────
async function rodar(idx, { forcar } = {}) {
  if (ST[idx]?.rodando) return;
  ST[idx] = { rodando: true, inicio: new Date().toISOString(), fase: 'iniciando' };
  try {
    await rapido(idx); salvar(idx);
    if (forcar || partes(idx).diarioDia !== hojeSP() || Object.values(dias(idx)).some(x => x.fechado && x.v !== 2)) { await diario(idx); salvar(idx); }
    ST[idx] = { rodando: false, fim: new Date().toISOString() };
  } catch (e) { console.warn('[dashboard]', idx, e.message); ST[idx] = { rodando: false, erro: msgErro(e), fim: new Date().toISOString() }; salvar(idx); }
}
let _tick = false;
async function tick() {
  if (_tick) return; _tick = true;
  try {
    for (const C of CONTAS) {
      const P = partes(C.idx);
      if (!P.rapidoEm || Date.now() - Date.parse(P.rapidoEm) > (RAPIDO_MIN - 1) * 60e3 || P.diarioDia !== hojeSP()) await rodar(C.idx);
    }
    // apuração: depois das 7h (a automática do painel roda entre 00:15 e 06:00), 1x por dia
    const A = apu(), h = sp().getUTCHours();
    if (!A || (A.dia !== hojeSP() && h >= 7)) await apuracao();
  } finally { _tick = false; }
}

module.exports = function (app, fontes) {
  F = fontes;
  const admin = (req, res) => { if (require('./auth').ativo() && !req.usuario?.admin) { res.status(403).json({ erro: 'só admin' }); return false; } return true; };
  const idxOk = req => { const i = parseInt(req.params.idx); return CONTAS[i] ? i : null; };
  app.get('/dashboard/:idx', (req, res) => {
    const i = idxOk(req); if (i == null) return res.status(400).json({ erro: 'conta inválida' });
    if (!admin(req, res)) return;
    try { res.json(montar(i)); } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  app.get('/dashboard/:idx/status', (req, res) => { const i = idxOk(req); res.json({ conta: ST[i] || null, apuracao: { rodando: _apuRod, em: apu()?.em || null } }); });
  app.post('/dashboard/:idx/atualizar', (req, res) => {
    const i = idxOk(req); if (i == null) return res.status(400).json({ erro: 'conta inválida' });
    if (!admin(req, res)) return;
    const completo = req.query.completo === '1';
    (async () => { await rodar(i, { forcar: completo }); if (completo || req.query.apuracao === '1') await apuracao(); })().catch(e => console.warn('[dashboard]', e.message));
    res.json({ ok: true, rodando: true });
  });
  setTimeout(() => { tick().catch(() => {}); setInterval(() => tick().catch(() => {}), 5 * 60e3); }, 90e3);
};
module.exports.montar = montar;
