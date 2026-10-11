/**
 * Margem dos anúncios de catálogo: lucro % no preço atual e no "preço para ganhar".
 *
 *  lucro = preço − custo do produto − tarifa de venda do ML (comissão + taxa fixa)
 *          − embalagem − custo de envio do vendedor (ML cobra por peso/faixa de preço, inclusive abaixo de R$ 79) − imposto
 *
 *  - Custo: ERP primeiro — Bling (Zagodini, Com Amor de Mãe) / Tiny (Lufe), preço de custo do produto;
 *           planilha de precificação só como reserva para SKUs sem custo no ERP.
 *  - Tarifa: API do ML /sites/MLB/listing_prices (por preço, tipo de anúncio e categoria).
 *  - Frete: API do ML /users/{id}/shipping_options/free (custo do vendedor no anúncio).
 *  - Imposto e embalagem: config_empresas.js (página Conta).
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const DATA = require('./dados');

const PLANILHAS = {
  0: 'Precificacao Comercial Zagodini.xlsx',
  1: 'Precificacao Atelie Com S2 de Mãe.xlsx',
  2: 'Precificacao Nova.xlsx',
};
const K = v => (v === null || v === undefined || v === '') ? null : String(v).trim().toUpperCase();
const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? null : n; };

// ─── Custos por SKU a partir da planilha ───────────────────────────────────
const _custos = {};
function custosConta(idx) {
  const arq = path.join(DATA, PLANILHAS[idx] || '');
  let mtime; try { mtime = fs.statSync(arq).mtimeMs; } catch (e) { return null; }
  if (_custos[idx]?.mtime === mtime) return _custos[idx].mapa;
  const wb = XLSX.readFile(arq);
  const mapa = {};
  // abas do ML primeiro (composição de kit igual à do anúncio), depois Base, depois as demais
  const ordem = [...wb.SheetNames].sort((a, b) => peso(a) - peso(b));
  function peso(n) { return /ml|full|mercado/i.test(n) ? 0 : /base|custo/i.test(n) ? 1 : 2; }
  for (const aba of ordem) {
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, raw: true, defval: null });
    // acha a linha de cabeçalho (até a 8ª) com uma coluna de código
    let h = -1, cCod = -1, cTot = -1, cUn = -1, cQtd = -1;
    for (let i = 0; i < Math.min(8, linhas.length) && h < 0; i++) {
      const r = linhas[i] || [];
      const idxCod = r.findIndex(c => /^(c[oó]d(igo)?|sku)$/i.test(String(c || '').trim()));
      if (idxCod < 0) continue;
      h = i; cCod = idxCod;
      r.forEach((c, j) => {
        const t = String(c || '').trim();
        if (cTot < 0 && /^custo\s*total$/i.test(t)) cTot = j;
        if (cUn < 0 && /^(custo\s*(un|und|unit[aá]rio)\.?|unit[aá]rio)$/i.test(t)) cUn = j;
        if (cQtd < 0 && /^(qtd|qnde|quantidade)$/i.test(t)) cQtd = j;
      });
    }
    if (h < 0 || (cTot < 0 && cUn < 0)) continue;
    for (const r of linhas.slice(h + 1)) {
      const sku = K(r[cCod]); if (!sku || sku in mapa) continue;
      const q = num(r[cQtd]) || 1, tot = num(r[cTot]), un = num(r[cUn]);
      const custo = tot > 0 ? tot : (un > 0 ? un * q : null);
      if (custo) mapa[sku] = custo;
    }
  }
  _custos[idx] = { mtime, mapa };
  return mapa;
}
// ─── Custos do ERP (Bling / Tiny), cache de 6h em memória e em disco ───────
const _erp = {};
async function custosErp(idx) {
  const arq = path.join(DATA, 'apuracao_cache', `custos_erp_v2_${idx}.json`);
  if (!_erp[idx]) { try { _erp[idx] = JSON.parse(fs.readFileSync(arq)); } catch (e) { _erp[idx] = { ts: 0, mapa: {} }; } }
  if (Date.now() - _erp[idx].ts < 6 * 3600e3) return _erp[idx].mapa;
  const mapa = {};
  try {
    if (idx === 2) {
      // Tiny: mapeia pelo código e pelo GTIN/EAN (os anúncios da Lufe no ML usam o EAN como SKU)
      const tiny = require('./tiny');
      for (let pagina = 1, total = 1; pagina <= total && pagina <= 50; pagina++) {
        const ret = await tiny.chamar('produtos.pesquisa.php', { pesquisa: '', pagina });
        if (ret.vazio) break;
        total = parseInt(ret.numero_paginas || 1);
        for (const x of ret.produtos || []) {
          const p = x.produto || {};
          const c = num(p.preco_custo) > 0 ? num(p.preco_custo) : num(p.preco_custo_medio);
          if (!(c > 0)) continue;
          if (p.codigo) mapa[K(p.codigo)] = c;
          if (p.gtin) mapa[K(p.gtin)] = c;
        }
        await new Promise(r => setTimeout(r, 1100));
      }
    } else {
      const b = await require('./bling').getCustosPorSku(idx);
      for (const [sku, c] of Object.entries(b)) if (c > 0) mapa[K(sku)] = c;
    }
    _erp[idx] = { ts: Date.now(), mapa };
    try { fs.mkdirSync(path.dirname(arq), { recursive: true }); fs.writeFileSync(arq, JSON.stringify(_erp[idx])); } catch (e) {}
  } catch (e) { console.warn('[custos ERP]', idx, e.message); }  // falhou: mantém o último cache
  return _erp[idx].mapa;
}

function procurar(mapa, sku) {
  if (!mapa || !sku) return null;
  const s = K(sku);
  if (mapa[s] > 0) return mapa[s];
  const semZeros = s.replace(/^0+/, ''); if (mapa[semZeros] > 0) return mapa[semZeros];
  const m = s.match(/^(.*)-(\d+)$/);                    // kit "SKU-3" = 3 × SKU
  if (m && mapa[m[1]] > 0) return mapa[m[1]] * parseInt(m[2]);
  return null;
}
/** Custo do SKU: ERP primeiro, planilha de reserva. Retorna { v, fonte } ou null. */
function custoComFonte(idx, sku, erp) {
  const e = procurar(erp, sku); if (e != null) return { v: e, fonte: idx === 2 ? 'Tiny' : 'Bling' };
  const p = procurar(custosConta(idx), sku); if (p != null) return { v: p, fonte: 'planilha' };
  return null;
}

function custoSku(idx, sku) {
  const mapa = custosConta(idx); if (!mapa || !sku) return null;
  const s = K(sku);
  if (s in mapa) return mapa[s];
  const semZeros = s.replace(/^0+/, ''); if (semZeros in mapa) return mapa[semZeros];
  const m = s.match(/^(.*)-(\d+)$/);                    // kit "SKU-3" = 3 × SKU
  if (m && m[1] in mapa) return mapa[m[1]] * parseInt(m[2]);
  return null;
}

function aliquota(idx) { return require('./config_empresas').porMlIdx(idx)?.imposto ?? (idx === 2 ? 0.05 : idx === 0 ? 0.11 : 0.09); }
function embalagem(idx) { return require('./config_empresas').porMlIdx(idx)?.embalagem ?? 0; }

// ─── Tarifas e frete do ML (com cache) ─────────────────────────────────────
const _tarifa = new Map(), _frete = new Map();
async function tarifaML(ml, idx, preco, tipo, categoria) {
  const k = `${preco.toFixed(2)}|${tipo}|${categoria}`;
  if (_tarifa.has(k)) return _tarifa.get(k);
  const r = await ml(idx, '/sites/MLB/listing_prices', { price: preco.toFixed(2), listing_type_id: tipo, category_id: categoria });
  const linha = Array.isArray(r) ? r.find(x => x.listing_type_id === tipo) || r[0] : r;
  const v = num(linha?.sale_fee_amount) ?? null;
  if (v != null) _tarifa.set(k, v);
  return v;
}
async function freteML(ml, idx, uid, itemId) {
  const c = _frete.get(itemId);
  if (c && Date.now() - c.ts < 6 * 3600e3) return c.v;
  try {
    const r = await ml(idx, `/users/${uid}/shipping_options/free`, { item_id: itemId });
    const v = num(r?.coverage?.all_country?.list_cost) ?? 0;
    _frete.set(itemId, { v, ts: Date.now() });
    return v;
  } catch (e) { return null; }
}

/**
 * Preenche em cada item perdendo: lucro_atual_pct, lucro_ptw_pct, lucro_ptw (R$), custo_produto, e margem_obs.
 * `ml` é a função do server.js que chama a API do ML com o token da conta.
 */
async function calcularMargens(ml, idx, uid, itens) {
  const imp = aliquota(idx), emb = embalagem(idx);
  const erp = await custosErp(idx);
  for (const it of itens) {
    try {
      const cf = custoComFonte(idx, it._sku || it.seller_sku, erp);
      if (!cf) { it.margem_obs = 'sem custo no ' + (idx === 2 ? 'Tiny' : 'Bling') + ' nem na planilha'; continue; }
      const custo = cf.v; it.custo_fonte = cf.fonte;
      if (!it.listing_type_id || !it.category_id) { it.margem_obs = 'sem dados do anúncio'; continue; }
      const freteBase = await freteML(ml, idx, uid, it.id);
      const calc = async preco => {
        if (!(preco > 0)) return null;
        const tarifa = await tarifaML(ml, idx, preco, it.listing_type_id, it.category_id);
        if (tarifa == null) return null;
        const frete = freteBase || 0;   // custo de envio do vendedor (o ML cobra também abaixo de R$ 79, por peso/faixa de preço)
        const lucro = preco - custo - tarifa - frete - emb - preco * imp;
        return { lucro, pct: lucro / preco * 100, tarifa, frete };
      };
      const atual = await calc(it.current_price);
      const ganhar = await calc(it.price_to_win);
      it.custo_produto = custo;
      if (atual) it.lucro_atual_pct = Math.round(atual.pct * 10) / 10;
      if (ganhar) { it.lucro_ptw_pct = Math.round(ganhar.pct * 10) / 10; it.lucro_ptw = Math.round(ganhar.lucro * 100) / 100; it.tarifa_ptw = ganhar.tarifa; it.frete_ptw = ganhar.frete; }
      it.imposto_pct = Math.round(imp * 1000) / 10; it.embalagem = emb;
    } catch (e) { it.margem_obs = 'erro ao calcular'; }
  }
}

module.exports = { calcularMargens, custoSku, custosConta, custosErp, custoComFonte, aliquota };
