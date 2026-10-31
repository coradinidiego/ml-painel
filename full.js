/**
 * Envio para o Full (Mercado Livre) — Zagodini e Com Amor de Mãe.
 *
 * Por SKU: estoque no Full (inventories/stock/fulfillment), vendas e lucro dos últimos 30 dias no ML
 * (mesma apuração da tela) e estoque do depósito Geral do Bling (sem os depósitos de Full).
 * A conta de quanto mandar (cobertura, prazo, margem mínima) é feita na tela, com os parâmetros editáveis.
 *
 *  GET  /full/plano          último resultado + andamento
 *  POST /full/plano/rodar    roda de novo (segundo plano, ~2–4 min)
 */
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');

const ARQ = path.join(DATA, 'apuracao_cache', 'full_plano.json');
const CONTAS = [{ idx: 0, emp: 'zagodini', nome: 'Zagodini' }, { idx: 1, emp: 'mae', nome: 'Com Amor de Mãe' }];
const ler = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const gravar = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch (e) {} };
const delay = ms => new Promise(r => setTimeout(r, ms));
const K = s => String(s || '').trim().toUpperCase();
const r2 = v => Math.round((+v || 0) * 100) / 100;
const hojeSP = () => new Date(Date.now() - 3 * 3600e3);
const ymd = d => d.toISOString().slice(0, 10);

let F = null, P = ler(ARQ, null), ST = { rodando: false, fase: null, erro: null };

async function paralelo(lista, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < lista.length) { const x = lista[i++]; await fn(x); } })); }

async function blingGet(c, url, params, tent = 0) {
  try { return (await c.get(url, { params, timeout: 30000 })).data; }
  catch (e) { if (e.response?.status === 429 && tent < 5) { await delay(1200 * (tent + 1)); return blingGet(c, url, params, tent + 1); } throw e; }
}

async function conta(ct) {
  const { idx, emp, nome } = ct, ml = F.ml;
  // 1) anúncios no Full (ativos e pausados — pausado costuma ser "sem estoque no Full")
  ST.fase = `${nome}: anúncios no Full`;
  const uid = (await ml(idx, '/users/me')).id, ids = new Set();
  for (const status of ['active', 'paused']) {
    let scroll = null;
    for (let k = 0; k < 60; k++) {
      const r = await ml(idx, `/users/${uid}/items/search`, { logistic_type: 'fulfillment', status, limit: 100, search_type: 'scan', ...(scroll ? { scroll_id: scroll } : {}) });
      (r.results || []).forEach(x => ids.add(x)); scroll = r.scroll_id;
      if (!(r.results || []).length) break;
    }
  }
  const L = [...ids], itens = [];
  for (let i = 0; i < L.length; i += 20) {
    const R = await ml(idx, '/items', { ids: L.slice(i, i + 20).join(','), attributes: 'id,title,price,status,inventory_id,attributes,variations,permalink,thumbnail' });
    for (const w of Array.isArray(R) ? R : [R]) {
      const x = w.body || w; if (!x?.id) continue;
      const sku = (x.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name || '';
      const vars = (x.variations || []).map(v => ({ inv: v.inventory_id, sku: (v.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name || '', nome: (v.attribute_combinations || []).map(a => a.value_name).join(' ') }));
      itens.push({ id: x.id, t: x.title, st: x.status, inv: x.inventory_id, sku, vars, thumb: x.thumbnail, link: x.permalink });
    }
  }
  // 2) estoque no Full por inventory
  ST.fase = `${nome}: estoque no Full`;
  const invs = [...new Set(itens.flatMap(x => x.vars.length ? x.vars.map(v => v.inv) : [x.inv]).filter(Boolean))], estoque = {};
  await paralelo(invs, 4, async inv => {
    try { const d = await ml(idx, `/inventories/${inv}/stock/fulfillment`); estoque[inv] = { disp: +d.available_quantity || 0, transf: (d.not_available_detail || []).filter(z => z.status === 'transfer').reduce((a, z) => a + (+z.quantity || 0), 0) }; }
    catch (e) { estoque[inv] = { disp: 0, transf: 0, erro: true }; }
  });
  // 3) agrupa por SKU (o mesmo SKU pode estar em mais de um anúncio do Full)
  const sk = {};
  for (const x of itens) {
    const units = x.vars.length ? x.vars.map(v => [v.sku, v.inv, v.nome]) : [[x.sku, x.inv, '']];
    for (const [sku, inv, vn] of units) {
      const key = K(sku) || ('SEM SKU · ' + x.id + (vn ? ' ' + vn : ''));
      const e = estoque[inv] || {}, s = sk[key] ||= { sku: sku || key, semSku: !sku, nome: x.t + (vn ? ' · ' + vn : ''), anuncios: [], full: 0, transf: 0, thumb: x.thumb, link: x.link };
      if (!s.anuncios.includes(x.id)) s.anuncios.push(x.id);
      s.full += e.disp || 0; s.transf += e.transf || 0;
    }
  }
  // 4) vendas e lucro dos últimos 30 dias no ML (mesma apuração da tela)
  ST.fase = `${nome}: vendas dos últimos 30 dias`;
  const fim = ymd(new Date(hojeSP().getTime() - 864e5)), ini = ymd(new Date(hojeSP().getTime() - 30 * 864e5));
  const res = await require('./apuracao_mkt').resultado({ emp, ini, fim, canal: 'Mercado Livre' });
  const vend = {};
  for (const l of res.linhas || []) {
    if (l.pedido === 'ADS' || !l.qtd) continue;
    const v = vend[K(l.sku)] ||= { sku: l.sku, nome: l.descricao, q: 0, rec: 0, luc: 0, ads: 0 };
    v.q += l.qtd; v.rec += l.receita; v.luc += l.lucro; v.ads += l.ads || 0;
  }
  // 5) estoque no depósito Geral do Bling (sem os depósitos de Full/Fulfillment)
  ST.fase = `${nome}: estoque no Bling`;
  const c = require('./bling').client(idx);
  const deps = (await blingGet(c, '/depositos')).data || [];
  const ign = new Set(deps.filter(d => d.desconsiderarSaldo || /full|fulfillment/i.test(d.descricao || '')).map(d => String(d.id)));
  const candidatos = Object.entries(vend).filter(([k, v]) => !sk[k] && v.q >= 4 && v.rec > 0).map(([k]) => k);
  const codigos = [...new Set([...Object.keys(sk).filter(k => !k.startsWith('SEM SKU')), ...candidatos])], blg = {};
  for (let i = 0; i < codigos.length; i += 40) {
    const params = new URLSearchParams({ limite: 100 }); codigos.slice(i, i + 40).forEach(cd => params.append('codigos[]', cd));
    const d = await blingGet(c, '/produtos?' + params.toString());
    for (const p of d.data || []) blg[K(p.codigo)] = { id: p.id, nome: p.nome };
    await delay(350);
  }
  const porId = Object.fromEntries(Object.entries(blg).map(([k, v]) => [String(v.id), k])), idsB = Object.keys(porId);
  for (let i = 0; i < idsB.length; i += 50) {
    const params = new URLSearchParams(); idsB.slice(i, i + 50).forEach(id => params.append('idsProdutos[]', id));
    const d = await blingGet(c, '/estoques/saldos?' + params.toString());
    for (const s of d.data || []) { const k = porId[String(s.produto?.id)]; if (k) blg[k].geral = (s.depositos || []).filter(x => !ign.has(String(x.id))).reduce((a, x) => a + (+x.saldoVirtual || 0), 0); }
    await delay(400);
  }
  const reposicao = Object.entries(sk).map(([k, s]) => { const v = vend[k] || {}; return { ...s, nome: blg[k]?.nome || s.nome, q: v.q || 0, rec: r2(v.rec), luc: r2(v.luc), geral: blg[k]?.geral ?? null }; });
  const novos = candidatos.map(k => { const v = vend[k]; return { sku: v.sku, nome: blg[k]?.nome || v.nome, q: v.q, rec: r2(v.rec), luc: r2(v.luc), ads: r2(v.ads), geral: blg[k]?.geral ?? null }; });
  return { emp, nome, idx, periodo: { ini, fim }, pendente: (res.pendentes || []).length > 0, reposicao, novos };
}

async function rodar() {
  if (ST.rodando) return; ST = { rodando: true, fase: 'iniciando', erro: null, inicio: new Date().toISOString() };
  try {
    const contas = [];
    for (const ct of CONTAS) contas.push(await conta(ct));
    P = { em: new Date().toISOString(), contas }; gravar(ARQ, P);
  } catch (e) { ST.erro = (e.response?.status ? e.response.status + ' ' : '') + (e.response?.data?.error?.description || e.response?.data?.message || e.message); console.warn('[full]', ST.erro); }
  ST.rodando = false; ST.fase = null;
}

module.exports = function (app, fontes) {
  F = fontes;
  const admin = (req, res) => { if (require('./auth').ativo() && !req.usuario?.admin) { res.status(403).json({ erro: 'só admin' }); return false; } return true; };
  app.get('/full/plano', (req, res) => res.json({ ...ST, plano: P }));
  app.post('/full/plano/rodar', (req, res) => { if (!admin(req, res)) return; rodar().catch(() => {}); res.json({ ok: true }); });
};
