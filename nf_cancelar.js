/**
 * NF-e para cancelar: pedido cancelado (pelo cliente/marketplace) que já tinha nota fiscal emitida e autorizada.
 * O Bling e o Tiny cancelam o pedido sozinhos, mas não a nota — ela fica autorizada até alguém cancelar à mão.
 *
 *  - Tiny (Lufe): pedidos com situação "cancelado" (últimos DIAS) × notas de saída autorizadas (6/7), pelo nº do pedido na loja
 *  - Bling (Zagodini, Mãe): pedidos com situação Cancelado (id 12) → nota do pedido → situação da NF-e (5/6/7 = autorizada)
 *      (precisa do escopo "Notas Fiscais" no app do Bling)
 *  - O prazo normal de cancelamento na SEFAZ é de 24 h depois da autorização; depois disso só cancelamento extemporâneo
 *  - Cada nota pendente vira um cartão no Trello (lista da Rafaela) e o cartão é concluído quando a nota aparece cancelada.
 *
 *  GET  /nfcancelar            situação
 *  POST /nfcancelar/atualizar
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const DATA = require('./dados');

const DIAS = 10;
const EMP = [
  { id: 'zagodini', nome: 'Zagodini', idx: 0, erp: 'Bling' },
  { id: 'mae', nome: 'Com Amor de Mae', idx: 1, erp: 'Bling' },
  { id: 'lufe', nome: 'Lufe', idx: 2, erp: 'Tiny' },
];
const ARQ = path.join(DATA, 'apuracao_cache', 'nf_cancelar.json');
const ARQ_TR = path.join(DATA, 'apuracao_cache', 'nf_cancelar_trello.json');
const lerJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const gravar = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch (e) {} };
const delay = ms => new Promise(r => setTimeout(r, ms));
const ST = lerJson(ARQ, {});
const TR = lerJson(ARQ_TR, {});
const br = d => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const iso = d => d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const deBr = s => { const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/); return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4] || '12'}:${m[5] || '00'}:00-03:00` : null; };

// ─── Tiny ───────────────────────────────────────────────────────────────────
async function tinyTodas(metodo, chave, params) {
  const tiny = require('./tiny'), out = [];
  for (let pagina = 1, total = 1; pagina <= total && pagina <= 30; pagina++) {
    const r = await tiny.chamar(metodo, { ...params, pagina });
    if (r.vazio) break;
    total = parseInt(r.numero_paginas || 1);
    out.push(...(r[chave] || []));
  }
  return out;
}
async function coletarTiny() {
  const desde = br(new Date(Date.now() - DIAS * 864e5));
  const canc = (await tinyTodas('pedidos.pesquisa.php', 'pedidos', { situacao: 'cancelado', dataInicial: desde })).map(x => x.pedido);
  const porLoja = new Map(canc.filter(p => p.numero_ecommerce).map(p => [String(p.numero_ecommerce), p]));
  const nfs = (await tinyTodas('notas.fiscais.pesquisa.php', 'notas_fiscais', { dataInicial: desde, tipoNota: 'S' })).map(x => x.nota_fiscal);
  const out = [];
  for (const n of nfs) {
    if (!['6', '7'].includes(String(n.situacao)) || n.tipo === 'E') continue;   // 6 autorizada, 7 emitida DANFE
    const p = porLoja.get(String(n.numero_ecommerce || ''));
    if (!p) continue;
    out.push({ chave: 'tiny|' + n.id, nf: n.numero, serie: n.serie, nfId: n.id, emissao: deBr(n.data_emissao), pedido: String(n.numero_ecommerce), pedidoErp: p.numero,
      cliente: n.nome, valor: +n.valor || null, canal: p.nome_ecommerce || null, link: 'https://erp.tiny.com.br/notas_fiscais#edit/' + n.id });
  }
  return out;
}

// ─── Bling ──────────────────────────────────────────────────────────────────
async function blingGet(c, url, tent = 5) {
  for (let t = 0; t < tent; t++) {
    try { return (await c.get(url, { timeout: 30000 })).data; }
    catch (e) { if (e.response?.status === 429 && t < tent - 1) { await delay(2500 * (t + 1)); continue; } throw e; }
  }
}
const NF_AUTORIZADA = new Set([5, 6, 7]);   // 5 autorizada, 6 emitida DANFE, 7 registrada
async function coletarBling(e, cache) {
  const c = require('./bling').client(e.idx);
  const desde = iso(new Date(Date.now() - DIAS * 864e5));
  const peds = [];
  for (let pagina = 1; pagina <= 30; pagina++) {
    const d = await blingGet(c, `/pedidos/vendas?limite=100&pagina=${pagina}&idsSituacoes[]=12&dataInicial=${desde}`);
    peds.push(...(d?.data || []));
    if ((d?.data || []).length < 100) break;
    await delay(350);
  }
  const out = [];
  for (const p of peds) {
    // o nº da nota do pedido não muda: guarda para não perguntar de novo a cada rodada
    let nfId = cache[p.id];
    if (nfId === undefined) {
      const d = await blingGet(c, '/pedidos/vendas/' + p.id); await delay(340);
      nfId = cache[p.id] = d?.data?.notaFiscal?.id || 0;
    }
    if (!nfId) continue;
    let nf;
    try { nf = (await blingGet(c, '/nfe/' + nfId))?.data; await delay(340); }
    catch (er) { if (er.response?.status === 403) throw Object.assign(new Error('o app do Bling não tem permissão de Notas Fiscais'), { semEscopo: true }); throw er; }
    if (!nf || !NF_AUTORIZADA.has(Number(nf.situacao))) continue;
    out.push({ chave: 'bling' + e.idx + '|' + nfId, nf: nf.numero, serie: nf.serie, nfId, emissao: nf.dataEmissao ? new Date(nf.dataEmissao.replace(' ', 'T') + '-03:00').toISOString() : null,
      pedido: String(p.numeroLoja || p.numero), pedidoErp: p.numero, cliente: p.contato?.nome || nf.contato?.nome || '', valor: +p.total || null,
      link: 'https://www.bling.com.br/notas.fiscais.php#edit/' + nfId });
  }
  return out;
}

// ─── Trello (lista da Rafaela) ─────────────────────────────────────────────
const trOk = () => !!(process.env.TRELLO_KEY && process.env.TRELLO_TOKEN);
const trello = async (metodo, caminho, params = {}) => (await axios({ method: metodo, url: 'https://api.trello.com/1' + caminho,
  params: { key: process.env.TRELLO_KEY.trim(), token: process.env.TRELLO_TOKEN.trim(), ...params }, timeout: 20000 })).data;
async function sincronizarTrello() {
  if (!trOk()) return null;
  const pend = new Map(), ok = new Set();
  for (const e of EMP) { const R = ST[e.id]; if (!R) continue; if (!R.erro) ok.add(e.id); for (const x of R.itens || []) pend.set(x.chave, { ...x, emp: e }); }
  for (const [chave, x] of pend) {
    if (TR[chave] && !TR[chave].resolvido) continue;
    const venc = x.emissao ? new Date(Date.parse(x.emissao) + 24 * 3600e3) : null;
    const desc = [`Pedido cancelado com NF-e ainda autorizada no ${x.emp.erp}. Cancelar a nota.`, `NF-e: ${x.nf}${x.serie ? ' série ' + x.serie : ''}`,
      x.emissao ? `Emitida: ${new Date(x.emissao).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })} (prazo normal da SEFAZ: 24 h)` : null,
      `Venda: ${x.pedido}${x.pedidoErp ? ' (pedido ' + x.pedidoErp + ' no ' + x.emp.erp + ')' : ''}`, x.cliente ? `Cliente: ${x.cliente}` : null, x.valor ? `Valor: R$ ${x.valor.toFixed(2).replace('.', ',')}` : null,
      `Abrir no ${x.emp.erp}: ${x.link}`, '', '(criado automaticamente pelo painel)'].filter(v => v !== null).join('\n');
    const card = await trello('post', '/cards', { idList: process.env.TRELLO_LISTA || '69e8e3565598d810d650ddc8', idMembers: process.env.TRELLO_MEMBRO || '69e931078c84db34c843a722',
      name: `${x.emp.nome} - Cancelar NF ${x.nf} (venda ${x.pedido})`, desc, pos: 'top', ...(venc ? { due: venc.toISOString() } : {}) });
    TR[chave] = { card: card.id, url: card.shortUrl, em: new Date().toISOString(), emp: x.emp.id };
    gravar(ARQ_TR, TR);
  }
  for (const [chave, t] of Object.entries(TR)) {
    if (t.resolvido || pend.has(chave) || !ok.has(t.emp)) continue;
    try { await trello('put', '/cards/' + t.card, { dueComplete: true }); await trello('post', '/cards/' + t.card + '/actions/comments', { text: '✅ Nota cancelada (conferido pelo painel).' }); }
    catch (er) { if (er.response?.status !== 404) throw er; }
    t.resolvido = new Date().toISOString(); gravar(ARQ_TR, TR);
  }
  for (const [k, t] of Object.entries(TR)) if (t.resolvido && Date.now() - Date.parse(t.resolvido) > 90 * 864e5) delete TR[k];
  gravar(ARQ_TR, TR);
  return null;
}

module.exports = function montar(app) {
  let rodando = false, trErro = null;
  const cachePed = lerJson(path.join(DATA, 'apuracao_cache', 'nf_cancelar_pedidos.json'), {});
  async function atualizar() {
    if (rodando) return; rodando = true;
    try {
      for (const e of EMP) {
        const R = ST[e.id] ||= {};
        try {
          R.itens = e.erp === 'Tiny' ? await coletarTiny() : await coletarBling(e, cachePed[e.idx] ||= {});
          R.erro = null; R.semEscopo = false;
        } catch (er) { R.erro = er.message; R.semEscopo = !!er.semEscopo; }
        R.em = new Date().toISOString();
        gravar(ARQ, ST);
        gravar(path.join(DATA, 'apuracao_cache', 'nf_cancelar_pedidos.json'), cachePed);
      }
      try { await sincronizarTrello(); trErro = null; } catch (er) { trErro = er.message; console.warn('[nf_cancelar/trello]', er.message); }
    } finally { rodando = false; }
  }
  setTimeout(() => atualizar().catch(er => console.warn('[nf_cancelar]', er.message)), 150e3);
  setInterval(() => atualizar().catch(er => console.warn('[nf_cancelar]', er.message)), 30 * 60e3).unref?.();
  app.get('/nfcancelar', (req, res) => res.json({ rodando, trelloErro: trErro, empresas: Object.fromEntries(EMP.map(e => [e.id, { erp: e.erp, ...(ST[e.id] || {}) }])) }));
  app.post('/nfcancelar/atualizar', (req, res) => { atualizar().catch(() => {}); res.json({ ok: true }); });
};
