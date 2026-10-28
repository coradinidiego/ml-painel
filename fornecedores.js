/**
 * Fornecedor de cada SKU (para a apuração "por fornecedor").
 *  - Bling (Zagodini 0, Mãe 1): /produtos (id → código) + /produtos/fornecedores (produto → fornecedor padrão) + /contatos/{id} (nome)
 *  - Tiny (Lufe 2): gravado pela importação da API v3 (tiny3.js) — fornecedor do produto ou, sem ele, a marca
 * Cache em disco: apuracao_cache/fornecedores_{idx}.json  { em, mapa: { SKU: nome } }  — atualiza 1x por dia.
 */
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');

const arq = idx => path.join(DATA, 'apuracao_cache', `fornecedores_${idx}.json`);
const ler = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const gravar = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch (e) {} };
const delay = ms => new Promise(r => setTimeout(r, ms));
const K = s => String(s || '').trim().toUpperCase();
const _c = {};
const cache = idx => (_c[idx] ||= ler(arq(idx), { em: null, mapa: {} }));

async function req(c, url, params) {
  for (let t = 0; ; t++) {
    try { await delay(380); return (await c.get(url, { params })).data?.data || []; }
    catch (e) { if (e.response?.status === 429 && t < 6) { await delay(2000 * (t + 1)); continue; } throw e; }
  }
}

let rodando = {};
async function atualizarBling(idx) {
  if (rodando[idx]) return; rodando[idx] = true;
  try {
    const c = require('./bling').client(idx), cod = {}, forn = {}, nomes = {}, antigos = cache(idx).nomes || {};
    for (let pagina = 1; pagina <= 200; pagina++) {
      const L = await req(c, '/produtos', { limite: 100, pagina });
      for (const p of L) if (p.id && p.codigo) cod[p.id] = p.codigo;
      if (L.length < 100) break;
    }
    for (let pagina = 1; pagina <= 200; pagina++) {
      const L = await req(c, '/produtos/fornecedores', { limite: 100, pagina });
      for (const x of L) { const pid = x.produto?.id, fid = x.fornecedor?.id; if (!pid || !fid) continue; if (!forn[pid] || x.padrao) forn[pid] = fid; }
      if (L.length < 100) break;
    }
    for (const fid of new Set(Object.values(forn))) {
      let nome = null;
      for (let t = 0; t < 6 && !nome; t++) {
        try { const d = (await c.get('/contatos/' + fid)).data?.data; nome = (d?.fantasia || d?.nome || '').trim() || null; if (!nome) break; }
        catch (e) { if (e.response?.status === 429) { await delay(2000 * (t + 1)); continue; } break; }
      }
      nomes[fid] = nome || antigos[fid] || ('Fornecedor ' + fid);
      await delay(400);
    }
    const mapa = {};
    for (const [pid, fid] of Object.entries(forn)) if (cod[pid]) mapa[K(cod[pid])] = nomes[fid];
    _c[idx] = { em: new Date().toISOString(), mapa, nomes };
    gravar(arq(idx), _c[idx]);
    console.log('[fornecedores]', idx, Object.keys(mapa).length, 'SKUs,', Object.keys(nomes).length, 'fornecedores');
  } catch (e) { console.warn('[fornecedores]', idx, e.message); }
  rodando[idx] = false;
}

/** grava o mapa do Tiny (chamado pela importação v3) */
function gravarTiny(mapa) { _c[2] = { em: new Date().toISOString(), mapa }; gravar(arq(2), _c[2]); }

/** fornecedor do SKU (kit "X-3" / combinação "A-B" → do produto base) */
function fornecedor(idx, sku) {
  const m = cache(idx).mapa, s = K(sku);
  if (m[s]) return m[s];
  const b = s.replace(/^0+/, ''); if (m[b]) return m[b];
  const k = s.match(/^(.*)-\d+$/); if (k && m[k[1]]) return m[k[1]];
  const partes = s.split(/[-_]/).filter(Boolean), f = partes.map(p => m[p]).filter(Boolean);
  if (f.length && f.every(x => x === f[0])) return f[0];
  if (f.length) return 'Vários';
  return null;
}

function iniciar() {
  const ver = () => { for (const i of [0, 1]) { const c = cache(i); if (!c.em || Date.now() - Date.parse(c.em) > 22 * 3600e3) atualizarBling(i).catch(() => {}); } };
  setTimeout(ver, 90e3);
  setInterval(ver, 3 * 3600e3).unref?.();
}

function rotas(app) { app.post('/fornecedores/atualizar', (req, res) => { for (const i of [0, 1]) atualizarBling(i).catch(() => {}); res.json({ ok: true }); }); }
module.exports = { rotas, fornecedor, gravarTiny, atualizarBling, iniciar, cache };
