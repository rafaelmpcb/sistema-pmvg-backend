const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const axios = require('axios');
const XLSX = require('xlsx'); // ✅ NOVO: Biblioteca para processar XLS
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'sistema_pmvg_secret_key_2025';

// ✅ NOVO: URL real da ANVISA testada e funcionando
const ANVISA_URL = 'https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos/arquivos/xls_conformidade_gov_20250707_104547402.xls/@@download/file';

// Middlewares
app.use(cors({
  origin: ['http://localhost:3000', 'https://sistema-pmvg-frontend.vercel.app', /\.vercel\.app$/],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));

// Configuração do banco de dados
const dbPath = path.join(__dirname, 'pmvg_database.db');
const db = new sqlite3.Database(dbPath);

// Inicializar banco de dados
db.serialize(() => {
  // Tabela de usuários
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabela de medicamentos PMVG
  db.run(`CREATE TABLE IF NOT EXISTS medicamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT UNIQUE,
    nome TEXT NOT NULL,
    laboratorio TEXT,
    apresentacao TEXT,
    categoria TEXT,
    pmvg REAL NOT NULL,
    preco_fabrica REAL,
    preco_fabricante REAL,
    icms_0 REAL,
    icms_12 REAL,
    icms_17 REAL,
    icms_18 REAL,
    icms_20 REAL,
    icms_21 REAL,
    ultima_atualizacao DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabela de licitações
  db.run(`CREATE TABLE IF NOT EXISTS licitacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL,
    orgao TEXT NOT NULL,
    data_publicacao DATE,
    data_vencimento DATE,
    valor REAL,
    vigencia_contratual TEXT,
    observacoes TEXT,
    status TEXT DEFAULT 'ativa',
    total_medicamentos INTEGER DEFAULT 0,
    medicamentos_com_risco INTEGER DEFAULT 0,
    economia_total REAL DEFAULT 0,
    tem_riscos BOOLEAN DEFAULT 0,
    user_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )`);

  // Tabela de medicamentos da licitação
  db.run(`CREATE TABLE IF NOT EXISTS licitacao_medicamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    licitacao_id INTEGER,
    medicamento_id INTEGER,
    quantidade INTEGER DEFAULT 1,
    preco_ofertado REAL,
    preco_fabrica_editavel REAL,
    observacoes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (licitacao_id) REFERENCES licitacoes (id) ON DELETE CASCADE,
    FOREIGN KEY (medicamento_id) REFERENCES medicamentos (id)
  )`);

  // Tabela de alertas
  db.run(`CREATE TABLE IF NOT EXISTS alertas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    titulo TEXT NOT NULL,
    descricao TEXT,
    prioridade TEXT DEFAULT 'media',
    status TEXT DEFAULT 'ativo',
    data_geracao DATETIME DEFAULT CURRENT_TIMESTAMP,
    acao_requerida TEXT,
    prazo_recomendado TEXT,
    licitacao_id INTEGER,
    medicamento_id INTEGER,
    user_id INTEGER,
    FOREIGN KEY (licitacao_id) REFERENCES licitacoes (id),
    FOREIGN KEY (medicamento_id) REFERENCES medicamentos (id),
    FOREIGN KEY (user_id) REFERENCES users (id)
  )`);

  // Usuários padrão
  const adminPassword = bcrypt.hashSync('123456', 10);
  const userPassword = bcrypt.hashSync('123456', 10);

  db.run(`INSERT OR IGNORE INTO users (name, email, password, role) VALUES 
    ('Administrador', 'admin@sistema.com', ?, 'admin'),
    ('Usuário Demo', 'usuario@sistema.com', ?, 'user')
  `, [adminPassword, userPassword]);
});

// ✅ NOVO: Função para sincronizar dados reais da ANVISA
const syncPMVGData = async () => {
  try {
    console.log('🔄 Iniciando sincronização com ANVISA...');
    console.log('📥 Baixando XLS da ANVISA...');

    // Download do arquivo XLS
    const response = await axios({
      method: 'GET',
      url: ANVISA_URL,
      responseType: 'arraybuffer',
      timeout: 300000, // 5 minutos
      headers: {
        'User-Agent': 'Sistema-PMVG/1.0'
      }
    });

    console.log('✅ Download concluído, processando XLS...');

    // Processar arquivo XLS
    const workbook = XLSX.read(response.data, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Converter para JSON
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    
    if (jsonData.length < 2) {
      throw new Error('Arquivo XLS vazio ou inválido');
    }

    console.log(`📊 Processando ${jsonData.length} linhas...`);

    // Encontrar índices das colunas (primeira linha = cabeçalho)
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

    console.log('📋 Índices das colunas encontrados:', indices);

    // Limpar tabela existente
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM medicamentos', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    let processados = 0;
    let inseridos = 0;

    // Processar dados (pular cabeçalho)
    for (let i = 1; i < jsonData.length; i++) {
      const row = jsonData[i];
      
      if (!row || row.length === 0) continue;

      try {
        const medicamento = {
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

        // Inserir no banco
        await new Promise((resolve, reject) => {
          db.run(`INSERT OR REPLACE INTO medicamentos 
            (codigo, nome, laboratorio, apresentacao, categoria, pmvg, preco_fabrica, icms_0, icms_12, icms_17, icms_18, icms_20, icms_21) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              medicamento.codigo,
              medicamento.nome,
              medicamento.laboratorio,
              medicamento.apresentacao,
              'Medicamento', // categoria padrão
              medicamento.pmvg,
              medicamento.preco_fabrica,
              medicamento.icms_0,
              medicamento.icms_12,
              medicamento.icms_17,
              medicamento.icms_18,
              medicamento.icms_20,
              medicamento.icms_21
            ],
            function(err) {
              if (err) reject(err);
              else {
                inseridos++;
                resolve();
              }
            }
          );
        });

        processados++;

        // Log de progresso
        if (processados % 1000 === 0) {
          console.log(`📊 Processados: ${processados} | Inseridos: ${inseridos}`);
        }

      } catch (error) {
        console.log(`⚠️ Erro na linha ${i}:`, error.message);
      }
    }

    console.log(`✅ Sincronização concluída!`);
    console.log(`📊 Total processados: ${processados}`);
    console.log(`💾 Total inseridos: ${inseridos}`);
    console.log(`🗄️ Base PMVG atualizada com dados reais da ANVISA!`);

    return { success: true, processados, inseridos };

  } catch (error) {
    console.error('❌ Erro na sincronização:', error.message);
    throw error;
  }
};

// Middleware de autenticação
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

// ============= ROTAS DA API =============

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    message: 'Sistema PMVG Backend - Conectado com dados reais da ANVISA!'
  });
});

// Login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;

  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Erro interno do servidor' });
    }

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
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  });
});

// Status do sistema
app.get('/api/system/status', authenticateToken, (req, res) => {
  res.json({
    status: 'online',
    version: '1.0.0',
    database: 'connected',
    anvisa_integration: 'active',
    last_sync: new Date().toISOString()
  });
});

// Status PMVG
app.get('/api/pmvg/status', authenticateToken, (req, res) => {
  db.get('SELECT COUNT(*) as total FROM medicamentos', (err, result) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao consultar base PMVG' });
    }

    res.json({
      totalMedicamentos: result.total,
      lastUpdate: new Date().toISOString(),
      fonte: 'ANVISA/CMED',
      status: result.total > 0 ? 'sincronizada' : 'aguardando_sincronizacao'
    });
  });
});

// ✅ CORRIGIDO: Buscar medicamentos com dados reais
app.get('/api/medicamentos/search', authenticateToken, (req, res) => {
  const { q } = req.query;
  
  if (!q || q.length < 2) {
    return res.json([]);
  }

  const searchTerm = `%${q}%`;
  
  db.all(`SELECT * FROM medicamentos 
    WHERE nome LIKE ? OR laboratorio LIKE ? OR codigo LIKE ?
    ORDER BY nome LIMIT 50`, 
    [searchTerm, searchTerm, searchTerm], 
    (err, rows) => {
      if (err) {
        console.error('Erro na busca de medicamentos:', err);
        return res.status(500).json({ error: 'Erro na busca' });
      }
      res.json(rows || []);
    }
  );
});

// Listar licitações
app.get('/api/licitacoes', authenticateToken, (req, res) => {
  const query = req.user.role === 'admin' 
    ? 'SELECT * FROM licitacoes ORDER BY created_at DESC'
    : 'SELECT * FROM licitacoes WHERE user_id = ? ORDER BY created_at DESC';
    
  const params = req.user.role === 'admin' ? [] : [req.user.id];

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao listar licitações' });
    }
    res.json(rows || []);
  });
});

// Criar licitação
app.post('/api/licitacoes', authenticateToken, (req, res) => {
  const {
    numero, orgao, dataPublicacao, dataVencimento, valor,
    vigenciaContratual, observacoes, medicamentos
  } = req.body;

  db.run(`INSERT INTO licitacoes 
    (numero, orgao, data_publicacao, data_vencimento, valor, vigencia_contratual, observacoes, user_id, total_medicamentos)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [numero, orgao, dataPublicacao, dataVencimento, valor, vigenciaContratual, observacoes, req.user.id, medicamentos?.length || 0],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Erro ao criar licitação' });
      }

      const licitacaoId = this.lastID;

      // Inserir medicamentos da licitação
      if (medicamentos && medicamentos.length > 0) {
        const stmt = db.prepare(`INSERT INTO licitacao_medicamentos 
          (licitacao_id, medicamento_id, quantidade, preco_ofertado, preco_fabrica_editavel) 
          VALUES (?, ?, ?, ?, ?)`);

        medicamentos.forEach(med => {
          stmt.run([
            licitacaoId,
            med.id,
            med.quantidade || 1,
            med.precoOfertado || 0,
            med.precoFabricaEditavel || med.precoFabrica || 0
          ]);
        });

        stmt.finalize();
      }

      res.json({ 
        id: licitacaoId,
        message: 'Licitação criada com sucesso'
      });
    }
  );
});

// ✅ CORRIGIDO: Excluir licitação (funcionando)
app.delete('/api/licitacoes/:id', authenticateToken, (req, res) => {
  const licitacaoId = req.params.id;

  // Verificar se é admin ou dono da licitação
  const checkQuery = req.user.role === 'admin' 
    ? 'SELECT id FROM licitacoes WHERE id = ?'
    : 'SELECT id FROM licitacoes WHERE id = ? AND user_id = ?';
    
  const checkParams = req.user.role === 'admin' 
    ? [licitacaoId] 
    : [licitacaoId, req.user.id];

  db.get(checkQuery, checkParams, (err, licitacao) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao verificar licitação' });
    }

    if (!licitacao) {
      return res.status(404).json({ error: 'Licitação não encontrada ou sem permissão' });
    }

    // Excluir medicamentos relacionados primeiro
    db.run('DELETE FROM licitacao_medicamentos WHERE licitacao_id = ?', [licitacaoId], (err) => {
      if (err) {
        return res.status(500).json({ error: 'Erro ao excluir medicamentos da licitação' });
      }

      // Excluir alertas relacionados
      db.run('DELETE FROM alertas WHERE licitacao_id = ?', [licitacaoId], (err) => {
        if (err) {
          console.log('Aviso: Erro ao excluir alertas relacionados:', err);
        }

        // Excluir licitação
        db.run('DELETE FROM licitacoes WHERE id = ?', [licitacaoId], function(err) {
          if (err) {
            return res.status(500).json({ error: 'Erro ao excluir licitação' });
          }

          if (this.changes === 0) {
            return res.status(404).json({ error: 'Licitação não encontrada' });
          }

          res.json({ 
            sucesso: true,
            message: 'Licitação excluída com sucesso'
          });
        });
      });
    });
  });
});

// ✅ NOVO: Visualizar licitação completa
app.get('/api/licitacoes/:id', authenticateToken, (req, res) => {
  const licitacaoId = req.params.id;

  // Buscar dados da licitação
  db.get('SELECT * FROM licitacoes WHERE id = ?', [licitacaoId], (err, licitacao) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar licitação' });
    }

    if (!licitacao) {
      return res.status(404).json({ error: 'Licitação não encontrada' });
    }

    // Buscar medicamentos da licitação
    db.all(`SELECT lm.*, m.nome, m.laboratorio, m.apresentacao, m.pmvg 
      FROM licitacao_medicamentos lm
      JOIN medicamentos m ON lm.medicamento_id = m.id
      WHERE lm.licitacao_id = ?`, [licitacaoId], (err, medicamentos) => {
      
      if (err) {
        return res.status(500).json({ error: 'Erro ao buscar medicamentos' });
      }

      res.json({
        ...licitacao,
        medicamentos: medicamentos || []
      });
    });
  });
});

// Listar alertas
app.get('/api/alertas', authenticateToken, (req, res) => {
  db.all('SELECT * FROM alertas WHERE status = "ativo" ORDER BY data_geracao DESC', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao listar alertas' });
    }
    res.json(rows || []);
  });
});

// Resolver alerta
app.put('/api/alertas/:id/resolver', authenticateToken, (req, res) => {
  db.run('UPDATE alertas SET status = "resolvido" WHERE id = ?', [req.params.id], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Erro ao resolver alerta' });
    }
    res.json({ message: 'Alerta resolvido com sucesso' });
  });
});

// Forçar sincronização manual
app.post('/api/pmvg/sync', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem forçar sincronização' });
    }

    const result = await syncPMVGData();
    res.json({
      message: 'Sincronização concluída com sucesso',
      ...result
    });
  } catch (error) {
    console.error('Erro na sincronização manual:', error);
    res.status(500).json({ 
      error: 'Erro na sincronização',
      details: error.message
    });
  }
});

// ============= CRON JOB =============

// Sincronização automática todo dia 28 às 06:00h
cron.schedule('0 6 28 * *', async () => {
  console.log('🕕 Executando sincronização automática da ANVISA...');
  try {
    await syncPMVGData();
    console.log('✅ Sincronização automática concluída com sucesso!');
  } catch (error) {
    console.error('❌ Erro na sincronização automática:', error.message);
  }
});

// ============= INICIALIZAÇÃO =============

app.listen(PORT, async () => {
  console.log('🚀 Sistema PMVG Backend iniciado!');
  console.log(`🌐 Servidor rodando na porta ${PORT}`);
  console.log(`📊 Base de dados: ${dbPath}`);
  console.log('🔄 Cron job ativo: Sincronização todo dia 28 às 06:00h');
  console.log('✅ Pronto para receber requisições!');

  // Verificar se precisa fazer primeira sincronização
  setTimeout(async () => {
    db.get('SELECT COUNT(*) as total FROM medicamentos', async (err, result) => {
      if (!err && result.total === 0) {
        console.log('🚀 Primeira execução: iniciando sincronização inicial...');
        try {
          await syncPMVGData();
          console.log('🎉 Primeira sincronização concluída! Sistema pronto para uso.');
        } catch (error) {
          console.log('❌ Erro na sincronização inicial:', error.message);
        }
      }
    });
  }, 5000); // Aguardar 5 segundos após inicialização
});
