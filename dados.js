/**
 * Pasta onde o painel guarda estado (tokens, cache, planilhas, configs).
 *  - No Mac: a própria pasta do projeto (comportamento de sempre).
 *  - Na nuvem (Railway): DATA_DIR=/data  (disco persistente / volume).
 */
const fs = require('fs');
const path = require('path');
const DATA = path.resolve(process.env.DATA_DIR || __dirname);
fs.mkdirSync(DATA, { recursive: true });
module.exports = DATA;
