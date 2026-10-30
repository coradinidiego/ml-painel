/**
 * Despesas fixas por mês (para o DRE e o ponto de equilíbrio da Apuração).
 * Lançamento: { id, mes:'AAAA-MM', empresa:'zagodini'|'mae'|'lufe'|'todas', categoria, descricao, valor, recorrente, em, por }
 *   empresa 'todas' = despesa compartilhada → no DRE é rateada pelas empresas pela receita líquida do mês.
 *   recorrente = entra no "Copiar recorrentes do mês anterior".
 *
 *  GET    /despesas?mes=AAAA-MM          lançamentos do mês + categorias
 *  POST   /despesas                      { id?, mes, empresa, categoria, descricao, valor, recorrente }   cria/edita
 *  DELETE /despesas/:id
 *  POST   /despesas/copiar               { de:'AAAA-MM', para:'AAAA-MM' }  copia os recorrentes que ainda não existem no mês
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DATA = require('./dados');
const ARQ = path.join(DATA, 'despesas.json');
const CATEGORIAS = ['Salários', 'Pró-labore', 'Aluguel', 'Sistemas', 'Embalagens', 'Água', 'Luz', 'Internet', 'Contabilidade', 'Despesas da empresa', 'Outros'];
const EMPS = ['zagodini', 'mae', 'lufe', 'todas'];
const ler = () => { try { return JSON.parse(fs.readFileSync(ARQ)); } catch (e) { return { lanc: [] }; } };
const gravar = d => { fs.mkdirSync(path.dirname(ARQ), { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(d)); };
const mesOk = m => /^\d{4}-\d{2}$/.test(m || '');

module.exports = function (app) {
  const J = require('express').json();
  const admin = (req, res) => { if (require('./auth').ativo() && !req.usuario?.admin) { res.status(403).json({ erro: 'só admin' }); return false; } return true; };
  app.get('/despesas', (req, res) => {
    const d = ler(), mes = String(req.query.mes || '');
    const cats = [...new Set([...CATEGORIAS, ...d.lanc.map(l => l.categoria)])];
    res.json({ categorias: cats, lanc: mesOk(mes) ? d.lanc.filter(l => l.mes === mes) : d.lanc,
      meses: [...new Set(d.lanc.map(l => l.mes))].sort().reverse() });
  });
  app.post('/despesas', J, (req, res) => {
    if (!admin(req, res)) return;
    const b = req.body || {}, valor = Number(String(b.valor ?? '').replace(',', '.'));
    if (!mesOk(b.mes) || !EMPS.includes(b.empresa) || !String(b.categoria || '').trim() || !(valor >= 0)) return res.status(400).json({ erro: 'preencha mês, empresa, categoria e valor' });
    const d = ler(), por = req.usuario?.nome || req.usuario?.email || null;
    const reg = { mes: b.mes, empresa: b.empresa, categoria: String(b.categoria).trim().slice(0, 40), descricao: String(b.descricao || '').trim().slice(0, 120), valor: Math.round(valor * 100) / 100, recorrente: !!b.recorrente, em: new Date().toISOString(), por };
    if (b.id) { const i = d.lanc.findIndex(l => l.id === b.id); if (i < 0) return res.status(404).json({ erro: 'lançamento não encontrado' }); d.lanc[i] = { ...d.lanc[i], ...reg }; }
    else d.lanc.push({ id: crypto.randomBytes(6).toString('hex'), ...reg });
    gravar(d); res.json({ ok: true });
  });
  app.delete('/despesas/:id', (req, res) => {
    if (!admin(req, res)) return;
    const d = ler(), n = d.lanc.length; d.lanc = d.lanc.filter(l => l.id !== req.params.id);
    if (d.lanc.length === n) return res.status(404).json({ erro: 'não encontrado' });
    gravar(d); res.json({ ok: true });
  });
  app.post('/despesas/copiar', J, (req, res) => {
    if (!admin(req, res)) return;
    const { de, para } = req.body || {};
    if (!mesOk(de) || !mesOk(para)) return res.status(400).json({ erro: 'mês inválido' });
    const d = ler(), ja = new Set(d.lanc.filter(l => l.mes === para).map(l => l.empresa + '|' + l.categoria + '|' + l.descricao));
    const novos = d.lanc.filter(l => l.mes === de && l.recorrente && !ja.has(l.empresa + '|' + l.categoria + '|' + l.descricao))
      .map(l => ({ ...l, id: crypto.randomBytes(6).toString('hex'), mes: para, em: new Date().toISOString(), por: req.usuario?.nome || null }));
    d.lanc.push(...novos); gravar(d); res.json({ ok: true, copiados: novos.length });
  });
};
