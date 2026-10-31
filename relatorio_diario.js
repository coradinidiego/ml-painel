/**
 * Relatório diário de resultado (PDF no Telegram, todo dia às 06:00 de Brasília).
 *
 * Usa a mesma apuração da tela (apuracao_mkt.resultado), já calculada na rodada da madrugada:
 *  - Ontem × mesmo dia da semana anterior
 *  - Mês até ontem × mesmo período do mês anterior (1→N contra 1→N) + projeção de fechamento
 *  - Por empresa e por empresa × marketplace (faturamento, lucro, margem, variação)
 *  - Faturamento dia a dia (mês atual × anterior), produtos que mais lucraram / com prejuízo,
 *    ADS, devoluções/cancelamentos e SKUs sem custo
 *
 *  GET  /relatorio/diario.pdf?data=AAAA-MM-DD   gera o PDF do dia (padrão: ontem) — admin
 *  POST /relatorio/diario/enviar?data=...       gera e manda no Telegram agora — admin
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const DATA = require('./dados');

const ARQ = path.join(DATA, 'apuracao_cache', 'relatorio_diario.json');
const ARQ_AUTO = path.join(DATA, 'apuracao_cache', 'apmkt_auto.json');
const ler = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const gravar = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch (e) {} };
const hojeSP = () => new Date(Date.now() - 3 * 3600e3);
const ymd = d => d.toISOString().slice(0, 10);
const addDias = (s, n) => ymd(new Date(Date.parse(s + 'T12:00:00Z') + n * 864e5));
const pad = n => String(n).padStart(2, '0');
const br = s => s.split('-').reverse().join('/');
const MES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const DIA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brl0 = v => 'R$ ' + Math.round(v || 0).toLocaleString('pt-BR');
const pct = v => (v == null || !isFinite(v)) ? '—' : String(Math.round(v * 10) / 10).replace('.', ',') + '%';
const delta = (a, b) => (!b) ? null : (a - b) / Math.abs(b) * 100;
const dtxt = v => v == null ? '—' : (v >= 0 ? '+' : '') + pct(v);
const NOME_EMP = { 'Zagodini': 'Zagodini', 'Com Amor de Mãe': 'Com Amor de Mãe', 'Lufe': 'Lufe' };

// ─── Dados ───────────────────────────────────────────────────────────────────
async function montar(D) {
  const A = require('./apuracao_mkt');
  const [y, m, d] = D.split('-').map(Number);
  const mesIni = `${y}-${pad(m)}-01`;
  const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
  const fimPrev = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  const antIni = `${py}-${pad(pm)}-01`, antFim = `${py}-${pad(pm)}-${pad(Math.min(d, fimPrev))}`;
  const sem = addDias(D, -7);
  const get = (ini, fim) => A.resultado({ emp: 'todas', ini, fim });
  const ontem = await get(D, D), semana = await get(sem, sem), mes = await get(mesIni, D), ant = await get(antIni, antFim);
  const diasMes = new Date(Date.UTC(y, m, 0)).getUTCDate();

  const porEmp = (r) => {
    const o = {};
    for (const g of r.grupos || []) { const e = o[g.empresa] ||= { receita: 0, devolucao: 0, lucro: 0, pedidos: 0, ads: 0 }; e.receita += g.receita; e.devolucao += g.devolucao || 0; e.lucro += g.lucro; e.pedidos += g.pedidos; e.ads += g.ads || 0; }
    return o;
  };
  const margem = o => (o.receita - (o.devolucao || 0)) ? o.lucro / (o.receita - (o.devolucao || 0)) * 100 : null;
  const empMes = porEmp(mes), empAnt = porEmp(ant), empOntem = porEmp(ontem);
  const empresas = [...new Set([...Object.keys(empMes), ...Object.keys(empAnt)])].sort((a, b) => (empMes[b]?.receita || 0) - (empMes[a]?.receita || 0));
  const gAnt = Object.fromEntries((ant.grupos || []).map(g => [g.empresa + '|' + g.canal, g]));

  // dia a dia
  const serie = (r, base) => { const o = {}; for (const l of r.linhas || []) { const k = Number(String(l.data).slice(8, 10)); const x = o[k] ||= { receita: 0, lucro: 0 }; x.receita += l.receita || 0; x.lucro += l.lucro || 0; } return o; };
  const sMes = serie(mes), sAnt = serie(ant);

  // produtos (mês)
  const prod = {};
  for (const l of mes.linhas || []) {
    if (l.pedido === 'ADS' || !l.qtd) continue;
    const k = l.empresa + '|' + l.sku, p = prod[k] ||= { empresa: l.empresa, sku: l.sku, desc: l.descricao, q: 0, receita: 0, lucro: 0 };
    p.q += l.qtd; p.receita += l.receita; p.lucro += l.lucro;
  }
  const P = Object.values(prod);
  const top = [...P].sort((a, b) => b.lucro - a.lucro).slice(0, 8);
  const piores = P.filter(p => p.lucro < 0).sort((a, b) => a.lucro - b.lucro).slice(0, 8);

  const fora = mes.foraApuracao || [];
  const dev = fora.filter(f => /devol|reembols|estorn/i.test(f.situacao || '')), canc = fora.filter(f => /cancel/i.test(f.situacao || ''));
  const recML = (mes.grupos || []).filter(g => g.canal === 'Mercado Livre').reduce((a, g) => a + g.receita, 0);
  const estimados = (ontem.linhas || []).filter(l => /estimad|pendente|sem repasse/i.test(l.origemTaxa || '')).length;
  const auto = ler(ARQ_AUTO, {});

  return {
    D, y, m, d, diasMes, mesIni, antIni, antFim, sem,
    ontem: ontem.total, semana: semana.total, mes: mes.total, ant: ant.total,
    margem, empresas, empMes, empAnt, empOntem, grupos: mes.grupos || [], gAnt,
    sMes, sAnt, top, piores, dev, canc, semCusto: mes.semCusto || [], recML,
    pendentes: [...new Set([...(ontem.pendentes || []), ...(mes.pendentes || [])])], estimados,
    autoOk: auto?.ok?.fim === D,
  };
}

// ─── PDF ─────────────────────────────────────────────────────────────────────
const C = { roxo: '#5B2C6F', cinza: '#666666', claro: '#F3EEF6', linha: '#DDDDDD', verde: '#2E7D32', verm: '#C62828', azul: '#1565C0', azulClaro: '#90A4AE' };

function gerarPDF(R) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36, info: { Title: 'Resultado ' + br(R.D) } });
    const bufs = []; doc.on('data', b => bufs.push(b)); doc.on('end', () => resolve(Buffer.concat(bufs)));
    const W = doc.page.width - 72, X0 = 36;
    const cor = v => v == null ? C.cinza : v >= 0 ? C.verde : C.verm;

    // cabeçalho
    const dt = new Date(R.D + 'T12:00:00Z');
    doc.rect(0, 0, doc.page.width, 64).fill(C.roxo);
    doc.fill('#FFFFFF').font('Helvetica-Bold').fontSize(18).text('Resultado diário — Marketplaces', X0, 18);
    doc.font('Helvetica').fontSize(10).text(`Ontem: ${DIA[dt.getUTCDay()]}, ${br(R.D)}   ·   Mês: ${MES[R.m - 1]} até dia ${R.d} (comparado com 01 a ${R.antFim.slice(8)}/${R.antFim.slice(5, 7)})`, X0, 42);
    let y = 80;

    // cartões
    const card = (x, w, titulo, valor, linhas) => {
      doc.roundedRect(x, y, w, 100, 6).fill(C.claro);
      doc.fill(C.roxo).font('Helvetica-Bold').fontSize(9).text(titulo.toUpperCase(), x + 10, y + 8, { width: w - 20 });
      doc.fill('#000').font('Helvetica-Bold').fontSize(17).text(valor, x + 10, y + 22, { width: w - 20 });
      let yy = y + 46;
      for (const [txt, c] of linhas) { doc.fill(c || '#333').font('Helvetica').fontSize(8.5).text(txt, x + 10, yy, { width: w - 20 }); yy += 11.5; }
    };
    const o = R.ontem, s = R.semana, mm = R.mes, a = R.ant;
    const cw = (W - 16) / 3;
    card(X0, cw, 'Ontem', brl0(o.receita), [
      [`Lucro ${brl0(o.lucro)} · margem ${pct(R.margem(o))}`], [`${o.pedidos} pedidos`],
      [`vs ${DIA[new Date(R.sem + 'T12:00:00Z').getUTCDay()]} anterior: fat. ${dtxt(delta(o.receita, s.receita))} · lucro ${dtxt(delta(o.lucro, s.lucro))}`, cor(delta(o.lucro, s.lucro))]]);
    card(X0 + cw + 8, cw, 'Mês até ontem', brl0(mm.receita), [
      [`Lucro ${brl0(mm.lucro)} · margem ${pct(R.margem(mm))}`], [`${mm.pedidos} pedidos · ADS ${brl0(mm.ads)}`],
      [`vs mês anterior: fat. ${dtxt(delta(mm.receita, a.receita))} · lucro ${dtxt(delta(mm.lucro, a.lucro))}`, cor(delta(mm.lucro, a.lucro))]]);
    const pf = mm.receita / R.d * R.diasMes, pl = mm.lucro / R.d * R.diasMes;
    card(X0 + 2 * (cw + 8), cw, 'Projeção do mês', brl0(pf), [
      [`Lucro projetado ${brl0(pl)}`], [`ritmo de ${brl0(mm.receita / R.d)}/dia`],
      [`Mês anterior no mesmo dia: ${brl0(a.receita)}`, C.cinza]]);
    y += 114;

    // tabela genérica
    const tabela = (titulo, cols, linhas, opts = {}) => {
      doc.fill(C.roxo).font('Helvetica-Bold').fontSize(11).text(titulo, X0, y); y += 16;
      const tw = cols.reduce((t, c) => t + c.w, 0), esc = W / tw;
      let x = X0;
      doc.rect(X0, y, W, 16).fill(C.roxo);
      for (const c of cols) { doc.fill('#FFF').font('Helvetica-Bold').fontSize(8).text(c.t, x + 4, y + 4, { width: c.w * esc - 8, align: c.a || 'left' }); x += c.w * esc; }
      y += 16;
      linhas.forEach((L, i) => {
        const h = 15, neg = L._total;
        if (i % 2 === 1 && !neg) doc.rect(X0, y, W, h).fill('#FAFAFA');
        if (neg) doc.rect(X0, y, W, h).fill(C.claro);
        x = X0;
        cols.forEach((c, j) => {
          const v = L[j]; const txt = typeof v === 'object' && v ? v.t : v;
          doc.fill((typeof v === 'object' && v?.c) || '#222').font(neg || (typeof v === 'object' && v?.b) ? 'Helvetica-Bold' : 'Helvetica').fontSize(8)
            .text(String(txt ?? ''), x + 4, y + 4, { width: c.w * esc - 8, height: 9, align: c.a || 'left', ellipsis: true });
          x += c.w * esc;
        });
        y += h;
      });
      doc.moveTo(X0, y).lineTo(X0 + W, y).strokeColor(C.linha).lineWidth(0.5).stroke();
      y += opts.gap ?? 14;
    };

    // por empresa (mês)
    const colsE = [{ t: 'Empresa', w: 150 }, { t: 'Faturamento', w: 90, a: 'right' }, { t: 'Lucro', w: 80, a: 'right' }, { t: 'Margem', w: 55, a: 'right' }, { t: 'Fat. vs ant.', w: 75, a: 'right' }, { t: 'Lucro vs ant.', w: 80, a: 'right' }, { t: 'Ontem (fat.)', w: 80, a: 'right' }];
    const linE = R.empresas.map(e => { const x = R.empMes[e] || { receita: 0, lucro: 0 }, p = R.empAnt[e] || {}; const dl = delta(x.lucro, p.lucro);
      return [NOME_EMP[e] || e, brl0(x.receita), brl0(x.lucro), pct(R.margem(x)), { t: dtxt(delta(x.receita, p.receita)), c: cor(delta(x.receita, p.receita)) }, { t: dtxt(dl), c: cor(dl) }, brl0((R.empOntem[e] || {}).receita)]; });
    const tot = [ 'Total', brl0(mm.receita), brl0(mm.lucro), pct(R.margem(mm)), { t: dtxt(delta(mm.receita, a.receita)), c: cor(delta(mm.receita, a.receita)) }, { t: dtxt(delta(mm.lucro, a.lucro)), c: cor(delta(mm.lucro, a.lucro)) }, brl0(o.receita) ]; tot._total = true;
    tabela('Por empresa — mês até ontem', colsE, [...linE, tot]);

    // empresa × marketplace
    const colsC = [{ t: 'Empresa', w: 110 }, { t: 'Marketplace', w: 90 }, { t: 'Pedidos', w: 50, a: 'right' }, { t: 'Faturamento', w: 85, a: 'right' }, { t: 'Lucro', w: 75, a: 'right' }, { t: 'Margem', w: 50, a: 'right' }, { t: 'ADS', w: 60, a: 'right' }, { t: 'Lucro vs ant.', w: 70, a: 'right' }];
    const linC = R.grupos.filter(g => g.receita > 0 || g.lucro).map(g => { const p = R.gAnt[g.empresa + '|' + g.canal]; const dl = p ? delta(g.lucro, p.lucro) : null; const mg = R.margem(g);
      return [NOME_EMP[g.empresa] || g.empresa, g.canal, g.pedidos, brl0(g.receita), { t: brl0(g.lucro), c: g.lucro < 0 ? C.verm : null }, { t: pct(mg), c: mg != null && mg < 5 ? C.verm : null }, g.ads ? brl0(g.ads) : '—', { t: dtxt(dl), c: cor(dl) }]; });
    tabela('Por empresa e marketplace — mês até ontem', colsC, linC);

    // ── página 2 ──
    doc.addPage(); y = 36;
    // gráfico dia a dia
    doc.fill(C.roxo).font('Helvetica-Bold').fontSize(11).text(`Faturamento por dia — ${MES[R.m - 1]} (barras) × mês anterior (linha)`, X0, y); y += 18;
    const gx = X0 + 40, gw = W - 50, gh = 150, gy = y;
    const dias = Math.max(R.d, 1);
    const vals = []; for (let i = 1; i <= R.diasMes; i++) vals.push(R.sMes[i]?.receita || 0, R.sAnt[i]?.receita || 0);
    const max = Math.max(1, ...vals) * 1.1;
    for (let k = 0; k <= 4; k++) { const v = max * k / 4, yy = gy + gh - gh * k / 4; doc.moveTo(gx, yy).lineTo(gx + gw, yy).strokeColor('#EEEEEE').lineWidth(0.5).stroke(); doc.fill(C.cinza).font('Helvetica').fontSize(7).text(v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v), X0, yy - 4, { width: 36, align: 'right' }); }
    const bw = gw / R.diasMes;
    for (let i = 1; i <= R.diasMes; i++) {
      const v = R.sMes[i]?.receita || 0, h = gh * v / max, x = gx + (i - 1) * bw;
      if (i <= R.d && v) doc.rect(x + bw * 0.15, gy + gh - h, bw * 0.7, h).fill(i === R.d ? C.roxo : '#A98DB8');
      if (i === 1 || i % 5 === 0 || i === R.diasMes) doc.fill(C.cinza).fontSize(7).text(String(i), x, gy + gh + 3, { width: bw, align: 'center' });
    }
    doc.save(); let primeiro = true;
    for (let i = 1; i <= R.diasMes; i++) { const v = R.sAnt[i]?.receita; if (v == null) continue; const x = gx + (i - 0.5) * bw, yy = gy + gh - gh * v / max; if (primeiro) { doc.moveTo(x, yy); primeiro = false; } else doc.lineTo(x, yy); }
    if (!primeiro) doc.strokeColor(C.azul).lineWidth(1.4).stroke();
    doc.restore();
    y = gy + gh + 16;
    doc.fill(C.cinza).font('Helvetica').fontSize(7.5).text(`Média por dia: ${brl0(mm.receita / dias)} neste mês · ${brl0(a.receita / Math.max(1, Number(R.antFim.slice(8))))} no mês anterior.`, X0, y); y += 18;

    // produtos
    const colsP = [{ t: 'Empresa', w: 90 }, { t: 'SKU', w: 85 }, { t: 'Produto', w: 210 }, { t: 'Un.', w: 35, a: 'right' }, { t: 'Faturamento', w: 75, a: 'right' }, { t: 'Lucro', w: 70, a: 'right' }];
    const linP = L => L.map(p => [NOME_EMP[p.empresa] || p.empresa, p.sku, p.desc || '', Math.round(p.q), brl0(p.receita), { t: brl(p.lucro), c: p.lucro < 0 ? C.verm : C.verde }]);
    tabela('Produtos que mais deram lucro no mês', colsP, linP(R.top));
    if (R.piores.length) tabela('Produtos com prejuízo no mês (revisar preço, custo ou ADS)', colsP, linP(R.piores));

    // alertas
    doc.fill(C.roxo).font('Helvetica-Bold').fontSize(11).text('Pontos de atenção', X0, y); y += 15;
    const itens = [];
    itens.push(`ADS no mês: ${brl0(mm.ads)} = ${pct(R.recML ? mm.ads / R.recML * 100 : null)} do faturamento do Mercado Livre (${brl0(R.recML)}).`);
    itens.push(`Devoluções/reembolsos no mês: ${R.dev.length} pedidos (${brl0(R.dev.reduce((t, f) => t + (f.valor || 0), 0))}) · cancelados: ${R.canc.length} (${brl0(R.canc.reduce((t, f) => t + (f.valor || 0), 0))}). Já fora do resultado.`);
    if (R.semCusto.length) itens.push(`${R.semCusto.length} SKU(s) vendidos sem custo no ERP — o lucro deles está superestimado. Maiores: ${R.semCusto.slice(0, 4).map(x => x.sku).join(', ')}.`);
    if (R.estimados) itens.push(`${R.estimados} linha(s) de ontem com taxa ou repasse ainda estimado (Shopee/Amazon fecham depois) — o número do dia pode mudar um pouco.`);
    if (R.pendentes.length) itens.push(`Sem dados para: ${R.pendentes.join(', ')} — rodar a apuração no painel.`);
    if (!R.autoOk) itens.push('A apuração automática da madrugada não terminou para este período — números podem estar incompletos.');
    for (const t of itens) { doc.fill('#222').font('Helvetica').fontSize(8.5).text('•  ' + t, X0, y, { width: W }); y = doc.y + 4; }

    doc.page.margins.bottom = 0;
    doc.fill(C.cinza).fontSize(7).text(`Gerado pelo painel em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}. Lucro = faturamento - custo (ERP) - tarifas - frete - imposto - embalagem - ADS. Comparações com o mesmo período do mês anterior (01 a ${R.antFim.slice(8)}).`, X0, doc.page.height - 46, { width: W });
    doc.end();
  });
}

function legenda(R) {
  const o = R.ontem, m = R.mes, a = R.ant;
  return `📊 <b>Resultado de ontem (${br(R.D)})</b>\n` +
    `Faturamento ${brl0(o.receita)} · lucro ${brl0(o.lucro)} (${pct(R.margem(o))}) · ${o.pedidos} pedidos\n` +
    `vs semana passada: lucro ${dtxt(delta(o.lucro, R.semana.lucro))}\n\n` +
    `<b>${MES[R.m - 1][0].toUpperCase() + MES[R.m - 1].slice(1)} até dia ${R.d}</b>\n` +
    `Faturamento ${brl0(m.receita)} (${dtxt(delta(m.receita, a.receita))}) · lucro ${brl0(m.lucro)} (${dtxt(delta(m.lucro, a.lucro))}) · margem ${pct(R.margem(m))}\n` +
    `Projeção do mês: ${brl0(m.receita / R.d * R.diasMes)} · lucro ${brl0(m.lucro / R.d * R.diasMes)}\n` +
    R.empresas.map(e => { const x = R.empMes[e] || {}; return `• ${NOME_EMP[e] || e}: ${brl0(x.receita)} · lucro ${brl0(x.lucro)} (${pct(R.margem(x))})`; }).join('\n');
}

async function gerar(D) { const R = await montar(D); return { R, pdf: await gerarPDF(R) }; }

async function enviar(D, motivo) {
  const { R, pdf } = await gerar(D);
  const tg = require('./telegram');
  const r = await tg.sendTelegramDocument(pdf, `resultado_${D}.pdf`, legenda(R));
  const st = { ultimo: ymd(hojeSP()), data: D, em: new Date().toISOString(), motivo, ok: r.every(x => x.ok), resp: r.map(x => x.ok ? 'ok' : (x.description || x.erro)) };
  gravar(ARQ, st);
  return st;
}

module.exports = function (app) {
  const admin = (req, res) => { if (require('./auth').ativo() && !req.usuario?.admin) { res.status(403).json({ erro: 'só admin' }); return false; } return true; };
  const ontem = () => addDias(ymd(hojeSP()), -1);
  const dataOk = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : ontem();
  app.get('/relatorio/diario.pdf', async (req, res) => {
    if (!admin(req, res)) return;
    try { const { pdf } = await gerar(dataOk(req.query.data)); res.set('Content-Type', 'application/pdf').set('Content-Disposition', `inline; filename="resultado_${dataOk(req.query.data)}.pdf"`).send(pdf); }
    catch (e) { res.status(500).json({ erro: e.message }); }
  });
  app.post('/relatorio/diario/enviar', async (req, res) => {
    if (!admin(req, res)) return;
    try { res.json(await enviar(dataOk(req.query.data), 'manual')); } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  app.get('/relatorio/diario/status', (req, res) => res.json(ler(ARQ, {})));

  // todo dia às 06:00 (Brasília). Espera a apuração da madrugada terminar; se até 09:00 não terminou, manda assim mesmo (com aviso no PDF)
  setInterval(() => {
    const h = hojeSP(), min = h.getUTCHours() * 60 + h.getUTCMinutes(), hoje = ymd(h);
    if (min < 6 * 60 || min > 12 * 60) return;
    const st = ler(ARQ, {}); if (st.ultimo === hoje) return;
    const auto = ler(ARQ_AUTO, {});
    if (auto?.ok?.fim !== ontem() && min < 9 * 60) return;
    gravar(ARQ, { ...st, ultimo: hoje, tentando: new Date().toISOString() });   // evita dois envios no mesmo dia
    enviar(ontem(), 'agendado').catch(e => { gravar(ARQ, { ...st, ultimo: null, erro: e.message }); console.warn('[relatorio]', e.message); });
  }, 5 * 60e3).unref?.();
};
