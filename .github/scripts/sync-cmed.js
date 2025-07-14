const axios = require('axios');
const XLSX = require('xlsx');
const fs = require('fs-extra');
const path = require('path');

const ANVISA_URL = 'https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos/arquivos/xls_conformidade_gov_20250707_104547402.xls/@@download/file';

async function syncCMED() {
  try {
    console.log('🔄 Iniciando download da base CMED...');
    console.log('📡 URL:', ANVISA_URL);

    const response = await axios({
      method: 'GET',
      url: ANVISA_URL,
      responseType: 'arraybuffer',
      timeout: 600000, // 10 minutos
      headers: {
        'User-Agent': 'Mozilla/5.0 (GitHub-Action CMED-Sync/1.0)',
        'Accept': 'application/vnd.ms-excel,*/*',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive'
      }
    });

    console.log(`✅ Download concluído! Tamanho: ${(response.data.length / 1024 / 1024).toFixed(2)} MB`);

    // Processar XLS
    console.log('🔄 Processando arquivo XLS...');
    const workbook = XLSX.read(response.data, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    
    if (jsonData.length < 2) {
      throw new Error('Arquivo XLS vazio ou inválido');
    }

    console.log(`📊 Total de linhas: ${jsonData.length}`);

    // Encontrar índices das colunas
    const headers = jsonData[0];
    const getColumnIndex = (variations) => {
      for (const variation of variations) {
        const index = headers.findIndex(h => 
          h && h.toString().toLowerCase().includes(variation.toLowerCase())
        );
        if (index !== -1) return index;
      }
      return -1;
    };

    const indices = {
      codigo: getColumnIndex(['codigo', 'cod', 'ean']),
      nome: getColumnIndex(['medicamento', 'produto', 'nome']),
      laboratorio: getColumnIndex(['laboratorio', 'empresa', 'fabricante']),
      apresentacao: getColumnIndex(['apresentacao', 'apresent']),
      pmvg: getColumnIndex(['pmvg', 'preco maximo', 'governo']),
      pf: getColumnIndex(['pf 0%', 'preco fabrica', 'pf']),
      icms_12: getColumnIndex(['pf 12%', 'icms 12']),
      icms_17: getColumnIndex(['pf 17%', 'icms 17']),
      icms_18: getColumnIndex(['pf 18%', 'icms 18']),
      icms_20: getColumnIndex(['pf 20%', 'icms 20']),
      icms_21: getColumnIndex(['pf 21%', 'icms 21'])
    };

    console.log('📋 Índices encontrados:', indices);

    const medicamentos = [];
    let processados = 0;
    let validos = 0;

    for (let i = 1; i < jsonData.length; i++) {
      const row = jsonData[i];
      
      if (!row || row.length === 0) continue;

      try {
        const medicamento = {
          id: i,
          codigo: row[indices.codigo] || `AUTO_${i}`,
          nome: row[indices.nome] || 'Nome não informado',
          laboratorio: row[indices.laboratorio] || 'Laboratório não informado',
          apresentacao: row[indices.apresentacao] || 'Apresentação não informada',
          pmvg: parseFloat(row[indices.pmvg]) || 0,
          preco_fabrica: parseFloat(row[indices.pf]) || 0,
          icms_0: parseFloat(row[indices.pf]) || 0,
          icms_12: parseFloat(row[indices.icms_12]) || 0,
          icms_17: parseFloat(row[indices.icms_17]) || 0,
          icms_18: parseFloat(row[indices.icms_18]) || 0,
          icms_20: parseFloat(row[indices.icms_20]) || 0,
          icms_21: parseFloat(row[indices.icms_21]) || 0
        };

        // Validações básicas
        if (!medicamento.nome || medicamento.nome.length < 3) continue;
        if (medicamento.pmvg <= 0) continue;

        medicamentos.push(medicamento);
        validos++;

      } catch (error) {
        console.log(`⚠️ Erro na linha ${i}:`, error.message);
      }

      processados++;
      
      if (processados % 5000 === 0) {
        console.log(`📊 Processados: ${processados} | Válidos: ${validos}`);
      }
    }

    if (validos === 0) {
      throw new Error('Nenhum medicamento válido encontrado no arquivo CMED');
    }

    console.log(`✅ Processamento concluído!`);
    console.log(`📊 Total processados: ${processados}`);
    console.log(`💾 Total válidos: ${validos}`);

    // Criar diretório data
    await fs.ensureDir('data');

    // Salvar dados processados
    const outputData = {
      metadata: {
        fonte: 'ANVISA/CMED',
        url: ANVISA_URL,
        dataProcessamento: new Date().toISOString(),
        totalMedicamentos: validos,
        versao: '1.0'
      },
      medicamentos: medicamentos
    };

    await fs.writeJson('data/cmed-pmvg.json', outputData, { spaces: 0 });
    await fs.writeJson('data/metadata.json', outputData.metadata, { spaces: 2 });

    const finalSize = (JSON.stringify(outputData).length / 1024 / 1024).toFixed(2);
    
    console.log(`📁 Arquivos salvos:`);
    console.log(`  - data/cmed-pmvg.json (${finalSize} MB)`);
    console.log(`  - data/metadata.json`);
    
    console.log('🎉 Sincronização CMED concluída com sucesso!');

  } catch (error) {
    console.error('❌ Erro na sincronização:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

syncCMED();
