// ============================================================================
// BACKEND SISTEMA PMVG - CONEXÃO REAL COM ANVISA
// Implementação completa para Render.com
// ============================================================================

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const csvParser = require('csv-parser');
const { createObjectCsvStringifier } = require('csv-writer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'pmvg_secret_key_2025';

// Middlewares
app.use(cors());
app.use(express.json());

// ============================================================================
// CONFIGURAÇÃO DO BANCO DE DADOS SQLITE
// ============================================================================

const DB_PATH = path.join(__dirname, 'pmvg_database.db');
const db = new sqlite3.Database(DB_PATH);

// Inicializar tabelas
db.serialize(() => {
  // Tabela de usuários
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      name TEXT,
      password TEXT,
      role TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Tabela de medicamentos PMVG (dados da ANVISA)
  db.run(`
    CREATE TABLE IF NOT EXISTS medicamentos_pmvg (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT UNIQUE,
      nome TEXT,
      laboratorio TEXT,
      apresentacao TEXT,
      categoria TEXT,
      pmvg REAL,
      preco_fabrica REAL DEFAULT 0,
      ultima_atualizacao DATE,
      ativo BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Tabela de licitações
  db.run(`
    CREATE TABLE IF NOT EXISTS licitacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT,
      orgao TEXT,
      data_publicacao DATE,
      data_vencimento DATE,
      valor REAL,
      vigencia_contratual TEXT,
      observacoes TEXT,
      status TEXT DEFAULT 'ativa',
      user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )
  `);

  // Tabela de alertas
  db.run(`
    CREATE TABLE IF NOT EXISTS alertas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT,
      titulo TEXT,
      descricao TEXT,
      prioridade TEXT,
      status TEXT DEFAULT 'ativo',
      data_geracao DATETIME DEFAULT CURRENT_TIMESTAMP,
      user_id INTEGER,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )
  `);

  // Tabela de logs de sincronização
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data_sync DATETIME DEFAULT CURRENT_TIMESTAMP,
      medicamentos_processados INTEGER,
      novos INTEGER,
      atualizados INTEGER,
      status TEXT,
      detalhes TEXT
    )
  `);

  // Inserir usuário admin padrão (apenas se não existir)
  db.get("SELECT id FROM users WHERE email = ?", ['admin@sistema.com'], (err, row) => {
    if (!row) {
      const hashedPassword = bcrypt.hashSync('123456', 10);
      db.run(`
        INSERT INTO users (email, name, password, role) 
        VALUES (?, ?, ?, ?)
      `, ['admin@sistema.com', 'Administrador', hashedPassword, 'admin']);
      
      db.run(`
        INSERT INTO users (email, name, password, role) 
        VALUES (?, ?, ?, ?)
      `, ['usuario@sistema.com', 'Usuário', hashedPassword, 'user']);
    }
  });
});

// ============================================================================
// FUNÇÕES DE SINCRONIZAÇÃO COM ANVISA
// ============================================================================

const ANVISA_CSV_URL = 'https://www.gov.br/anvisa/pt-br/centrais-de-conteudo/publicacoes/medicamentos/cmed/relacao-de-produtos-com-preco-maximo-de-venda-ao-governo-pmvg/lista-de-preco-de-medicamento.csv';

/**
 * Baixar e processar CSV da ANVISA
 */
async function syncPMVGData() {
  console.log('🔄 Iniciando sincronização com ANVISA...');
  
  let medicamentosProcessados = 0;
  let novos = 0;
  let atualizados = 0;
  
  try {
    // Baixar CSV da ANVISA
    console.log('📥 Baixando CSV da ANVISA...');
    const response = await axios({
      method: 'GET',
      url: ANVISA_CSV_URL,
      responseType: 'stream',
      timeout: 300000, // 5 minutos
      headers: {
        'User-Agent': 'Sistema-PMVG/1.0'
      }
    });

    const medicamentos = [];
    
    // Processar CSV
    await new Promise((resolve, reject) => {
      response.data
        .pipe(csvParser({
          separator: ';', // CSV da ANVISA usa ponto e vírgula
          skipEmptyLines: true,
          headers: [
            'codigo', 'nome', 'laboratorio', 'apresentacao', 
            'categoria', 'pmvg', 'campo_extra_1', 'campo_extra_2'
          ]
        }))
        .on('data', (row) => {
          // Limpar e validar dados
          const medicamento = {
            codigo: String(row.codigo || '').trim(),
            nome: String(row.nome || '').trim().toUpperCase(),
            laboratorio: String(row.laboratorio || '').trim().toUpperCase(),
            apresentacao: String(row.apresentacao || '').trim(),
            categoria: categorizeByName(row.nome || ''),
            pmvg: parseFloat(String(row.pmvg || '0').replace(',', '.')) || 0
          };

          // Validar dados essenciais
          if (medicamento.codigo && medicamento.nome && medicamento.pmvg > 0) {
            medicamentos.push(medicamento);
          }
        })
        .on('end', () => {
          console.log(`📊 CSV processado: ${medicamentos.length} medicamentos válidos`);
          resolve();
        })
        .on('error', reject);
    });

    // Salvar no banco de dados
    console.log('💾 Salvando no banco de dados...');
    
    for (const med of medicamentos) {
      medicamentosProcessados++;
      
      // Verificar se medicamento já existe
      const existingMed = await new Promise((resolve, reject) => {
        db.get(
          "SELECT id, pmvg FROM medicamentos_pmvg WHERE codigo = ?",
          [med.codigo],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (existingMed) {
        // Atualizar medicamento existente
        if (existingMed.pmvg !== med.pmvg) {
          await new Promise((resolve, reject) => {
            db.run(`
              UPDATE medicamentos_pmvg 
              SET nome = ?, laboratorio = ?, apresentacao = ?, categoria = ?, 
                  pmvg = ?, ultima_atualizacao = DATE('now'), updated_at = CURRENT_TIMESTAMP
              WHERE codigo = ?
            `, [med.nome, med.laboratorio, med.apresentacao, med.categoria, med.pmvg, med.codigo],
            (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
          atualizados++;
        }
      } else {
        // Inserir novo medicamento
        await new Promise((resolve, reject) => {
          db.run(`
            INSERT INTO medicamentos_pmvg 
            (codigo, nome, laboratorio, apresentacao, categoria, pmvg, ultima_atualizacao)
            VALUES (?, ?, ?, ?, ?, ?, DATE('now'))
          `, [med.codigo, med.nome, med.laboratorio, med.apresentacao, med.categoria, med.pmvg],
          (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        novos++;
      }
    }

    // Registrar log de sincronização
    await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO sync_logs 
        (medicamentos_processados, novos, atualizados, status, detalhes)
        VALUES (?, ?, ?, ?, ?)
      `, [
        medicamentosProcessados, 
        novos, 
        atualizados, 
        'sucesso',
        `Sincronização completa. Total: ${medicamentosProcessados}, Novos: ${novos}, Atualizados: ${atualizados}`
      ], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    console.log('✅ Sincronização PMVG concluída com sucesso!');
    console.log(`📊 Processados: ${medicamentosProcessados} | Novos: ${novos} | Atualizados: ${atualizados}`);
    
    return {
      success: true,
      medicamentosProcessados,
      novos,
      atualizados
    };

  } catch (error) {
    console.error('❌ Erro na sincronização:', error.message);
    
    // Registrar erro no log
    db.run(`
      INSERT INTO sync_logs 
      (medicamentos_processados, novos, atualizados, status, detalhes)
      VALUES (?, ?, ?, ?, ?)
    `, [0, 0, 0, 'erro', error.message]);
    
    throw error;
  }
}

/**
 * Categorizar medicamento por nome
 */
function categorizeByName(nome) {
  const nomeUpper = nome.toUpperCase();
  
  if (nomeUpper.includes('DIPIRONA') || nomeUpper.includes('PARACETAMOL') || nomeUpper.includes('IBUPROFENO')) {
    return 'Analgésico';
  }
  if (nomeUpper.includes('AMOXICILINA') || nomeUpper.includes('AZITROMICINA') || nomeUpper.includes('CEFALEXINA')) {
    return 'Antibiótico';
  }
  if (nomeUpper.includes('LOSARTANA') || nomeUpper.includes('ENALAPRIL') || nomeUpper.includes('CAPTOPRIL')) {
    return 'Anti-hipertensivo';
  }
  if (nomeUpper.includes('OMEPRAZOL') || nomeUpper.includes('RANITIDINA') || nomeUpper.includes('PANTOPRAZOL')) {
    return 'Antiácido';
  }
  if (nomeUpper.includes('DEXAMETASONA') || nomeUpper.includes('PREDNISOLONA') || nomeUpper.includes('DICLOFENACO')) {
    return 'Anti-inflamatório';
  }
  if (nomeUpper.includes('METFORMINA') || nomeUpper.includes('GLIBENCLAMIDA') || nomeUpper.includes('INSULINA')) {
    return 'Antidiabético';
  }
  if (nomeUpper.includes('SINVASTATINA') || nomeUpper.includes('ATORVASTATINA')) {
    return 'Hipolipemiante';
  }
  if (nomeUpper.includes('FUROSEMIDA') || nomeUpper.includes('HIDROCLOROTIAZIDA')) {
    return 'Diurético';
  }
  
  return 'Outros';
}

// ============================================================================
// CRON JOB - ATUALIZAÇÃO AUTOMÁTICA DIA 28
// ============================================================================

// Executar todo dia 28 às 06:00h
cron.schedule('0 6 28 * *', async () => {
  console.log('🕕 Cron Job ativado: Sincronização mensal PMVG (dia 28)');
  try {
    await syncPMVGData();
    console.log('✅ Sincronização automática concluída');
  } catch (error) {
    console.error('❌ Erro na sincronização automática:', error);
  }
}, {
  scheduled: true,
  timezone: "America/Sao_Paulo"
});

// Executar sincronização na inicialização (apenas se não houver dados)
setTimeout(async () => {
  const count = await new Promise((resolve, reject) => {
    db.get("SELECT COUNT(*) as count FROM medicamentos_pmvg", (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
  
  if (count === 0) {
    console.log('🚀 Primeira execução: iniciando sincronização inicial...');
    try {
      await syncPMVGData();
    } catch (error) {
      console.error('❌ Erro na sincronização inicial:', error);
    }
  } else {
    console.log(`📊 Base PMVG já possui ${count} medicamentos`);
  }
}, 5000); // Aguardar 5 segundos após inicialização

// ============================================================================
// MIDDLEWARE DE AUTENTICAÇÃO
// ============================================================================

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token de acesso requerido' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token inválido' });
    }
    req.user = user;
    next();
  });
};

// ============================================================================
// ROTAS DE AUTENTICAÇÃO
// ============================================================================

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM users WHERE email = ?",
        [email],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ============================================================================
// ROTAS PMVG E MEDICAMENTOS
// ============================================================================

// Status da base PMVG
app.get('/api/pmvg/status', authenticateToken, async (req, res) => {
  try {
    const stats = await new Promise((resolve, reject) => {
      db.get(`
        SELECT 
          COUNT(*) as totalMedicamentos,
          MAX(ultima_atualizacao) as lastUpdate
        FROM medicamentos_pmvg 
        WHERE ativo = 1
      `, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    const lastSync = await new Promise((resolve, reject) => {
      db.get(`
        SELECT * FROM sync_logs 
        WHERE status = 'sucesso' 
        ORDER BY data_sync DESC 
        LIMIT 1
      `, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    res.json({
      totalMedicamentos: stats.totalMedicamentos,
      lastUpdate: stats.lastUpdate,
      lastUpdateDetails: lastSync ? {
        medicamentosProcessados: lastSync.medicamentos_processados,
        novos: lastSync.novos,
        atualizados: lastSync.atualizados,
        dataSync: lastSync.data_sync
      } : null,
      status: 'ativo'
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar status PMVG' });
  }
});

// Buscar medicamentos
app.get('/api/medicamentos/search', authenticateToken, async (req, res) => {
  const { q } = req.query;
  
  if (!q || q.length < 2) {
    return res.json([]);
  }

  try {
    const medicamentos = await new Promise((resolve, reject) => {
      db.all(`
        SELECT 
          codigo, nome, laboratorio, apresentacao, categoria, pmvg, 
          preco_fabrica, ultima_atualizacao
        FROM medicamentos_pmvg 
        WHERE ativo = 1 
          AND (
            nome LIKE ? OR 
            laboratorio LIKE ? OR 
            codigo LIKE ?
          )
        ORDER BY nome
        LIMIT 50
      `, [`%${q.toUpperCase()}%`, `%${q.toUpperCase()}%`, `%${q}%`], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    const formattedMedicamentos = medicamentos.map(med => ({
      id: med.codigo,
      codigo: med.codigo,
      nome: med.nome,
      laboratorio: med.laboratorio,
      apresentacao: med.apresentacao,
      categoria: med.categoria,
      pmvg: med.pmvg,
      precoFabrica: med.preco_fabrica,
      ultimaAtualizacao: med.ultima_atualizacao
    }));

    res.json(formattedMedicamentos);
  } catch (error) {
    console.error('Erro na busca:', error);
    res.status(500).json({ error: 'Erro ao buscar medicamentos' });
  }
});

// Atualizar preço de fábrica
app.put('/api/medicamentos/:id/preco-fabrica', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { precoFabrica } = req.body;

  try {
    await new Promise((resolve, reject) => {
      db.run(`
        UPDATE medicamentos_pmvg 
        SET preco_fabrica = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE codigo = ?
      `, [precoFabrica, id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({ success: true, message: 'Preço de fábrica atualizado' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar preço de fábrica' });
  }
});

// Sincronizar manualmente
app.post('/api/pmvg/sync', authenticateToken, async (req, res) => {
  // Apenas admins podem sincronizar manualmente
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  try {
    const result = await syncPMVGData();
    res.json({
      success: true,
      message: 'Sincronização concluída',
      data: result
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Erro na sincronização',
      details: error.message 
    });
  }
});

// ============================================================================
// ROTAS DE LICITAÇÕES
// ============================================================================

// Listar licitações
app.get('/api/licitacoes', authenticateToken, async (req, res) => {
  try {
    const licitacoes = await new Promise((resolve, reject) => {
      db.all(`
        SELECT * FROM licitacoes 
        WHERE user_id = ? OR ? = 'admin'
        ORDER BY created_at DESC
      `, [req.user.id, req.user.role], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    res.json(licitacoes);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar licitações' });
  }
});

// Criar licitação
app.post('/api/licitacoes', authenticateToken, async (req, res) => {
  const { numero, orgao, dataPublicacao, dataVencimento, valor, vigenciaContratual, observacoes } = req.body;

  try {
    const result = await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO licitacoes 
        (numero, orgao, data_publicacao, data_vencimento, valor, vigencia_contratual, observacoes, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [numero, orgao, dataPublicacao, dataVencimento, valor, vigenciaContratual, observacoes, req.user.id],
      function(err) {
        if (err) reject(err);
        else resolve({ id: this.lastID });
      });
    });

    res.json({ success: true, id: result.id });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar licitação' });
  }
});

// Excluir licitação
app.delete('/api/licitacoes/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    await new Promise((resolve, reject) => {
      db.run(`
        DELETE FROM licitacoes 
        WHERE id = ? AND (user_id = ? OR ? = 'admin')
      `, [id, req.user.id, req.user.role], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({ sucesso: true, message: 'Licitação excluída' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao excluir licitação' });
  }
});

// ============================================================================
// ROTAS DE ALERTAS
// ============================================================================

// Listar alertas
app.get('/api/alertas', authenticateToken, async (req, res) => {
  try {
    const alertas = await new Promise((resolve, reject) => {
      db.all(`
        SELECT * FROM alertas 
        WHERE user_id = ? OR ? = 'admin'
        ORDER BY data_geracao DESC
      `, [req.user.id, req.user.role], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    res.json(alertas);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar alertas' });
  }
});

// Resolver alerta
app.put('/api/alertas/:id/resolver', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    await new Promise((resolve, reject) => {
      db.run(`
        UPDATE alertas 
        SET status = 'resolvido' 
        WHERE id = ? AND (user_id = ? OR ? = 'admin')
      `, [id, req.user.id, req.user.role], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({ success: true, message: 'Alerta resolvido' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao resolver alerta' });
  }
});

// ============================================================================
// ROTAS DE SISTEMA
// ============================================================================

// Status do sistema
app.get('/api/system/status', authenticateToken, (req, res) => {
  res.json({
    status: 'ativo',
    version: '1.0.0',
    database: 'conectado',
    pmvg_sync: 'ativo',
    last_check: new Date().toISOString()
  });
});

// ============================================================================
// ROTAS DE RELATÓRIOS E NOTIFICAÇÕES
// ============================================================================

// Exportar relatórios
app.get('/api/relatorios/:type', authenticateToken, async (req, res) => {
  const { type } = req.params;
  const { format } = req.query;

  try {
    let data = [];
    
    switch (type) {
      case 'medicamentos':
        data = await new Promise((resolve, reject) => {
          db.all("SELECT * FROM medicamentos_pmvg WHERE ativo = 1", (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          });
        });
        break;
      case 'licitacoes':
        data = await new Promise((resolve, reject) => {
          db.all("SELECT * FROM licitacoes", (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          });
        });
        break;
    }

    if (format === 'csv') {
      const csvData = createObjectCsvStringifier({
        header: Object.keys(data[0] || {}).map(key => ({ id: key, title: key }))
      });
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${type}.csv"`);
      res.send(csvData.getHeaderString() + csvData.stringifyRecords(data));
    } else {
      res.json(data);
    }
  } catch (error) {
    res.status(500).json({ error: 'Erro ao gerar relatório' });
  }
});

// Enviar notificação por email (mock)
app.post('/api/notifications/email', authenticateToken, (req, res) => {
  const { type, recipient, data } = req.body;
  
  // Em produção, integrar com serviço de email real (SendGrid, AWS SES, etc.)
  console.log(`📧 Email enviado para ${recipient}:`, { type, data });
  
  res.json({ success: true, message: 'Email enviado' });
});

// ============================================================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================================================

// Rota de teste
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Sistema PMVG Backend funcionando',
    timestamp: new Date().toISOString()
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log('🚀 Sistema PMVG Backend iniciado!');
  console.log(`🌐 Servidor rodando na porta ${PORT}`);
  console.log(`📊 Base de dados: ${DB_PATH}`);
  console.log('🔄 Cron job ativo: Sincronização todo dia 28 às 06:00h');
  console.log('✅ Pronto para receber requisições!');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Encerrando servidor...');
  db.close((err) => {
    if (err) {
      console.error(err.message);
    }
    console.log('💾 Conexão com banco de dados fechada.');
    process.exit(0);
  });
});

module.exports = app;
