/**
 * apuracao.js — Módulo de Apuração Mensal
 * Integra ao ml-painel (~/ml-painel/)
 *
 * Uso via Node.js:
 *   const apuracao = require('./apuracao');
 *   await apuracao.gerar('Maio', 'z_amz.xls', 'z_sh.xls', 'c_amz.xls', 'c_sh.xls');
 *
 * Ou via rota Express (já incluída em server.js via app.use(apuracao.router)):
 *   POST /apuracao/gerar   — form-data com campos: mes, z_amazon, z_shein, c_amazon, c_shein
 *   GET  /apuracao/baixar/:empresa/:mes  — baixa o xlsx gerado
 */

'use strict';

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { spawn } = require('child_process');

const router = express.Router();

// ─── Configuração ────────────────────────────────────────────────────────────
const PASTA_SAIDA  = path.join(require('./dados'), 'apuracao_saida');
const PASTA_UPLOAD = path.join(require('./dados'), 'apuracao_uploads');
const SCRIPT_PY    = path.join(__dirname, 'gerar_apuracao.py');

// Cria pastas se não existirem
[PASTA_SAIDA, PASTA_UPLOAD].forEach(p => fs.mkdirSync(p, { recursive: true }));

// Multer — aceita até 4 arquivos XLS/XLSX
const upload = multer({
  dest: PASTA_UPLOAD,
  fileFilter: (req, file, cb) => {
    const ok = /\.(xls|xlsx)$/i.test(file.originalname);
    cb(ok ? null : new Error('Apenas arquivos .xls ou .xlsx'), ok);
  },
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB por arquivo
});

// ─── Rota: gerar apuração ────────────────────────────────────────────────────
router.post('/gerar', upload.fields([
  { name: 'z_amazon', maxCount: 1 },
  { name: 'z_shein',  maxCount: 1 },
  { name: 'c_amazon', maxCount: 1 },
  { name: 'c_shein',  maxCount: 1 },
]), async (req, res) => {
  const mes = (req.body.mes || '').trim();

  if (!mes) {
    return res.status(400).json({ erro: 'Campo "mes" obrigatório (ex: Maio)' });
  }

  const campos = ['z_amazon', 'z_shein', 'c_amazon', 'c_shein'];
  for (const campo of campos) {
    if (!req.files[campo]) {
      return res.status(400).json({ erro: `Arquivo "${campo}" não enviado` });
    }
  }

  const z_amz = req.files.z_amazon[0].path;
  const z_sh  = req.files.z_shein[0].path;
  const c_amz = req.files.c_amazon[0].path;
  const c_sh  = req.files.c_shein[0].path;

  console.log(`[Apuração] Iniciando geração para ${mes}...`);

  try {
    const resultado = await rodarScript(mes, z_amz, z_sh, c_amz, c_sh);

    // Limpa uploads temporários
    [z_amz, z_sh, c_amz, c_sh].forEach(f => fs.unlink(f, () => {}));

    res.json({
      sucesso: true,
      mes,
      arquivos: {
        zagodini:    `Apuracao_Zagodini_${mes}.xlsx`,
        comAmordMae: `Apuracao_ComAmorDeMae_${mes}.xlsx`,
      },
      log: resultado.log,
      avisos: resultado.avisos,
    });

  } catch (err) {
    console.error('[Apuração] Erro:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ─── Rota: baixar arquivo gerado ─────────────────────────────────────────────
router.get('/baixar/:empresa/:mes', (req, res) => {
  const { empresa, mes } = req.params;

  const nomes = {
    zagodini:    `Apuracao_Zagodini_${mes}.xlsx`,
    camae:       `Apuracao_ComAmorDeMae_${mes}.xlsx`,
  };

  const nome = nomes[empresa.toLowerCase()];
  if (!nome) {
    return res.status(400).json({ erro: 'Empresa inválida. Use: zagodini ou camae' });
  }

  const arquivo = path.join(PASTA_SAIDA, nome);
  if (!fs.existsSync(arquivo)) {
    return res.status(404).json({ erro: `Arquivo não encontrado: ${nome}` });
  }

  res.download(arquivo, nome);
});

// ─── Rota: listar arquivos gerados ───────────────────────────────────────────
router.get('/listar', (req, res) => {
  try {
    const arquivos = fs.readdirSync(PASTA_SAIDA)
      .filter(f => f.endsWith('.xlsx'))
      .map(f => {
        const stat = fs.statSync(path.join(PASTA_SAIDA, f));
        return { nome: f, tamanho: stat.size, data: stat.mtime };
      })
      .sort((a, b) => b.data - a.data);

    res.json({ arquivos });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── Executa script Python ───────────────────────────────────────────────────
function rodarScript(mes, z_amz, z_sh, c_amz, c_sh) {
  return new Promise((resolve, reject) => {
    const args = [SCRIPT_PY, mes, z_amz, z_sh, c_amz, c_sh, PASTA_SAIDA];
    const proc = spawn('python3', args);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d; process.stdout.write(d); });
    proc.stderr.on('data', d => { stderr += d; process.stderr.write(d); });

    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`Script Python falhou (código ${code}): ${stderr}`));
      }

      // Extrai avisos de SKUs não encontrados
      const avisos = stdout
        .split('\n')
        .filter(l => l.includes('⚠️'))
        .map(l => l.replace(/^\s*⚠️\s*/, ''));

      resolve({ log: stdout, avisos });
    });

    proc.on('error', err => reject(new Error(`Falha ao iniciar Python: ${err.message}`)));
  });
}

// ─── Export ───────────────────────────────────────────────────────────────────
module.exports = { router, gerar: rodarScript };
