const axios = require('axios');
const XLSX = require('xlsx');
const fs = require('fs-extra');
const path = require('path');

// URL da ANVISA (testada e funcionando)
const ANVISA_URL = 'https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos/arquivos/xls_conformidade_gov_20250707_104547402.xls/@@download/file';

async function syncCMED() {
  try {
    console.log('🔄 Iniciando download da base CMED...');
    console.log('📡 URL:', ANVISA_URL);

    // Download com timeout maior no GitHub (sem limitações do Render)
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
    
    // Converter para JSON
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    
    if (jsonData.length < 2) {
      throw new Error('Arquivo XLS vazio ou inválido');
    }

    console.log(`📊 Total de linhas: ${jsonData.length}`);

    // ✅ NOVO: Encontrar linha dos headers reais (procurar por "SUBSTÂNCIA")
    let headerRowIndex = -1;
    let headers = [];
    
    for (let i = 0; i < Math.min(jsonData.length, 50); i++) {
      const row = jsonData[i];
      if (row && Array.isArray(row)) {
        // Procurar por "SUBSTÂNCIA" que é o primeiro header real
        const temSubstancia = row.some(cell => 
          cell && cell.toString().toUpperCase().includes('SUBSTÂNCIA')
        );
        if (temSubstancia) {
          headerRowIndex = i;
          headers = row;
          break;
        }
      }
    }

    if (headerRowIndex === -1) {
      throw new Error('Linha de cabeçalhos não encontrada no arquivo CMED');
    }

    console.log(`📍 Headers encontrados na linha ${headerRowIndex}:`);
    headers.forEach((header, index) => {
      if (header) {
        console.log(`  [${index}]: "${header}"`);
      }
    });

    // ✅ MELHORADO: Função de busca mais flexível
    const getColumnIndex = (variations) => {
      for (const variation of variations) {
        const index = headers.findIndex(h => {
          if (!h) return false;
          const headerStr = h.toString().toLowerCase().trim();
          const variationStr = variation.toLowerCase().trim();
          
          // Busca exata
          if (headerStr === variationStr) return true;
          
          // Busca contém
          if (headerStr.includes(variationStr)) return true;
          
          // Busca sem espaços/acentos
          const normalizeStr = (str) => str
            .replace(/\s+/g, '')
            .replace(/[áàâãä]/g, 'a')
            .replace(/[éèêë]/g, 'e')
            .replace(/[íìîï]/g, 'i')
            .replace(/[óòôõö]/g, 'o')
            .replace(/[úùûü]/g, 'u')
            .replace(/[ç]/g, 'c');
            
          if (normalizeStr(headerStr).includes(normalizeStr(variationStr))) return true;
          
          return false;
        });
        if (index !== -1) return index;
      }
      return -1;
    };

    // ✅ CORRIGIDO: Busca pelos nomes EXATOS das colunas da CMED
    const indices = {
      codigo: getColumnIndex([
        'CÓDIGO GGREM', 'codigo ggrem', 'ggrem', 'codigo', 'cod'
      ]),
      nome: getColumnIndex([
        'SUBSTÂNCIA', 'substancia', 'PRODUTO', 'produto', 'medicamento'
      ]),
      laboratorio: getColumnIndex([
        'LABORATÓRIO', 'laboratorio', 'laboratory'
      ]),
      apresentacao: getColumnIndex([
        'APRESENTAÇÃO', 'apresentacao', 'presentation'
      ]),
      pmvg: getColumnIndex([
        'PMVG 0 %', 'PMVG 0%', 'pmvg 0%', 'pmvg 0 %', 'PMVG Sem Impostos', 'pmvg'
      ]),
      pf: getColumnIndex([
        'PF 0%', 'PF 0 %', 'pf 0%', 'pf 0 %', 'PF Sem Impostos', 'preco fabrica'
      ]),
      icms_12: getColumnIndex([
        'PF 12 %', 'PF 12%', 'pf 12%', 'pf 12 %'
      ]),
      icms_17: getColumnIndex([
        'PF 17 %', 'PF 17%', 'pf 17%', 'pf 17 %'
      ]),
      icms_18: getColumnIndex([
        'PF 18 %', 'PF 18%', 'pf 18%', 'pf 18 %'
      ]),
      icms_20: getColumnIndex([
        'PF 20 %', 'PF 20%', 'pf 20%', 'pf 20 %'
      ]),
      icms_21: getColumnIndex([
        'PF 21 %', 'PF 21%', 'pf 21%', 'pf 21 %'
      ])
    };

    console.log('📋 Índices mapeados:');
    Object.entries(indices).forEach(([key, value]) => {
      const status = value !== -1 ? '✅' : '❌';
      const headerName = value !== -1 ? headers[value] : 'NÃO ENCONTRADO';
      console.log(`  ${status} ${key}: [${value}] "${headerName}"`);
    });

    // ✅ VERIFICAÇÃO: Pelo menos nome deve existir
    if (indices.nome === -1) {
      console.log('❌ Colunas SUBSTÂNCIA/PRODUTO não encontradas. Headers disponíveis:');
      headers.forEach((h, i) => {
        if (h && (h.includes('SUBSTÂNCIA') || h.includes('PRODUTO'))) {
          console.log(`   [${i}]: "${h}" ⭐`);
        }
      });
      throw new Error('Coluna de nome do medicamento (SUBSTÂNCIA/PRODUTO) não encontrada');
    }

    if (indices.pmvg === -1 && indices.pf === -1) {
      console.log('❌ Colunas PMVG e PF não encontradas. Headers disponíveis:');
      headers.forEach((h, i) => {
        if (h && (h.includes('PMVG') || h.includes('PF'))) {
          console.log(`   [${i}]: "${h}" ⭐`);
        }
      });
      throw new Error('Colunas de preços (PMVG/PF) não encontradas');
    }

    // Processar dados
    const medicamentos = [];
    let processados = 0;
    let validos = 0;

    console.log('🔄 Processando medicamentos...');

    // ✅ CORRIGIDO: Começar após a linha de headers
    for (let i = headerRowIndex + 1; i < jsonData.length; i++) {
      const row = jsonData[i];
      
      if (!row || row.length === 0) continue;

      try {
        // ✅ CORRIGIDO: Usar nomes de substância + produto se disponível
        const substancia = indices.nome !== -1 ? (row[indices.nome] || '') : '';
        const produto = row[8] || ''; // PRODUTO está na coluna 8 baseado no arquivo
        const nomeCompleto = substancia || produto || 'Nome não informado';
        
        const medicamento = {
          id: i,
          codigo: indices.codigo !== -1 ? (row[indices.codigo] || `AUTO_${i}`) : `AUTO_${i}`,
          nome: nomeCompleto,
          laboratorio: indices.laboratorio !== -1 ? (row[indices.laboratorio] || 'Laboratório não informado') : 'Laboratório não informado',
          apresentacao: indices.apresentacao !== -1 ? (row[indices.apresentacao] || 'Apresentação não informada') : 'Apresentação não informada',
          pmvg: indices.pmvg !== -1 ? (parseFloat(row[indices.pmvg]) || 0) : 0,
          preco_fabrica: indices.pf !== -1 ? (parseFloat(row[indices.pf]) || 0) : 0,
          icms_0: indices.pf !== -1 ? (parseFloat(row[indices.pf]) || 0) : 0,
          icms_12: indices.icms_12 !== -1 ? (parseFloat(row[indices.icms_12]) || 0) : 0,
          icms_17: indices.icms_17 !== -1 ? (parseFloat(row[indices.icms_17]) || 0) : 0,
          icms_18: indices.icms_18 !== -1 ? (parseFloat(row[indices.icms_18]) || 0) : 0,
          icms_20: indices.icms_20 !== -1 ? (parseFloat(row[indices.icms_20]) || 0) : 0,
          icms_21: indices.icms_21 !== -1 ? (parseFloat(row[indices.icms_21]) || 0) : 0
        };

        // ✅ MELHORADO: Validações mais flexíveis para CMED
        const nomeValido = medicamento.nome && 
                          medicamento.nome !== 'Nome não informado' && 
                          medicamento.nome.toString().trim().length >= 3 &&
                          !medicamento.nome.toString().includes('undefined');
        
        const temPrecos = medicamento.pmvg > 0 || medicamento.preco_fabrica > 0;

        if (!nomeValido || !temPrecos) {
          // Log apenas das primeiras 5 linhas inválidas para debug
          if (validos < 5) {
            console.log(`⚠️ Linha ${i} inválida: nome="${medicamento.nome}" pmvg=${medicamento.pmvg} pf=${medicamento.preco_fabrica}`);
          }
          continue;
        }

        medicamentos.push(medicamento);
        validos++;

      } catch (error) {
        if (processados < 5) {
          console.log(`⚠️ Erro na linha ${i}:`, error.message);
        }
      }

      processados++;
      
      if (processados % 5000 === 0) {
        console.log(`📊 Processados: ${processados} | Válidos: ${validos}`);
      }
    }

    if (validos === 0) {
      console.log('❌ NENHUM medicamento válido encontrado!');
      console.log(`🔍 Primeiras 5 linhas após headers (linha ${headerRowIndex}) para debug:`);
      for (let i = headerRowIndex + 1; i <= Math.min(headerRowIndex + 5, jsonData.length - 1); i++) {
        const row = jsonData[i];
        if (row) {
          console.log(`Linha ${i}:`, row.slice(0, 10)); // Primeiras 10 colunas
        }
      }
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
        versao: '1.0',
        colunas: indices
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
