/**
 * Configuração por empresa: imposto (%) e custo de embalagem por pedido (R$).
 * Fonte única — o imposto continua gravado onde as apurações já leem:
 *   Zagodini / Com Amor de Mãe → impostos.json {0, 1}   (apuração Bling)
 *   Magazine Lufe              → tiny_lufe_config.json   (apuração Tiny)
 * A embalagem fica em config_empresas.json.
 */
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');

const ARQ = path.join(DATA, 'config_empresas.json');
const ARQ_IMP = path.join(DATA, 'impostos.json');
const ARQ_TINY = path.join(DATA, 'tiny_lufe_config.json');
const EMPRESAS = [
  { id: 'lufe',     nome: 'Magazine Lufe',   mlIdx: 2, impPadrao: 0.05, embPadrao: 0.50 },
  { id: 'zagodini', nome: 'Zagodini',        mlIdx: 0, impPadrao: 0.11, embPadrao: 0.15 },
  { id: 'mae',      nome: 'Com Amor de Mãe', mlIdx: 1, impPadrao: 0.09, embPadrao: 0.15 },
];
const ler = f => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return {}; } };

function get() {
  const emb = ler(ARQ), imp = ler(ARQ_IMP), tiny = ler(ARQ_TINY);
  return EMPRESAS.map(e => ({
    ...e,
    imposto: e.id === 'lufe' ? (tiny.imposto ?? e.impPadrao) : (imp[e.mlIdx] ?? e.impPadrao),
    embalagem: emb[e.id]?.embalagem ?? e.embPadrao,
  }));
}
function porMlIdx(idx) { return get().find(e => e.mlIdx === idx); }

/** valores: { lufe: {imposto: 0.05, embalagem: 0.5}, ... } (imposto em fração) */
function set(valores) {
  const emb = ler(ARQ), imp = ler(ARQ_IMP), tiny = ler(ARQ_TINY);
  for (const e of EMPRESAS) {
    const v = valores[e.id]; if (!v) continue;
    if (v.imposto != null && v.imposto >= 0 && v.imposto < 1) {
      if (e.id === 'lufe') tiny.imposto = v.imposto; else imp[e.mlIdx] = v.imposto;
    }
    if (v.embalagem != null && v.embalagem >= 0) emb[e.id] = { embalagem: v.embalagem };
  }
  fs.writeFileSync(ARQ, JSON.stringify(emb, null, 2));
  fs.writeFileSync(ARQ_IMP, JSON.stringify(imp));
  fs.writeFileSync(ARQ_TINY, JSON.stringify({ imposto: 0.05, mlComissao: 0.115, ...tiny }, null, 2));
  process.emit('config-empresas');   // server.js recarrega as alíquotas da apuração Bling em memória
  return get();
}

module.exports = { get, set, porMlIdx, EMPRESAS };
