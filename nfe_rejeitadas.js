/**
 * NF-e rejeitadas no Bling (Zagodini e Com Amor de Mãe): corrige o endereço do destinatário pelo CEP e retransmite.
 *
 * Casos que a SEFAZ rejeita e que dá para resolver só com o CEP (que sempre vem):
 *   - bairro vazio;
 *   - município que não existe na UF (escrita errada: "Parati" em vez de "Paraty").
 * O CEP é consultado na ViaCEP (e na BrasilAPI, se a ViaCEP falhar). Se não achar: bairro "Centro" e a capital do estado.
 * O município é conferido na lista oficial do IBGE da UF.
 *
 * Modo "auto": a cada 15 min corrige e retransmite sozinho. Modo "manual" (padrão até validar): só lista; corrige no botão.
 *
 *  GET  /nfe-rejeitadas                 lista + histórico
 *  POST /nfe-rejeitadas/atualizar       relista
 *  POST /nfe-rejeitadas/corrigir        { emp, id }  corrige e transmite uma nota
 *  POST /nfe-rejeitadas/modo            { modo: 'manual' | 'auto' }
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const DATA = require('./dados');
const bling = require('./bling');

const EMP = [{ id: 'zagodini', nome: 'Zagodini', idx: 0 }, { id: 'mae', nome: 'Com Amor de Mãe', idx: 1 }];
const DIAS = 20;
const ARQ = path.join(DATA, 'apuracao_cache', 'nfe_rejeitadas.json');
const ler = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const gravar = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch (e) {} };
const delay = ms => new Promise(r => setTimeout(r, ms));
const S = Object.assign({ modo: 'manual', lista: [], hist: [] }, ler(ARQ, {}));
const salvar = () => { S.hist = S.hist.slice(0, 300); gravar(ARQ, S); };
const erroTxt = e => { const d = e.response?.data?.error; return d ? [d.message, d.description, ...(d.fields || []).map(f => f.msg)].filter(Boolean).join(' · ') : e.message; };
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const SIT = { 1: 'pendente', 2: 'cancelada', 3: 'aguardando recibo', 4: 'rejeitada', 5: 'autorizada', 6: 'autorizada', 7: 'autorizada', 8: 'aguardando protocolo', 9: 'denegada', 10: 'em consulta', 11: 'bloqueada' };
const CAPITAL = { AC: 'Rio Branco', AL: 'Maceió', AP: 'Macapá', AM: 'Manaus', BA: 'Salvador', CE: 'Fortaleza', DF: 'Brasília', ES: 'Vitória', GO: 'Goiânia', MA: 'São Luís', MT: 'Cuiabá', MS: 'Campo Grande', MG: 'Belo Horizonte', PA: 'Belém', PB: 'João Pessoa', PR: 'Curitiba', PE: 'Recife', PI: 'Teresina', RJ: 'Rio de Janeiro', RN: 'Natal', RS: 'Porto Alegre', RO: 'Porto Velho', RR: 'Boa Vista', SC: 'Florianópolis', SP: 'São Paulo', SE: 'Aracaju', TO: 'Palmas' };

async function breq(c, metodo, url, a, b) {
  for (let t = 0; ; t++) {
    try { return await c[metodo](url, a, b); }
    catch (e) { if (e.response?.status === 429 && t < 6) { await delay(1500 * (t + 1)); continue; } throw e; }
  }
}

// municípios do IBGE por UF (cache em memória)
const _mun = {};
async function municipios(uf) {
  if (_mun[uf]) return _mun[uf];
  const r = await axios.get(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios`, { timeout: 20000 });
  return (_mun[uf] = (r.data || []).map(m => m.nome));
}
const acharMunicipio = (lista, nome) => lista.find(m => norm(m) === norm(nome)) || null;

async function cep(c) {
  c = String(c || '').replace(/\D/g, '');
  if (c.length !== 8) return null;
  try { const d = (await axios.get(`https://viacep.com.br/ws/${c}/json/`, { timeout: 10000 })).data; if (d && !d.erro) return { bairro: d.bairro || '', municipio: d.localidade || '', uf: d.uf || '' }; } catch (e) {}
  try { const d = (await axios.get(`https://brasilapi.com.br/api/cep/v2/${c}`, { timeout: 10000 })).data; if (d?.city) return { bairro: d.neighborhood || '', municipio: d.city || '', uf: d.state || '' }; } catch (e) {}
  return null;
}

/** Diagnóstico do endereço da nota: o que está errado e como fica */
async function diagnosticar(nf) {
  const e = nf?.contato?.endereco || {}, uf = String(e.uf || '').toUpperCase();
  const problemas = [];
  if (!String(e.bairro || '').trim()) problemas.push('bairro vazio');
  let lista = [];
  try { lista = uf ? await municipios(uf) : []; } catch (err) {}
  const munOk = lista.length ? acharMunicipio(lista, e.municipio) : e.municipio;
  if (lista.length && !munOk) problemas.push(`município "${e.municipio || ''}" não existe em ${uf || '?'}`);
  if (!problemas.length) return { problemas, novo: null };
  const C = await cep(e.cep);
  const ufN = (C?.uf || uf).toUpperCase();
  let listaN = lista; if (ufN !== uf) try { listaN = await municipios(ufN); } catch (err) {}
  const munCep = C?.municipio ? acharMunicipio(listaN, C.municipio) : null;
  const novo = {
    bairro: String(e.bairro || '').trim() || C?.bairro || 'Centro',
    municipio: munOk && ufN === uf ? munOk : (munCep || CAPITAL[ufN] || e.municipio),
    uf: ufN,
  };
  novo.fonte = C ? 'CEP' : 'sem CEP: capital/Centro';
  if (!C?.bairro && !String(e.bairro || '').trim()) novo.fonte = C ? 'CEP (sem bairro: Centro)' : novo.fonte;
  return { problemas, novo, antes: { bairro: e.bairro || '', municipio: e.municipio || '', uf } };
}

async function listar() {
  const out = [];
  for (const E of EMP) {
    try {
      const c = bling.client(E.idx), de = new Date(Date.now() - DIAS * 864e5).toISOString().slice(0, 10);
      const L = (await breq(c, 'get', '/nfe', { params: { situacao: 4, dataEmissaoInicial: de + ' 00:00:00', limite: 100 } })).data?.data || [];
      for (const n of L) {
        const nf = (await breq(c, 'get', '/nfe/' + n.id)).data?.data; await delay(350);
        if (!nf || Number(nf.situacao) !== 4) continue;
        const d = await diagnosticar(nf);
        out.push({ emp: E.id, empresa: E.nome, idx: E.idx, id: nf.id, numero: nf.numero, data: nf.dataEmissao, cliente: nf.contato?.nome || '', cep: nf.contato?.endereco?.cep || '',
          pedidoLoja: nf.numeroPedidoLoja || '', problemas: d.problemas, novo: d.novo, antes: d.antes });
      }
    } catch (e) { out.push({ emp: E.id, empresa: E.nome, erro: erroTxt(e) }); }
  }
  S.lista = out; S.listadoEm = new Date().toISOString(); salvar();
  return out;
}

// corpo do PUT /nfe/{id}: a nota como veio do GET, sem os campos só de leitura, com o endereço corrigido
function corpoNota(nf, novo) {
  const b = JSON.parse(JSON.stringify(nf));
  for (const k of ['id', 'situacao', 'chaveAcesso', 'xml', 'linkDanfe', 'linkPDF']) delete b[k];
  Object.assign(b.contato.endereco, { bairro: novo.bairro, municipio: novo.municipio, uf: novo.uf });
  if (b.transporte && (b.transporte.cep || '').replace(/\D/g, '') === String(nf.contato?.endereco?.cep || '').replace(/\D/g, ''))   // endereço de entrega igual ao do destinatário
    Object.assign(b.transporte, { bairro: novo.bairro, municipio: novo.municipio, uf: novo.uf });
  return b;
}

async function corrigir(p, por) {
  const reg = { em: new Date().toISOString(), emp: p.emp, empresa: p.empresa, nota: p.numero, cliente: p.cliente, por: por || 'automático' };
  try {
    const c = bling.client(p.idx);
    const nf = (await breq(c, 'get', '/nfe/' + p.id)).data?.data;
    if (Number(nf?.situacao) !== 4) { reg.situacao = 'não está mais rejeitada (' + (SIT[nf?.situacao] || nf?.situacao) + ')'; S.hist.unshift(reg); salvar(); return reg; }
    const d = await diagnosticar(nf);
    if (!d.novo) { reg.situacao = 'sem problema de endereço — rejeição por outro motivo (ver no Bling)'; S.hist.unshift(reg); salvar(); return reg; }
    reg.problemas = d.problemas; reg.antes = d.antes; reg.novo = d.novo;
    await breq(c, 'put', '/nfe/' + p.id, corpoNota(nf, d.novo));
    await delay(1500);
    await breq(c, 'post', `/nfe/${p.id}/enviar`);
    let n = null;
    for (let t = 0; t < 5; t++) { await delay(4000); n = (await breq(c, 'get', '/nfe/' + p.id)).data?.data; if (![3, 8, 10].includes(Number(n?.situacao))) break; }
    reg.situacao = SIT[n?.situacao] || ('situação ' + n?.situacao); reg.ok = [5, 6, 7].includes(Number(n?.situacao));
  } catch (e) { reg.situacao = 'erro'; reg.erro = erroTxt(e); }
  S.hist.unshift(reg); salvar();
  try {
    const tg = require('./telegram'), mud = reg.novo ? ` (${reg.antes.bairro || 'sem bairro'}/${reg.antes.municipio} → ${reg.novo.bairro}/${reg.novo.municipio}-${reg.novo.uf})` : '';
    tg.sendTelegram(reg.ok ? `✅ NF-e ${reg.nota} ${p.empresa} corrigida${mud} e autorizada` : `⚠️ NF-e ${reg.nota} ${p.empresa} rejeitada: ${reg.erro || reg.situacao}${mud}`);
  } catch (e) {}
  return reg;
}

let rodando = false;
async function rodarAuto() {
  if (rodando) return; rodando = true;
  try {
    const L = await listar();
    if (S.modo === 'auto') {
      for (const p of L.filter(x => x.id && x.novo)) {
        if (S.hist.some(h => h.emp === p.emp && h.nota === p.numero && Date.now() - Date.parse(h.em) < 6 * 3600e3)) continue;   // já tentou há pouco: não insiste
        await corrigir(p); await delay(1500);
      }
      await listar();
    }
  } catch (e) { S.erro = e.message; }
  rodando = false;
}

module.exports = function (app) {
  const admin = (req, res) => { if (require('./auth').ativo() && !req.usuario?.admin) { res.status(403).json({ erro: 'só admin' }); return false; } return true; };
  app.get('/nfe-rejeitadas', (req, res) => res.json({ modo: S.modo, listadoEm: S.listadoEm, rodando, lista: S.lista, hist: S.hist.slice(0, 60) }));
  app.post('/nfe-rejeitadas/atualizar', async (req, res) => { try { await listar(); res.json({ ok: true }); } catch (e) { res.status(500).json({ erro: e.message }); } });
  app.post('/nfe-rejeitadas/corrigir', require('express').json(), async (req, res) => {
    if (!admin(req, res)) return;
    const p = S.lista.find(x => x.emp === req.body?.emp && String(x.id) === String(req.body?.id));
    if (!p) return res.status(404).json({ erro: 'nota não está na lista (atualize)' });
    const r = await corrigir(p, req.usuario?.nome || req.usuario?.email || 'painel');
    listar().catch(() => {});
    res.json(r);
  });
  app.post('/nfe-rejeitadas/modo', require('express').json(), (req, res) => {
    if (!admin(req, res)) return;
    if (!['manual', 'auto'].includes(req.body?.modo)) return res.status(400).json({ erro: 'modo inválido' });
    S.modo = req.body.modo; salvar(); res.json({ ok: true, modo: S.modo });
  });
  // teste (admin): regrava a nota sem mudar nada, para conferir o PUT — não transmite
  app.post('/nfe-rejeitadas/teste-put', require('express').json(), async (req, res) => {
    if (!admin(req, res)) return;
    try { const E = EMP.find(e => e.id === req.body?.emp), c = bling.client(E.idx); const nf = (await breq(c, 'get', '/nfe/' + req.body.id)).data?.data;
      const e = nf.contato.endereco; const r = await breq(c, 'put', '/nfe/' + req.body.id, corpoNota(nf, { bairro: e.bairro, municipio: e.municipio, uf: e.uf }));
      const depois = (await breq(c, 'get', '/nfe/' + req.body.id)).data?.data; res.json({ ok: true, status: r.status, antes: { valor: nf.valorNota, itens: nf.itens.length, end: e }, depois: { valor: depois.valorNota, itens: depois.itens.length, end: depois.contato.endereco, sit: depois.situacao } }); }
    catch (e) { res.status(500).json({ erro: erroTxt(e), body: e.response?.data }); }
  });
  // diagnóstico sem alterar nada: GET /nfe-rejeitadas/diagnostico?emp=mae&id=123
  app.get('/nfe-rejeitadas/diagnostico', async (req, res) => {
    try {
      const q = req.query, E = EMP.find(e => e.id === q.emp);
      const nf = q.cep ? { contato: { endereco: { cep: q.cep, bairro: q.bairro || '', municipio: q.municipio || '', uf: q.uf || '' } } }   // teste com endereço informado
                       : (await breq(bling.client(E.idx), 'get', '/nfe/' + q.id)).data?.data;
      res.json({ endereco: nf?.contato?.endereco, ...(await diagnosticar(nf)) });
    }
    catch (e) { res.status(500).json({ erro: erroTxt(e) }); }
  });
  setTimeout(() => rodarAuto().catch(() => {}), 90e3);
  setInterval(() => rodarAuto().catch(() => {}), 15 * 60e3).unref?.();
};
module.exports.diagnosticar = diagnosticar;
