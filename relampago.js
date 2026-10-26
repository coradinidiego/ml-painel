/**
 * Oferta Relâmpago da Loja (Shopee) automática — uma por dia em cada loja, só para registro:
 *   - preço = preço da promoção de desconto que já está ativa no item − R$ 0,01
 *   - 5 unidades por variação (a Shopee reserva o saldo da relâmpago e não atualiza o estoque enquanto ela dura)
 *   - só entram variações com 15+ unidades no estoque do vendedor
 *   - item sem promoção de desconto ativa não entra (ex.: mamadeiras, que não podem ter promoção)
 *   - até 20 itens por relâmpago; revezando: entram primeiro os que estão há mais tempo sem relâmpago
 *
 *  Roda de hora em hora: a partir das 14h, cria a relâmpago do dia seguinte (só ela — a Shopee reserva o saldo da campanha).
 *  GET  /shopee/relampago?loja=mae            situação + prévia do que entraria na próxima
 *  POST /shopee/relampago/rodar?loja=mae      cria agora (admin)
 *  POST /shopee/relampago/ativo?loja=mae&ativo=1|0
 */
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');
const shopee = require('./shopee');

const ARQ = path.join(DATA, 'shopee_relampago.json');
const CFG = { precoMenos: 0.01, qtd: 5, estoqueMin: 15, maxItens: 20, janelaH: 48, horaCriar: '14:00' };   // cria só a de amanhã, a partir das 14h (a Shopee reserva o saldo)
const PROIBIDO = /^\s*(mamadeira|chupeta|bico)\b/i;   // não podem ter promoção (garantia extra além da regra do desconto)
const delay = ms => new Promise(r => setTimeout(r, ms));
const TZ = 'America/Sao_Paulo';
const diaIso = ts => new Date(ts * 1000).toLocaleDateString('sv-SE', { timeZone: TZ });

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
    const rec = (st.recusados || {})[it.item_id];
    if (rec && Date.now() - rec.em < 14 * 864e5) continue;   // recusado pela Shopee há pouco (critérios da relâmpago)
    const models = [];
    if (it.has_model) {
      const d = await sp.shopeeGet('/api/v2/product/get_model_list', { item_id: it.item_id });
      const tiers = d.response?.tier_variation || [];
      for (const m of d.response?.model || []) {
        const est = estoqueVendedor(m.stock_info_v2), preco = precos[m.model_id];
        if (preco && est >= CFG.estoqueMin) models.push({ model_id: m.model_id, sku: m.model_sku || it.item_sku || '', nome: (m.tier_index || []).map((ix, t) => tiers[t]?.option_list?.[ix]?.option).filter(Boolean).join(' / '), promo: preco, preco: r2(preco - CFG.precoMenos), estoque: est, qtd: CFG.qtd });
      }
      await delay(120);
      if (!models.length) continue;
    } else {
      const est = estoqueVendedor(it.stock_info_v2), preco = precos[0];
      if (!preco || est < CFG.estoqueMin) continue;
      models.push({ model_id: 0, sku: it.item_sku || '', nome: '', promo: preco, preco: r2(preco - CFG.precoMenos), estoque: est, qtd: CFG.qtd });
    }
    cand.push({ item_id: it.item_id, nome: it.item_name, models, ultimo: st.usados[it.item_id] || 0, estoque: Math.max(...models.map(m => m.estoque)) });
  }
  // revezamento: há mais tempo sem relâmpago primeiro; empate = mais estoque
  cand.sort((a, b) => a.ultimo - b.ultimo || b.estoque - a.estoque);
  return { candidatos: cand.length, itens: cand.slice(0, CFG.maxItens), reservas: cand.slice(CFG.maxItens, CFG.maxItens + 15) };
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
  const montarItem = it => it.models[0].model_id
    ? { item_id: Number(it.item_id), purchase_limit: 0, models: it.models.map(m => ({ model_id: Number(m.model_id), input_promo_price: m.preco, stock: m.qtd })) }
    : { item_id: Number(it.item_id), purchase_limit: 0, item_input_promo_price: it.models[0].preco, item_stock: it.models[0].qtd };
  const adicionar = async lista => {
    const a = await sp.shopeePost('/api/v2/shop_flash_sale/add_shop_flash_sale_items', { flash_sale_id: Number(fsId), items: lista.map(montarItem) });
    return (a.response?.failed_items || []).map(f => ({ item_id: f.item_id, model_id: f.model_id, motivo: f.err_msg || f.unqualified_conditions?.map(u => u.unqualified_msg || u).join('; ') || String(f.err_code || '') }));
  };
  // recusado pela Shopee: entra o próximo da fila (reservas) até completar os 20
  let falhas = [], ok = [], fila = plano.itens, reservas = [...(plano.reservas || [])];
  for (let rodada = 0; rodada < 3 && fila.length; rodada++) {
    let f;
    try { f = await adicionar(fila); }
    catch (er) {
      if (rodada === 0) throw er;
      // a Shopee conta também os recusados no limite de itens da relâmpago: fica com o que já entrou
      reg.aviso = /exceed_max_item/.test(er.message) ? 'a Shopee não deixou repor os recusados (limite de itens da oferta)' : 'não deu para repor os recusados: ' + er.message;
      break;
    }
    const falhou = new Set(f.map(x => String(x.item_id)));
    falhas.push(...f.map(x => ({ ...x, nome: fila.find(i => String(i.item_id) === String(x.item_id))?.nome })));
    ok.push(...fila.filter(it => !falhou.has(String(it.item_id))));
    fila = reservas.splice(0, Math.min(CFG.maxItens - ok.length, falhou.size));
  }
  // lembra os recusados por 14 dias (não tenta de novo amanhã)
  st.recusados ||= {};
  for (const f of falhas) st.recusados[f.item_id] = { em: Date.now(), motivo: f.motivo, nome: f.nome };
  for (const [id, r] of Object.entries(st.recusados)) if (Date.now() - r.em > 14 * 864e5) delete st.recusados[id];
  reg.adicionados = ok.length;
  const doPlano = new Set(plano.itens.map(i => String(i.item_id)));
  reg.substituidos = ok.filter(it => !doPlano.has(String(it.item_id))).length;
  reg.falhas = falhas;
  for (const it of ok) st.usados[it.item_id] = slot.start_time;
  st.historico.unshift(reg); st.historico = st.historico.slice(0, 60);
  return reg;
}

/** Cria as relâmpagos que faltam nos próximos horários. `forcar` ignora o liga/desliga (botão "rodar agora"). */
async function ciclo(k, { forcar = false } = {}) {
  const st = estado(k), sp = shopee.loja(k);
  if ((!st.ativo && !forcar) || !sp.getTokens().access_token) return [];
  const feitos = [];
  const agora = new Date(), hm = agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ });
  if (hm < CFG.horaCriar) { st.ultimaChecagem = agora.toISOString(); salvar(); return []; }
  const amanha = new Date(agora.getTime() + 864e5).toLocaleDateString('sv-SE', { timeZone: TZ });
  for (const s of await horarios(k)) {
    if (s.existe || diaIso(s.start_time) !== amanha) continue;   // só o horário de amanhã
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
    : `⚡ Relâmpago Shopee ${nome} criada para ${r.horario}: ${r.adicionados} itens` + (r.aviso ? `\n(${r.aviso})` : '') + (r.falhas?.length ? `\nRecusados pela Shopee (${r.falhas.length}${r.substituidos ? ', ' + r.substituidos + ' substituídos por outros itens' : ''}; ficam fora por 14 dias):\n` + r.falhas.slice(0, 10).map(f => `• ${(f.nome || f.item_id).slice(0, 50)}: ${f.motivo}`).join('\n') : '')).join('\n\n');
  try { require('./telegram').sendTelegram(txt); } catch (e) {}
}

async function todas() {
  for (const k of Object.keys(shopee.LOJAS)) {
    try { avisar(k, await ciclo(k)); } catch (e) { console.warn('[relampago]', k, e.message); }
  }
}

// ─── Margem: preço − custo (ERP) − comissão/tarifa Shopee − imposto − embalagem ───
// Tarifa Shopee (CNPJ) por faixa de preço do item — tabela vigente desde 01/03/2026, ajustada pelos repasses reais
// das lojas (out/2026: abaixo de R$ 80 a comissão + taxas somaram ~21–23% + R$ 4; acima, ~13,7% + taxa fixa da faixa)
function tarifaShopee(preco) {
  const f = preco < 80 ? [0.22, 4] : preco < 100 ? [0.14, 16] : preco < 200 ? [0.14, 20] : preco < 500 ? [0.14, 26] : [0.14, 28];
  return { pct: f[0], fixa: f[1], valor: r2(preco * f[0] + f[1]) };
}
async function margemFn(k) {
  const cm = require('./custos_ml'), idx = shopee.LOJAS[k]?.ml;
  const erp = await cm.custosErp(idx).catch(() => ({}));
  const imp = cm.aliquota(idx), emb = require('./config_empresas').porMlIdx(idx)?.embalagem ?? 0;
  return (preco, sku) => {
    const cf = sku ? cm.custoComFonte(idx, sku, erp) : null;
    const t = tarifaShopee(preco), imposto = r2(preco * imp);
    if (!cf || cf.fonte === 'planilha') return { preco, tarifa: t, imposto, embalagem: emb, semCusto: true };   // custo tem que vir do Bling/Tiny
    const lucro = r2(preco - cf.v - t.valor - imposto - emb);
    return { preco, custo: r2(cf.v), tarifa: t, imposto, embalagem: emb, lucro, pct: Math.round(lucro / preco * 1000) / 10 };
  };
}
/** Relâmpagos programadas e em andamento da loja, com itens e margem. */
async function listarComMargem(k) {
  const sp = shopee.loja(k), out = [];
  const mg = await margemFn(k);
  for (const type of [2, 1]) {
    const d = await sp.shopeeGet('/api/v2/shop_flash_sale/get_shop_flash_sale_list', { type, offset: 0, limit: 20 });
    for (const f of d.response?.flash_sale_list || []) {
      const it = (await sp.shopeeGet('/api/v2/shop_flash_sale/get_shop_flash_sale_items', { flash_sale_id: f.flash_sale_id, offset: 0, limit: 100 })).response || {};
      const nomes = Object.fromEntries((it.item_info || []).map(i => [i.item_id, i.item_name]));
      const linhas = [];
      for (const m of it.models || []) if (m.status === 1) linhas.push({ item_id: m.item_id, model_id: m.model_id, nome: nomes[m.item_id], variacao: m.model_name, preco: m.input_promotion_price, original: m.original_price, qtd: m.campaign_stock });
      for (const i of it.item_info || []) if (i.input_promotion_price != null && i.item_status === 1) linhas.push({ item_id: i.item_id, model_id: 0, nome: i.item_name, variacao: '', preco: i.input_promotion_price, original: i.original_price, qtd: i.campaign_stock });
      // SKU de cada item/variação para achar o custo no ERP
      const ids = [...new Set(linhas.map(l => l.item_id))];
      const skuItem = {}, skuModel = {};
      for (let i = 0; i < ids.length; i += 50) {
        const b = await sp.shopeeGet('/api/v2/product/get_item_base_info', { item_id_list: ids.slice(i, i + 50).join(',') });
        for (const x of b.response?.item_list || []) skuItem[x.item_id] = x.item_sku || '';
      }
      for (const id of [...new Set(linhas.filter(l => l.model_id).map(l => l.item_id))]) {
        const m = await sp.shopeeGet('/api/v2/product/get_model_list', { item_id: id });
        for (const x of m.response?.model || []) skuModel[x.model_id] = x.model_sku || '';
        await delay(100);
      }
      // preço da promoção de desconto (a que roda dia a dia) durante a relâmpago
      const promo = {};
      for (let i = 0; i < ids.length; i += 50) {
        const d = await sp.shopeeGet('/api/v2/product/get_item_promotion', { item_id_list: ids.slice(i, i + 50).join(',') });
        for (const it of d.response?.success_list || []) for (const p of it.promotion || []) {
          if (p.promotion_type !== 'Discount Promotions' || !(p.start_time <= f.start_time && p.end_time >= f.end_time)) continue;
          const v = p.promotion_price_info?.[0]?.promotion_price; if (v > 0) promo[it.item_id + '|' + (p.model_id || 0)] = v;
        }
      }
      for (const l of linhas) {
        l.sku = (l.model_id && skuModel[l.model_id]) || skuItem[l.item_id] || '';
        l.promo = promo[l.item_id + '|' + l.model_id] ?? promo[l.item_id + '|0'] ?? null;
        l.difPromo = l.promo == null ? null : r2(l.promo - l.preco);   // esperado: 0,01
        Object.assign(l, { m: mg(l.preco, l.sku) });
      }
      out.push({ id: f.flash_sale_id, situacao: type === 2 ? 'Em andamento' : 'Programada', inicio: dataSP(f.start_time), fim: dataSP(f.end_time), itens: linhas });
    }
  }
  return out;
}
function paginaVer(dados) {
  const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const brl = v => v == null ? '—' : 'R$ ' + Number(v).toFixed(2).replace('.', ',');
  const blocos = dados.map(([k, L, erro]) => {
    const nome = shopee.LOJAS[k]?.nome || k;
    if (erro) return `<div class="box"><h2>${esc(nome)}</h2><p class="err">${esc(erro)}</p></div>`;
    if (!L.length) return `<div class="box"><h2>${esc(nome)}</h2><p class="s">Nenhuma relâmpago programada ou em andamento.</p></div>`;
    return L.map(f => {
      const ok = f.itens.filter(l => !l.m.semCusto), tot = ok.reduce((a, l) => a + l.m.lucro * l.qtd, 0), rec = ok.reduce((a, l) => a + l.preco * l.qtd, 0);
      const linhas = f.itens.map(l => `<tr><td class="l">${esc(l.nome)}${l.variacao ? `<br><small>${esc(l.variacao)}</small>` : ''}<br><small>SKU ${esc(l.sku || '—')}</small></td>
        <td>${brl(l.preco)}<br><small><s>${brl(l.original)}</s></small></td><td>${l.qtd}</td>
        <td>${l.m.semCusto ? '<span class="err">sem custo no ERP</span>' : brl(l.m.custo)}</td>
        <td>${brl(l.m.tarifa.valor)}<br><small>${Math.round(l.m.tarifa.pct * 100)}% + ${brl(l.m.tarifa.fixa)}</small></td>
        <td>${brl(l.m.imposto)}${l.m.embalagem ? `<br><small>+ emb. ${brl(l.m.embalagem)}</small>` : ''}</td>
        <td class="${l.m.semCusto ? '' : l.m.lucro < 0 ? 'neg' : 'pos'}"><b>${l.m.semCusto ? '—' : brl(l.m.lucro)}</b>${l.m.semCusto ? '' : `<br><small>${String(l.m.pct).replace('.', ',')}%</small>`}</td></tr>`).join('');
      return `<div class="box"><h2>${esc(nome)} · <span class="tag ${f.situacao === 'Em andamento' ? 'on' : ''}">${f.situacao}</span> ${esc(f.inicio)} → ${esc(f.fim)}</h2>
        <p class="s">${f.itens.length} itens/variações · se vender tudo: ${brl(rec)} em vendas, lucro ${brl(tot)}${rec ? ` (${(tot / rec * 100).toFixed(1).replace('.', ',')}%)` : ''}${f.itens.length - ok.length ? ` · ${f.itens.length - ok.length} sem custo no ERP (fora da conta)` : ''}</p>
        <table><tr><th class="l">Produto</th><th>Preço relâmpago</th><th>Qtd</th><th>Custo</th><th>Tarifa Shopee</th><th>Imposto</th><th>Lucro/un.</th></tr>${linhas}</table></div>`;
    }).join('');
  }).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ofertas Relâmpago</title><style>
body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f0f2f5;color:#1a1a2e}.top{background:#ee4d2d;color:#fff;padding:14px 24px;display:flex;gap:14px;align-items:center}.top a{color:#fff;font-size:13px}
.box{background:#fff;border:1px solid #e6e6e6;border-radius:12px;padding:16px 20px;margin:16px auto;max-width:1100px;overflow-x:auto}h2{font-size:16px;margin:0 0 6px}p.s{color:#666;font-size:13px;margin:0 0 10px}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:7px 8px;border-bottom:1px solid #f2f2f2;text-align:right;vertical-align:top}.l{text-align:left;max-width:420px}small{color:#888}
.pos{color:#1e7e34}.neg{color:#c62828}.err{color:#c62828}.tag{font-size:12px;background:#eee;border-radius:10px;padding:2px 8px}.tag.on{background:#ffe0d6;color:#c43d1d}</style></head><body>
<div class="top"><b>⚡ Ofertas Relâmpago — Shopee</b><span style="flex:1"></span><a href="/painel.html">← Painel</a></div>
<div class="box" style="background:#fffbea"><p class="s" style="margin:0">Lucro = preço − custo do produto (Bling/Tiny) − tarifa Shopee estimada (comissão + taxa fixa por item: abaixo de R$ 80 = 22% + R$ 4; acima, 14% + R$ 16 a R$ 28 conforme a faixa — conferido com os repasses reais das lojas) − imposto − embalagem. O valor exato da tarifa vem no repasse de cada pedido. A relâmpago de amanhã é criada automaticamente a partir das ${CFG.horaCriar}.</p></div>
${blocos}</body></html>`;
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
  app.get('/shopee/relampago/ver', async (req, res) => {
    const dados = [];
    for (const k of Object.keys(shopee.LOJAS)) {
      if (!shopee.loja(k).getTokens().access_token) continue;
      try { dados.push([k, await listarComMargem(k)]); } catch (e) { dados.push([k, [], e.message]); }
    }
    res.send(paginaVer(dados));
  });
  const _cacheDados = {};
  app.get('/shopee/relampago/dados', async (req, res) => {
    const k = lojaDe(req), st = estado(k), c = _cacheDados[k];
    try {
      if (!c || req.query.recarregar || Date.now() - c.ts > 3 * 60e3) _cacheDados[k] = { ts: Date.now(), v: await listarComMargem(k) };
      res.json({ loja: k, ativo: st.ativo, regras: CFG, historico: st.historico.slice(0, 10), atualizado: new Date(_cacheDados[k].ts).toISOString(), vendas: _cacheDados[k].v });
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  app.post('/shopee/relampago/excluir', async (req, res) => {
    if (!admin(req)) return res.status(403).json({ erro: 'só admin' });
    const k = lojaDe(req), id = Number(req.query.id);
    try {
      const sp = shopee.loja(k), f = (await sp.shopeeGet('/api/v2/shop_flash_sale/get_shop_flash_sale', { flash_sale_id: id })).response;
      const r = await sp.shopeePost('/api/v2/shop_flash_sale/delete_shop_flash_sale', { flash_sale_id: id });
      const st = estado(k); if (f?.start_time) for (const [it, ts] of Object.entries(st.usados)) if (ts === f.start_time) delete st.usados[it];
      st.historico.unshift({ em: new Date().toISOString(), horario: f?.start_time ? dataSP(f.start_time) : '', flash_sale_id: id, excluida: true }); salvar();
      res.json({ ok: true, r });
    } catch (e) { res.status(500).json({ erro: e.message }); }
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
