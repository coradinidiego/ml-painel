#!/usr/bin/env python3
"""
Gerador de Apuração Mensal - Zagodini e Com Amor de Mae

Os custos fixos são lidos de arquivos locais que você mantém atualizados:
  ~/ml-painel/precificacao_zagodini.xlsx
  ~/ml-painel/precificacao_camae.xlsx

Uso:
  python3 gerar_apuracao.py <mes> <z_amazon.xls> <z_shein.xls> <c_amazon.xls> <c_shein.xls> [pasta_saida]

Exemplo:
  python3 gerar_apuracao.py Maio z_amazon.xls z_shein.xls c_amazon.xls c_shein.xls
"""

import sys
import os
import subprocess
import tempfile
import shutil
from pathlib import Path
from io import BytesIO

import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

# ─── Caminhos das planilhas de precificação (locais no Mac) ──────────────────
PAINEL_DIR = Path(os.environ.get('DATA_DIR') or Path(__file__).parent)  # DATA_DIR na nuvem; senão ~/ml-painel/
PRECIF_ZAGODINI = PAINEL_DIR / 'precificacao_zagodini.xlsx'
PRECIF_CAMAE    = PAINEL_DIR / 'precificacao_camae.xlsx'

# ─── Configurações ────────────────────────────────────────────────────────────
IMPOSTO = {'Zagodini': 0.11, 'ComAmorDeMae': 0.08}
CUSTO_FIXO_PADRAO = 5.5

HEADER_COLS = [
    'Número do pedido multiloja', 'Número do pedido', 'Situação',
    'Nome da Loja', 'Data de criação', 'Nome', 'Código (SKU)', 'Descrição',
    'Quantidade', 'Preço unitário', 'Desconto proporcional',
    'Frete proporcional', 'Valor total', 'Desconto proporcional total',
    'Preço de custo', 'Lucro', 'Taxa de Comissão', 'Custo Fixo', 'Lucro Final'
]

# ─── Estilos ──────────────────────────────────────────────────────────────────
HEADER_FILL  = PatternFill("solid", fgColor="1F3864")
HEADER_FONT  = Font(name="Arial", bold=True, color="FFFFFF", size=9)
DATA_FONT    = Font(name="Arial", size=9)
TOTAL_FILL   = PatternFill("solid", fgColor="D9E1F2")
TOTAL_FONT   = Font(name="Arial", bold=True, size=9)
SUMMARY_FONT = Font(name="Arial", bold=True, size=10)
LABEL_FILL   = PatternFill("solid", fgColor="FCE4D6")
LUCRO_FILL   = PatternFill("solid", fgColor="E2EFDA")

thin   = Side(style="thin", color="BFBFBF")
BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)


# ─── Leitura da planilha de precificação ─────────────────────────────────────

def ler_tabela_custos(arquivo_path, nome):
    """
    Lê abas 'Amazon' e 'Shein' da planilha de precificação.
    Col A = SKU, Col G = Custo Fixo
    Retorna dois dicts: {sku: custo_fixo}
    """
    amazon_cf = {}
    shein_cf  = {}
    arquivo_path = Path(arquivo_path)

    if not arquivo_path.exists():
        print(f"  ⚠️  Planilha não encontrada: {arquivo_path}")
        print(f"     Salve a planilha de precificação como '{arquivo_path.name}' em {PAINEL_DIR}")
        print(f"     Usando custo fixo padrão R${CUSTO_FIXO_PADRAO} para todos os SKUs.")
        return amazon_cf, shein_cf

    print(f"  📋 Lendo custos de: {arquivo_path.name}")
    try:
        # Suporta .xls convertendo primeiro
        if arquivo_path.suffix.lower() == '.xls':
            xlsx_path, tmp = converter_xls_para_xlsx(arquivo_path)
            wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
            shutil.rmtree(tmp, ignore_errors=True)
        else:
            wb = openpyxl.load_workbook(arquivo_path, read_only=True, data_only=True)

        for aba, destino in [('Amazon', amazon_cf), ('Shein', shein_cf)]:
            if aba not in wb.sheetnames:
                print(f"     ⚠️  Aba '{aba}' não encontrada em {arquivo_path.name}")
                continue
            ws = wb[aba]
            count = 0
            for r in ws.iter_rows(values_only=True):
                sku, cf = r[0], r[6]
                if sku is not None and cf is not None and str(sku) != 'Cod':
                    try:
                        destino[str(sku).strip()] = float(cf)
                        count += 1
                    except Exception:
                        pass
            print(f"     → {aba}: {count} SKUs")

    except Exception as e:
        print(f"  ⚠️  Erro ao ler {arquivo_path.name}: {e}")

    return amazon_cf, shein_cf


def buscar_custo_fixo(sku, tabela):
    """Busca custo fixo pelo SKU. Tenta string, int e sem decimais."""
    if sku is None:
        return CUSTO_FIXO_PADRAO, False

    sku_str = str(sku).strip()

    # String exata
    if sku_str in tabela:
        return tabela[sku_str], True

    # Tenta como inteiro (ex: 10055002.0 → '10055002')
    try:
        sku_int = str(int(float(sku_str)))
        if sku_int in tabela:
            return tabela[sku_int], True
    except Exception:
        pass

    return CUSTO_FIXO_PADRAO, False


# ─── Utilitários ─────────────────────────────────────────────────────────────

def converter_xls_para_xlsx(xls_path):
    xls_path = Path(xls_path).resolve()
    tmp_dir  = Path(tempfile.mkdtemp())
    script   = Path(__file__).parent / 'soffice_helper.py'

    # Tenta via soffice.py do painel ou caminho padrão
    soffice_script = None
    candidatos = [
        Path(__file__).parent / 'scripts' / 'office' / 'soffice.py',
        Path('/mnt/skills/public/pptx/scripts/office/soffice.py'),
    ]
    for c in candidatos:
        if c.exists():
            soffice_script = c
            break

    if soffice_script:
        subprocess.run(
            ['python3', str(soffice_script), '--headless',
             '--convert-to', 'xlsx', '--outdir', str(tmp_dir), str(xls_path)],
            capture_output=True, check=True
        )
    else:
        # Fallback: libreoffice direto
        subprocess.run(
            ['libreoffice', '--headless', '--convert-to', 'xlsx',
             '--outdir', str(tmp_dir), str(xls_path)],
            capture_output=True, check=True
        )

    xlsx_files = list(tmp_dir.glob('*.xlsx'))
    if not xlsx_files:
        raise FileNotFoundError(f"Conversão falhou para {xls_path}")
    return xlsx_files[0], tmp_dir


def ler_export_bling(arquivo):
    arquivo = Path(arquivo)
    tmp_dir = None
    if arquivo.suffix.lower() == '.xls':
        xlsx_path, tmp_dir = converter_xls_para_xlsx(arquivo)
    else:
        xlsx_path = arquivo

    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    ws = wb.active
    linhas = [
        row for i, row in enumerate(ws.iter_rows(values_only=True))
        if i > 0 and any(v is not None for v in row)
    ]
    if tmp_dir:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    return linhas


def to_float(val):
    if val is None:
        return 0.0
    try:
        return float(str(val).replace(',', '.').replace('R$', '').replace(' ', '').strip())
    except Exception:
        return 0.0


# ─── Criação da aba de apuração ───────────────────────────────────────────────

def criar_aba_apuracao(wb, nome_aba, linhas_amazon, linhas_shein,
                       imposto_pct, amazon_cf, shein_cf):
    ws = wb.create_sheet(title=nome_aba)

    # Cabeçalho
    for col_idx, titulo in enumerate(HEADER_COLS, start=1):
        cell = ws.cell(row=1, column=col_idx, value=titulo)
        cell.font      = HEADER_FONT
        cell.fill      = HEADER_FILL
        cell.alignment = Alignment(horizontal='center', wrap_text=True)
        cell.border    = BORDER

    row_idx = 2
    nao_encontrados = {'Amazon': [], 'Shein': []}

    def escrever_linha(linha_bling, plataforma):
        nonlocal row_idx
        sku         = linha_bling[6]
        preco_unit  = to_float(linha_bling[9])
        lucro_bling = to_float(linha_bling[15])
        taxa_com    = to_float(linha_bling[16])

        tabela = amazon_cf if plataforma == 'Amazon' else shein_cf
        custo_fixo, encontrado = buscar_custo_fixo(sku, tabela)

        if not encontrado and sku not in (None, '-', ''):
            nao_encontrados[plataforma].append(str(sku))

        lucro_final = lucro_bling - taxa_com - custo_fixo

        valores = [
            linha_bling[0], linha_bling[1], linha_bling[2],
            linha_bling[3], linha_bling[4], linha_bling[5],
            sku, linha_bling[7], linha_bling[8],
            preco_unit,
            to_float(linha_bling[10]), to_float(linha_bling[11]),
            to_float(linha_bling[12]), to_float(linha_bling[13]),
            to_float(linha_bling[14]),
            lucro_bling, taxa_com, custo_fixo, lucro_final,
        ]

        for col_idx, val in enumerate(valores, start=1):
            cell = ws.cell(row=row_idx, column=col_idx, value=val)
            cell.font   = DATA_FONT
            cell.border = BORDER
            if col_idx in (10, 11, 12, 13, 14, 15, 16, 17, 18, 19):
                cell.number_format = 'R$ #,##0.00'

        row_idx += 1

    for linha in linhas_amazon:
        escrever_linha(linha, 'Amazon')
    for linha in linhas_shein:
        escrever_linha(linha, 'Shein')

    ultima_dados = row_idx - 1

    # Totais
    row_total = row_idx
    lbl = ws.cell(row=row_total, column=11, value='TOTAIS')
    lbl.font = TOTAL_FONT; lbl.fill = TOTAL_FILL

    for col, formula in [(13, f'=SUM(M2:M{ultima_dados})'),
                         (19, f'=SUM(S2:S{ultima_dados})')]:
        c = ws.cell(row=row_total, column=col, value=formula)
        c.font = TOTAL_FONT; c.fill = TOTAL_FILL
        c.number_format = 'R$ #,##0.00'; c.border = BORDER

    # Resumo financeiro
    row_r = row_total + 3

    def resumo(label, formula, fill=None):
        nonlocal row_r
        lbl = ws.cell(row=row_r, column=11, value=label)
        lbl.font = SUMMARY_FONT
        lbl.alignment = Alignment(horizontal='right')
        if fill: lbl.fill = fill
        val = ws.cell(row=row_r, column=13, value=formula)
        val.font = SUMMARY_FONT
        val.number_format = 'R$ #,##0.00'
        val.border = BORDER
        if fill: val.fill = fill
        row_r += 1

    resumo('Faturamento',               f'=M{row_total}')
    resumo(f'Imposto ({imposto_pct*100:.0f}%)', f'=M{row_total}*{imposto_pct}', LABEL_FILL)
    resumo('Lucro (antes imposto)',      f'=S{row_total}')
    resumo('Lucro Líquido',             f'=S{row_total}-M{row_r-1}', LUCRO_FILL)

    # Larguras
    for i, larg in enumerate([25,10,10,15,18,20,22,45,8,12,12,12,14,14,14,14,14,12,14], 1):
        ws.column_dimensions[get_column_letter(i)].width = larg
    ws.freeze_panes = 'A2'

    # Avisos
    avisos = []
    for plat, skus in nao_encontrados.items():
        if skus:
            unicos = list(dict.fromkeys(skus))
            avisos.append(
                f"{plat}: {len(unicos)} SKUs sem custo cadastrado "
                f"(usado R${CUSTO_FIXO_PADRAO}): {unicos[:5]}{'...' if len(unicos)>5 else ''}"
            )
    return avisos


# ─── Função principal ─────────────────────────────────────────────────────────

def gerar_apuracao(mes, arq_z_amazon, arq_z_shein, arq_c_amazon, arq_c_shein,
                   saida_dir='.'):
    print(f"\n{'='*60}")
    print(f"  Apuração de {mes}")
    print(f"{'='*60}\n")

    # 1. Ler tabelas de custo fixo
    print("📋 Lendo tabelas de custo fixo...")
    z_amazon_cf, z_shein_cf = ler_tabela_custos(PRECIF_ZAGODINI, 'Zagodini')
    c_amazon_cf, c_shein_cf = ler_tabela_custos(PRECIF_CAMAE,    'Com Amor de Mae')

    # 2. Ler exports do Bling
    print("\n📥 Lendo exports do Bling...")
    z_amazon = ler_export_bling(arq_z_amazon)
    print(f"  Z-Amazon: {len(z_amazon)} pedidos")
    z_shein  = ler_export_bling(arq_z_shein)
    print(f"  Z-Shein:  {len(z_shein)} pedidos")
    c_amazon = ler_export_bling(arq_c_amazon)
    print(f"  C-Amazon: {len(c_amazon)} pedidos")
    c_shein  = ler_export_bling(arq_c_shein)
    print(f"  C-Shein:  {len(c_shein)} pedidos")

    saida_dir = Path(saida_dir)
    saida_dir.mkdir(parents=True, exist_ok=True)

    # 3. Zagodini
    print("\n📊 Gerando Zagodini...")
    wb_z = openpyxl.Workbook()
    wb_z.remove(wb_z.active)
    avisos_z = criar_aba_apuracao(wb_z, mes, z_amazon, z_shein,
                                  IMPOSTO['Zagodini'], z_amazon_cf, z_shein_cf)
    saida_z = saida_dir / f"Apuracao_Zagodini_{mes}.xlsx"
    wb_z.save(saida_z)
    print(f"  ✅ {saida_z.name}")
    for av in avisos_z: print(f"  ⚠️  {av}")

    # 4. Com Amor de Mae
    print("\n📊 Gerando Com Amor de Mae...")
    wb_c = openpyxl.Workbook()
    wb_c.remove(wb_c.active)
    avisos_c = criar_aba_apuracao(wb_c, mes, c_amazon, c_shein,
                                  IMPOSTO['ComAmorDeMae'], c_amazon_cf, c_shein_cf)
    saida_c = saida_dir / f"Apuracao_ComAmorDeMae_{mes}.xlsx"
    wb_c.save(saida_c)
    print(f"  ✅ {saida_c.name}")
    for av in avisos_c: print(f"  ⚠️  {av}")

    print(f"\n🎉 Concluído!")
    return str(saida_z), str(saida_c), avisos_z + avisos_c


# ─── Entry point ──────────────────────────────────────────────────────────────
if __name__ == '__main__':
    if len(sys.argv) < 6:
        print(__doc__)
        sys.exit(1)

    mes, z_amz, z_sh, c_amz, c_sh = sys.argv[1:6]
    saida = sys.argv[6] if len(sys.argv) > 6 else '.'

    for f in [z_amz, z_sh, c_amz, c_sh]:
        if not Path(f).exists():
            print(f"❌ Arquivo não encontrado: {f}")
            sys.exit(1)

    gerar_apuracao(mes, z_amz, z_sh, c_amz, c_sh, saida)
