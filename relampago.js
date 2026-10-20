/**
 * Oferta Relâmpago da Loja (Shopee) automática — uma por dia em cada loja, só para registro:
 *   - preço = preço da promoção de desconto que já está ativa no item − R$ 0,01
 *   - 5 unidades por variação (a Shopee reserva o saldo da relâmpago e não atualiza o estoque enquanto ela dura)
 *   - só entram variações com 15+ unidades no estoque do vendedor
 *   - item sem promoção de desconto ativa não entra (ex.: mamadeiras, que não podem ter promoção)
 *   - até 20 itens por relâmpago; revezando: entram primeiro os que estão há mais tempo sem relâmpago
 *
 *  Roda de hora em hora: para cada horário de relâmpago das próximas 30h que ainda não tem relâmpago criada, cria.
 *  GET  /shopee/relampago?loja=mae            situação + prévia do que entraria na próxima
 *  POST /shopee/relampago/rodar?loja=mae      cria agora (admin)
 *  POST /shopee/relampago/ativo?loja=mae&ativo=1|0
 */
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');
const shopee = require('./shopee');

const ARQ = path.join(DATA, 'shopee_relampago.json');
const CFG = { precoMenos: 0.01, qtd: 5, estoqueMin: 15, maxItens: 20, janelaH: 30 };
const PROIBIDO = /^\s*(mamadeira|chupeta|bico)\b/i;   // não podem ter promoção (garantia extra além da regra do desconto)
const delay = ms => new Promise(r => setTimeout(r, ms));

let ST = (() => { try { return JSON.parse(fs.readFileSync(ARQ)); } catch (e) { return {}; } })();
const salvar = () => { try { fs.writeFileSync(ARQ, JSON.stringify(ST, null, 1)); } catch (e) { console.warn('[relampago]', e.message); } };
const estado = k => (ST[k] ||= { ativo: false, usados: {}, historico: [] });
const r2 = v => Math.round(v * 100) / 100;
const dataSP = ts => new Date(ts * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

async function todosItens(sp) {
  const ids = [];
  for (let offset = 0; ids.length < 3000;) {
    const d = await sp.shopeeGet('/api/v2/product/get_item_list', { offset, page_size: 100, item_status: 'NORMAL' });
    ids.push(...(d.response?.item || []).map(i => i.item_id));
    if (!d.response?.has_next_page) break;
    offset = d.response.next_offset;
  }
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await sp.shopeeGet('/api/v2/product/get_item_base_info', { item_id_list: ids.slice(i, i + 50).join(',') });
    out.push(...(d.response?.item_list || []));
    await delay(150);
  }
  return out;
}
// estoque real do vendedor (o "disponível" fica distorcido enquanto há relâmpago em andamento)
const estoqueVendedor = si => (si?.seller_stock || []).reduce((s, x) => s + (+x.stock || 0), 0);

/** Monta a lista de itens/variações para uma relâmpago que vai de `ini` a `fim` (segundos). */
async function montar(k, ini, fim) {
  const sp = shopee.loja(k), st = estado(k);
  const itens = (await todosItens(sp)).filter(i => !PROIBIDO.test(i.item_name || ''));
  // preço da promoção de desconto que estará valendo durante a relâmpago
  const desc = {};   // item_id -> { model_id|0 -> preço }
  for (let i = 0; i < itens.length; i += 50) {
    const d = await sp.shopeeGet('/api/v2/product/get_item_promotion', { item_id_list: itens.slice(i, i + 50).map(x => x.item_id).join(',') });
    for (const it of d.response?.success_list || []) for (const p of it.promotion || []) {
      if (p.promotion_type !== 'Discount Promotions' || !(p.start_time <= ini && p.end_time >= fim)) continue;
      const preco = p.promotion_price_info?.[0]?.promotion_price;
      if (preco > 0) (desc[it.item_id] ||= {})[p.model_id || 0] = preco;
    }
    await delay(150);
  }
  const cand = [];
  for (const it of itens) {
    const precos = desc[it.item_id];
    if (!precos) continue;
    const models = [];
    if (it.has_model) {
      const d = await sp.shopeeGet('/api/v2/product/get_model_list', { item_id: it.item_id });
      const tiers = d.response?.tier_variation || [];
      for (const m of d.response?.model || []) {
        const est = estoqueVendedor(m.stock_info_v2), preco = precos[m.model_id];
        if (preco && est >= CFG.estoqueMin) models.push({ model_id: m.model_id, nome: (m.tier_index || []).map((ix, t) => tiers[t]?.option_list?.[ix]?.option).filter(Boolean).join(' / '), promo: preco, preco: r2(preco - CFG.precoMenos), estoque: est, qtd: CFG.qtd });
      }
      await delay(120);
      if (!models.length) continue;
    } else {
      const est = estoqueVendedor(it.stock_info_v2), preco = precos[0];
      if (!preco || est < CFG.estoqueMin) continue;
      models.push({ model_id: 0, nome: '', promo: preco, preco: r2(preco - CFG.precoMenos), estoque: est, qtd: CFG.qtd });
    }
    cand.push({ item_id: it.item_id, nome: it.item_name, models, ultimo: st.usados[it.item_id] || 0, estoque: Math.max(...models.map(m => m.estoque)) });
  }
  // revezamento: há mais tempo sem relâmpago primeiro; empate = mais estoque
  cand.sort((a, b) => a.ultimo - b.ultimo || b.estoque - a.estoque);
  return { candidatos: cand.length, itens: cand.slice(0, CFG.maxItens) };
}

/** Horários das próximas `janelaH` horas e as relâmpagos já existentes (programadas/em andamento). */
async function horarios(k) {
  const sp = shopee.loja(k), agora = Math.floor(Date.now() / 1000);
  const slots = (await sp.shopeeGet('/api/v2/shop_flash_sale/get_time_slot_id', { start_time: agora + 60, end_time: agora + CFG.janelaH * 3600 })).response || [];
  const ocupados = new Set();
  for (const type of [1, 2]) {   // 1 = programada, 2 = em andamento
    const d = await sp.shopeeGet('/api/v2/shop_flash_sale/get_shop_flash_sale_list', { type, offset: 0, limit: 100 });
    for (const f of d.response?.flash_sale_list || []) ocupados.add(String(f.timeslot_id));
  }
  return slots.map(s => ({ ...s, existe: ocupados.has(String(s.timeslot_id)) }));
}

async function criarNoHorario(k, slot) {
  const sp = shopee.loja(k), st = estado(k);
  const plano = await montar(k, slot.start_time, slot.end_time);
  const reg = { em: new Date().toISOString(), horario: dataSP(slot.start_time), timeslot_id: slot.timeslot_id, candidatos: plano.candidatos, itens: plano.itens.length };
  if (!plano.itens.length) { reg.erro = 'nenhum item atende às regras'; st.historico.unshift(reg); return reg; }
  const c = await sp.shopeePost('/api/v2/shop_flash_sale/create_shop_flash_sale', { timeslot_id: Number(slot.timeslot_id) });
  const fsId = c.response?.flash_sale_id;
  if (!fsId) throw new Error('Shopee não devolveu o id da relâmpago: ' + JSON.stringify(c).slice(0, 300));
  reg.flash_sale_id = fsId;
  const items = plano.itens.map(it => it.models[0].model_id
    ? { item_id: Number(it.item_id), purchase_limit: 0, models: it.models.map(m => ({ model_id: Number(m.model_id), input_promo_price: m.preco, stock: m.qtd })) }
    : { item_id: Number(it.item_id), purchase_limit: 0, item_input_promo_price: it.models[0].preco, item_stock: it.models[0].qtd });
  const a = await sp.shopeePost('/api/v2/shop_flash_sale/add_shop_flash_sale_items', { flash_sale_id: Number(fsId), items });
  const falhas = (a.response?.failed_items || []).map(f => ({ item_id: f.item_id, model_id: f.model_id, motivo: f.err_msg || f.unqualified_conditions?.map(u => u.unqualified_msg || u).join('; ') || String(f.err_code || '') }));
  const falhou = new Set(falhas.map(f => String(f.item_id)));
  reg.adicionados = plano.itens.filter(it => !falhou.has(String(it.item_id))).length;
  reg.falhas = falhas.map(f => ({ ...f, nome: plano.itens.find(i => String(i.item_id) === String(f.item_id))?.nome }));
  for (const it of plano.itens) if (!falhou.has(String(it.item_id))) st.usados[it.item_id] = slot.start_time;
  st.historico.unshift(reg); st.historico = st.historico.slice(0, 60);
  return reg;
}

/** Cria as relâmpagos que faltam nos próximos horários. `forcar` ignora o liga/desliga (botão "rodar agora"). */
async function ciclo(k, { forcar = false } = {}) {
  const st = estado(k), sp = shopee.loja(k);
  if ((!st.ativo && !forcar) || !sp.getTokens().access_token) return [];
  const feitos = [];
  for (const s of await horarios(k)) {
    if (s.existe) continue;
    try { feitos.push(await criarNoHorario(k, s)); }
    catch (e) { const reg = { em: new Date().toISOString(), horario: dataSP(s.start_time), timeslot_id: s.timeslot_id, erro: e.message }; st.historico.unshift(reg); feitos.push(reg); }
    salvar();
  }
  st.ultimaChecagem = new Date().toISOString(); salvar();
  return feitos;
}

function avisar(k, feitos) {
  if (!feitos.length) return;
  const nome = shopee.LOJAS[k]?.nome || k;
  const txt = feitos.map(r => r.erro
    ? `⚠️ Relâmpago Shopee ${nome} (${r.horario}) NÃO criada: ${r.erro}`
    : `⚡ Relâmpago Shopee ${nome} criada para ${r.horario}: ${r.adicionados} itens` + (r.falhas?.length ? `\nRecusados pela Shopee (${r.falhas.length}):\n` + r.falhas.slice(0, 10).map(f => `• ${(f.nome || f.item_id).slice(0, 50)}: ${f.motivo}`).join('\n') : '')).join('\n\n');
  try { require('./telegram').sendTelegram(txt); } catch (e) {}
}

async function todas() {
  for (const k of Object.keys(shopee.LOJAS)) {
    try { avisar(k, await ciclo(k)); } catch (e) { console.warn('[relampago]', k, e.message); }
  }
}

function rotas(app) {
  const lojaDe = req => shopee.LOJAS[req.query.loja] ? req.query.loja : 'zagodini';
  const admin = req => req.usuario?.admin || !require('./auth').ativo();
  app.get('/shopee/relampago', async (req, res) => {
    const k = lojaDe(req), st = estado(k), out = { loja: k, ativo: st.ativo, regras: CFG, ultimaChecagem: st.ultimaChecagem, historico: st.historico.slice(0, 10) };
    try {
      out.horarios = (await horarios(k)).map(s => ({ ...s, inicio: dataSP(s.start_time) }));
      if (req.query.previa) { const s = out.horarios.find(x => !x.existe) || out.horarios[0]; if (s) out.previa = { horario: s.inicio, ...(await montar(k, s.start_time, s.end_time)) }; }
    } catch (e) { out.erro = e.message; }
    res.json(out);
  });
  app.post('/shopee/relampago/rodar', async (req, res) => {
    if (!admin(req)) return res.status(403).json({ erro: 'só admin' });
    const k = lojaDe(req);
    try { const f = await ciclo(k, { forcar: true }); avisar(k, f); res.json({ ok: true, feitos: f }); } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  app.post('/shopee/relampago/ativo', (req, res) => {
    if (!admin(req)) return res.status(403).json({ erro: 'só admin' });
    const k = lojaDe(req); estado(k).ativo = String(req.query.ativo ?? req.body?.ativo) === '1'; salvar();
    res.json({ loja: k, ativo: estado(k).ativo });
  });
  setInterval(todas, 60 * 60 * 1000);
  setTimeout(todas, 5 * 60 * 1000);
}

module.exports = { rotas, montar, ciclo, horarios, CFG };
