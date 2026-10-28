/**
 * NF-e automática dos pedidos da SHEIN no Bling (Zagodini e Com Amor de Mãe).
 * O Bling importa o pedido da SHEIN e deixa "Em aberto" sem nota; aqui o painel:
 *   1. lista os pedidos de venda da SHEIN em aberto dos últimos DIAS dias, sem nota;
 *   2. confere na SHEIN que o pedido não foi cancelado;
 *   3. gera a NF-e a partir do pedido (POST /pedidos/vendas/{id}/gerar-nfe — usa natureza/impostos do Bling);
 *   4. transmite à SEFAZ (POST /nfe/{id}/enviar) e confere a situação.
 * Modo "manual" (padrão): só lista e emite quando o usuário clica. Modo "auto": emite sozinho a cada 15 min.
 * Precisa no app do Bling dos escopos de Pedidos de Venda e Notas Fiscais com permissão de escrita.
 *
 *  GET  /nfe-shein                 situação, pendentes e histórico
 *  POST /nfe-shein/atualizar       relista
 *  POST /nfe-shein/emitir          { emp, id }  emite um pedido
 *  POST /nfe-shein/modo            { modo: 'manual' | 'auto' }
 */
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');
const bling = require('./bling');

const EMP = [{ id: 'zagodini', nome: 'Zagodini', idx: 0 }, { id: 'mae', nome: 'Com Amor de Mãe', idx: 1 }];
const DIAS = 10;
const ARQ = path.join(DATA, 'apuracao_cache', 'nfe_shein.json');
const ler = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const gravar = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch (e) {} };
const delay = ms => new Promise(r => setTimeout(r, ms));
const ymd = d => d.toISOString().slice(0, 10);
const S = Object.assign({ modo: 'manual', pendentes: [], hist: [] }, ler(ARQ, {}));
const salvar = () => { S.hist = S.hist.slice(0, 300); gravar(ARQ, S); };
const erroTxt = e => { const d = e.response?.data?.error; return d ? [d.message, d.description, ...(d.fields || []).map(f => f.msg)].filter(Boolean).join(' · ') : e.message; };
// situação da NF-e no Bling: 1 pendente, 2 cancelada, 3 aguardando recibo, 4 rejeitada, 5 autorizada, 6 emitida DANFE, 7 registrada, 8 aguardando protocolo, 9 denegada, 10 consulta situação, 11 bloqueada
// Bling: 3 req/s — repete em 429
async function req(c, metodo, url, cfg) {
  for (let t = 0; ; t++) {
    try { return await c[metodo](url, ...(metodo === 'post' ? [undefined, cfg] : [cfg])); }
    catch (e) { if (e.response?.status === 429 && t < 6) { await delay(1500 * (t + 1)); continue; } throw e; }
  }
}
const SIT = { 1: 'pendente', 2: 'cancelada', 3: 'aguardando recibo', 4: 'rejeitada', 5: 'autorizada', 6: 'autorizada', 7: 'autorizada', 8: 'aguardando protocolo', 9: 'denegada', 10: 'em consulta', 11: 'bloqueada' };

let _sitAberto = {};
async function idEmAberto(idx) {
  if (_sitAberto[idx]) return _sitAberto[idx];
  try {
    const c = bling.client(idx), mods = (await req(c, 'get', '/situacoes/modulos')).data?.data || [];
    const v = mods.find(m => /venda/i.test(m.nome || m.descricao || ''));
    for (const s of v ? (await req(c, 'get', `/situacoes/modulos/${v.id}`)).data?.data || [] : []) if (/^em aberto$/i.test((s.nome || '').trim())) return (_sitAberto[idx] = s.id);
  } catch (e) {}
  return (_sitAberto[idx] = 6);
}

async function listar() {
  const out = [];
  for (const E of EMP) {
    try {
      const c = bling.client(E.idx), sit = await idEmAberto(E.idx);
      const canais = await bling.getCanaisVenda(E.idx).catch(() => ({}));
      const de = ymd(new Date(Date.now() - DIAS * 864e5)), ate = ymd(new Date(Date.now() + 864e5));
      for (let pagina = 1; pagina <= 20; pagina++) {
        const L = (await req(c, 'get', '/pedidos/vendas', { params: { 'idsSituacoes[]': sit, dataInicial: de, dataFinal: ate, limite: 100, pagina } })).data?.data || [];
        for (const p of L) {
          const loja = canais[p.loja?.id] || '';
          if (!(/shein/i.test(loja) || /^GSH/i.test(p.numeroLoja || ''))) continue;
          out.push({ emp: E.id, empresa: E.nome, idx: E.idx, id: p.id, numero: p.numero, numeroLoja: p.numeroLoja, data: p.data, total: p.total, cliente: p.contato?.nome || '' });
        }
        if (L.length < 100) break;
        await delay(400);
      }
    } catch (e) { out.push({ emp: E.id, empresa: E.nome, erro: erroTxt(e) }); }
  }
  // tira quem já tem nota
  for (const p of out.filter(x => x.id)) {
    try { const d = (await req(bling.client(p.idx), 'get', '/pedidos/vendas/' + p.id)).data?.data; p.nota = d?.notaFiscal?.id || null; } catch (e) {}
    await delay(350);
  }
  S.pendentes = out.filter(x => x.erro || !x.nota);
  S.listadoEm = new Date().toISOString();
  salvar();
  return S.pendentes;
}

async function emitir(p, por) {
  const reg = { em: new Date().toISOString(), emp: p.emp, empresa: p.empresa, pedido: p.numero, numeroLoja: p.numeroLoja, por: por || 'automático' };
  try {
    // 1. SHEIN: não emite se o pedido foi cancelado (ou se não deu para conferir)
    const shein = require('./shein');
    if (shein.autorizada(p.emp)) {
      const P = (await shein.detalhes(p.emp, [p.numeroLoja], { idadeMin: 0 }))[p.numeroLoja];
      if (!P) throw new Error('não encontrei o pedido na SHEIN para conferir — não emitido');
      if (Number(P.st) === 6) { reg.situacao = 'cancelado na SHEIN — não emitido'; S.hist.unshift(reg); salvar(); return reg; }
    }
    const c = bling.client(p.idx);
    // 2. confere de novo que o pedido continua sem nota
    const ped = (await req(c, 'get', '/pedidos/vendas/' + p.id)).data?.data;
    let nfe = ped?.notaFiscal?.id || null;
    // 3. gera a NF-e a partir do pedido
    if (!nfe) { const r = await req(c, 'post', `/pedidos/vendas/${p.id}/gerar-nfe`); nfe = r.data?.data?.id || r.data?.data?.idNotaFiscal || null; }
    if (!nfe) throw new Error('o Bling não devolveu o id da nota gerada');
    reg.nfe = nfe;
    // 4. transmite à SEFAZ (se ainda pendente)
    let n = (await req(c, 'get', '/nfe/' + nfe)).data?.data;
    if ([1, 4].includes(Number(n?.situacao))) { await req(c, 'post', `/nfe/${nfe}/enviar`); await delay(4000); n = (await req(c, 'get', '/nfe/' + nfe)).data?.data; }
    for (let t = 0; t < 4 && [3, 8, 10].includes(Number(n?.situacao)); t++) { await delay(5000); n = (await req(c, 'get', '/nfe/' + nfe)).data?.data; }
    reg.numeroNota = n?.numero; reg.chave = n?.chaveAcesso; reg.situacao = SIT[n?.situacao] || ('situação ' + n?.situacao);
    reg.ok = [5, 6, 7].includes(Number(n?.situacao));
  } catch (e) { reg.situacao = 'erro'; reg.erro = erroTxt(e); }
  S.hist.unshift(reg); salvar();
  if (!reg.ok && reg.situacao !== 'cancelado na SHEIN — não emitido') try { require('./telegram').sendTelegram(`⚠️ NF-e SHEIN ${p.empresa} pedido ${p.numeroLoja}: ${reg.erro || reg.situacao}`); } catch (e) {}
  return reg;
}

let rodando = false;
async function rodarAuto() {
  if (rodando) return; rodando = true;
  try {
    const L = await listar();
    if (S.modo === 'auto') for (const p of L.filter(x => x.id)) {
      if (S.hist.some(h => h.emp === p.emp && h.pedido === p.numero && h.situacao === 'erro' && Date.now() - Date.parse(h.em) < 6 * 3600e3)) continue;   // erro recente: não insiste
      await emitir(p); await delay(1500);
    }
    if (S.modo === 'auto') await listar();
  } catch (e) { S.erro = e.message; }
  rodando = false;
}

module.exports = function (app) {
  const admin = (req, res) => { if (require('./auth').ativo() && !req.usuario?.admin) { res.status(403).json({ erro: 'só admin' }); return false; } return true; };
  app.get('/nfe-shein', (req, res) => res.json({ modo: S.modo, listadoEm: S.listadoEm, rodando, pendentes: S.pendentes, hist: S.hist.slice(0, 60) }));
  app.post('/nfe-shein/atualizar', async (req, res) => { try { await listar(); res.json({ ok: true }); } catch (e) { res.status(500).json({ erro: e.message }); } });
  app.post('/nfe-shein/emitir', require('express').json(), async (req, res) => {
    if (!admin(req, res)) return;
    const p = S.pendentes.find(x => x.emp === req.body?.emp && String(x.id) === String(req.body?.id));
    if (!p) return res.status(404).json({ erro: 'pedido não está na lista de pendentes (atualize)' });
    const r = await emitir(p, req.usuario?.nome || req.usuario?.email || 'painel');
    listar().catch(() => {});
    res.json(r);
  });
  app.post('/nfe-shein/modo', require('express').json(), (req, res) => {
    if (!admin(req, res)) return;
    if (!['manual', 'auto'].includes(req.body?.modo)) return res.status(400).json({ erro: 'modo inválido' });
    S.modo = req.body.modo; salvar(); res.json({ ok: true, modo: S.modo });
  });
  setTimeout(() => rodarAuto().catch(() => {}), 60e3);
  setInterval(() => rodarAuto().catch(() => {}), 15 * 60e3).unref?.();
};
