/**
 * Mercado Turbo — conferência de custo/imposto por SKU (somente leitura; nada é enviado ao Turbo).
 * Fonte do Turbo: a exportação "atributos-produtos" (CSV  CUSTO;IMPOSTO;SKU) importada na aba Custos × Turbo.
 * Compara Turbo × ERP (Bling/Tiny) × planilha de precificação, e o imposto do Turbo × o do painel.
 *
 *  GET  /turbo/:idx        lista
 *  POST /turbo/:idx/csv    { csv: "texto" }   importa a exportação do Turbo
 *  POST /turbo/:idx/enviar  { itens: [{ sku, custo, imposto? }] }   grava custo/imposto de SKUs escolhidos (admin, a pedido)
 *    API do Turbo: POST https://app.mercadoturbo.com.br/rest/produtos/sku/{sku} {custo, imposto%} · header Authentication = MT_TOKEN_<CONTA>
 */
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');
const custos = require('./custos_ml');

const arqCsv = idx => path.join(DATA, 'apuracao_cache', `turbo_csv_${idx}.json`);
const lerJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const gravar = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch (e) {} };
const r2 = v => Math.round(v * 100) / 100;
const num = v => { const s = String(v ?? '').trim(); if (!s) return null; const n = parseFloat(/,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')); return isNaN(n) ? null : n; };
const dif = (a, b) => a != null && b != null && Math.abs(a - b) > Math.max(0.05, Math.abs(b) * 0.01);

function lerCsv(txt) {
  const linhas = String(txt || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (!linhas.length) throw new Error('arquivo vazio');
  const sep = linhas[0].includes(';') ? ';' : ',';
  const cab = linhas[0].split(sep).map(c => c.trim().toUpperCase().replace(/"/g, ''));
  const iS = cab.indexOf('SKU'), iC = cab.indexOf('CUSTO'), iI = cab.indexOf('IMPOSTO');
  if (iS < 0 || iC < 0) throw new Error('cabeçalho precisa ter SKU e CUSTO');
  const mapa = {};
  for (const l of linhas.slice(1)) {
    const c = l.split(sep).map(x => x.trim().replace(/^"|"$/g, ''));
    if (!c[iS]) continue;
    mapa[c[iS]] = { custo: num(c[iC]), imposto: iI >= 0 ? num(c[iI]) : null };
  }
  return mapa;
}

function skusDaConta(d) {
  const set = new Map();
  const arr = k => Array.isArray(d?.[k]) ? d[k] : [];
  for (const it of ['semPromo', 'comPromo', 'perdendo', 'ganhando', 'atualizando'].flatMap(arr)) {
    if (!it || typeof it !== 'object') continue;
    const add = s => { s = String(s || '').trim(); if (s && !set.has(s)) set.set(s, { titulo: it.title, mlb: it.id }); };
    add(it._sku || it.seller_sku || it.seller_custom_field);
    for (const v of it.variations || []) { add(v.seller_custom_field); add((v.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name); }
  }
  return set;
}

module.exports = function (app, { dadosCache }) {
  app.post('/turbo/:idx/csv', require('express').json({ limit: '10mb' }), (req, res) => {
    const idx = +req.params.idx; if (![0, 1, 2].includes(idx)) return res.status(400).json({ erro: 'conta inválida' });
    try { const mapa = lerCsv(req.body?.csv); gravar(arqCsv(idx), { em: new Date().toISOString(), arquivo: req.body?.nome || '', mapa }); res.json({ ok: true, skus: Object.keys(mapa).length }); }
    catch (e) { res.status(400).json({ erro: e.message }); }
  });

  app.get('/turbo/:idx', async (req, res) => { try {
    const idx = +req.params.idx; if (![0, 1, 2].includes(idx)) return res.status(400).json({ erro: 'conta inválida' });
    const d = dadosCache[idx];
    const tb = lerJson(arqCsv(idx), null);
    const erp = await custos.custosErp(idx);
    const imp = Math.round(custos.aliquota(idx) * 1000) / 10;
    const anuncios = skusDaConta(d);
    const skus = new Set([...Object.keys(tb?.mapa || {}), ...anuncios.keys()]);
    const itens = [];
    for (const sku of skus) {
      const t = tb?.mapa?.[sku] || null, a = anuncios.get(sku);
      const cf = custos.custoComFonte(idx, sku, erp);
      const vErp = cf && cf.fonte !== 'planilha' ? r2(cf.v) : null;
      const p = custos.custoSku(idx, sku), vPlan = p > 0 ? r2(p) : null;
      const vTb = t?.custo > 0 ? r2(t.custo) : null;
      itens.push({
        sku, titulo: a?.titulo || '', mlb: a?.mlb || null, anuncio: !!a,
        turbo: vTb, turboImp: t?.imposto ?? null, noTurbo: !!t,
        erp: vErp, planilha: vPlan,
        difErp: dif(vTb, vErp), difPlan: dif(vTb, vPlan), difErpPlan: dif(vErp, vPlan),
        difImp: t?.imposto != null && Math.abs(t.imposto - imp) > 0.01,
        delta: vTb != null && (vErp ?? vPlan) != null ? r2(vTb - (vErp ?? vPlan)) : null,
      });
    }
    res.json({ conta: d?.nickname || '', erp: idx === 2 ? 'Tiny' : 'Bling', imposto: imp, importado: tb ? { em: tb.em, arquivo: tb.arquivo, skus: Object.keys(tb.mapa).length } : null, itens });
  } catch (e) { res.status(500).json({ erro: e.message }); } });
  const TOKENS = { 0: 'MT_TOKEN_ZAGODINI', 1: 'MT_TOKEN_MAE', 2: 'MT_TOKEN_LUFE' };
  app.post('/turbo/:idx/enviar', require('express').json(), async (req, res) => {
    if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
    const idx = +req.params.idx, tok = String(process.env[TOKENS[idx]] || '').trim().replace(/^["']|["']$/g, '');
    if (!tok) return res.status(400).json({ erro: `falta a variável ${TOKENS[idx]} no Railway` });
    const itens = (req.body?.itens || []).filter(x => x?.sku && +x.custo > 0).slice(0, 200), out = [];
    for (const x of itens) {
      const body = { custo: r2(+x.custo) }; if (x.imposto != null) body.imposto = +x.imposto;
      try {
        const r = await require('axios').post('https://app.mercadoturbo.com.br/rest/produtos/sku/' + encodeURIComponent(x.sku), body,
          { headers: { 'Content-Type': 'application/json', Authentication: tok }, timeout: 20000, validateStatus: () => true });
        out.push({ sku: x.sku, ...body, http: r.status, resposta: typeof r.data === 'string' ? r.data.slice(0, 200) : JSON.stringify(r.data || '').slice(0, 200) });
      } catch (e) { out.push({ sku: x.sku, ...body, http: 0, resposta: e.message }); }
      await new Promise(z => setTimeout(z, 400));
    }
    res.json({ ok: true, enviados: out });
  });
};
