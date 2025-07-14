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

// ✅ MODIFICADO: URL do GitHub para carregar dados processados
const GITHUB_CMED_URL = 'https://raw.githubusercontent.com/rafaelmpcb/sistema-pmvg-backend/main/data/cmed-pmvg.json';

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

// ✅ NOVO: Função para carregar dados CMED do GitHub (processados pelo GitHub Actions)
const loadPMVGFromGitHub = async () => {
  try {
    console.log('🔄 Carregando base CMED do GitHub...');
    console.log('📡 URL:', GITHUB_CMED_URL);

    // Download rápido do GitHub (muito mais confiável que ANVISA direta)
    const response = await axios({
      method: 'GET',
      url: GITHUB_CMED_URL,
      timeout: 30000, // 30 segundos é suficiente para GitHub
      headers: {
        'User-Agent': 'Sistema-PMVG/1.0',
        'Accept': 'application/json'
      }
    });

    console.log('✅ Dados carregados do GitHub!');

    const data = response.data;
    
    // Validações
    if (!data.medicamentos || !Array.isArray(data.medicamentos)) {
      throw new Error('Formato de dados inválido - medicamentos não é array');
    }

    if (data.medicamentos.length === 0) {
      throw new Error('Base CMED vazia - sem medicamentos válidos');
    }

    console.log(`📊 Total de medicamentos: ${data.medicamentos.length}`);
    console.log(`📅 Última atualização: ${data.metadata?.dataProcessamento || 'N/A'}`);
    console.log(`🏛️ Fonte: ${data.metadata?.fonte || 'GitHub Actions + ANVISA'}`);

    // Limpar tabela existente
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM medicamentos', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    let inseridos = 0;
    const batchSize = 100;
    const medicamentos = data.medicamentos;

    // Inserir medicamentos em lotes para performance
    for (let i = 0; i < medicamentos.length; i += batchSize) {
      const batch = medicamentos.slice(i, i + batchSize);
      
      const stmt = db.prepare(`INSERT OR REPLACE INTO medicamentos 
        (codigo, nome, laboratorio, apresentacao, categoria, pmvg, preco_fabrica, icms_0, icms_12, icms_17, icms_18, icms_20, icms_21) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

      for (const med of batch) {
        stmt.run([
          med.codigo,
          med.nome,
          med.laboratorio,
          med.apresentacao,
          'Medicamento',
          med.pmvg,
          med.preco_fabrica,
          med.icms_0,
          med.icms_12,
          med.icms_17,
          med.icms_18,
          med.icms_20,
          med.icms_21
        ]);
        inseridos++;
      }

      stmt.finalize();

      // Log de progresso
      if (i % 1000 === 0) {
        console.log(`📊 Inseridos: ${inseridos}/${medicamentos.length}`);
      }
    }

    console.log(`✅ Base CMED carregada com sucesso!`);
    console.log(`💾 Total inseridos: ${inseridos}`);
    console.log(`🗄️ Fonte: GitHub Actions + ANVISA (dados reais)`);

    return { success: true, inseridos, fonte: 'GitHub-ANVISA', totalMedicamentos: inseridos };

  } catch (error) {
    console.error('❌ Erro ao carregar base CMED do GitHub:', error.message);
    console.error('⚠️ Sistema funcionará SEM dados da CMED até próxima sincronização');
    
    // ✅ NÃO carregar dados demo - apenas lançar erro
    throw new Error(`Falha ao carregar base CMED: ${error.message}`);
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
    message: 'Sistema PMVG Backend - Conectado com dados reais da ANVISA via GitHub Actions!'
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
    anvisa_integration: 'active_via_github_actions',
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
      fonte: 'GitHub Actions + ANVISA/CMED',
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

// ✅ MODIFICADO: Forçar sincronização manual (agora do GitHub)
app.post('/api/pmvg/sync', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem forçar sincronização' });
    }

    const result = await loadPMVGFromGitHub();
    res.json({
      message: 'Sincronização concluída com sucesso',
      fonte: 'GitHub Actions + ANVISA',
      metodo: 'Carregamento otimizado do GitHub',
      ...result
    });
  } catch (error) {
    console.error('Erro na sincronização manual:', error);
    res.status(500).json({ 
      error: 'Erro na sincronização',
      details: error.message,
      solucao: 'Execute o GitHub Action manualmente ou aguarde a sincronização automática'
    });
  }
});

// ============= CRON JOB =============

// ✅ MODIFICADO: Cron para recarregar do GitHub (mais frequente que a sincronização ANVISA)
cron.schedule('0 7 28 * *', async () => {
  console.log('🕖 Executando recarga automática da base CMED do GitHub...');
  try {
    await loadPMVGFromGitHub();
    console.log('✅ Recarga automática concluída com sucesso!');
  } catch (error) {
    console.error('❌ Erro na recarga automática:', error.message);
    console.log('⚠️ Mantendo base atual até próxima tentativa');
  }
});

// ============= INICIALIZAÇÃO =============

app.listen(PORT, async () => {
  console.log('🚀 Sistema PMVG Backend iniciado!');
  console.log(`🌐 Servidor rodando na porta ${PORT}`);
  console.log(`📊 Base de dados: ${dbPath}`);
  console.log('🔄 Cron job ativo: Recarga base CMED todo dia 28 às 07:00h');
  console.log('🗂️ Fonte de dados: GitHub Actions + ANVISA (processamento otimizado)');
  console.log('✅ Pronto para receber requisições!');

  // ✅ MODIFICADO: Verificar e carregar base do GitHub
  setTimeout(async () => {
    db.get('SELECT COUNT(*) as total FROM medicamentos', async (err, result) => {
      if (!err) {
        if (result.total === 0) {
          console.log('🚀 Primeira execução: carregando base CMED do GitHub...');
          try {
            await loadPMVGFromGitHub();
            console.log('🎉 Base CMED carregada com sucesso! Sistema pronto para uso.');
          } catch (error) {
            console.log('❌ Erro ao carregar base inicial:', error.message);
            console.log('⚠️ SISTEMA FUNCIONARÁ SEM DADOS CMED');
            console.log('🔧 Soluções:');
            console.log('   1. Execute GitHub Action manualmente');
            console.log('   2. Aguarde próxima sincronização automática');
            console.log('   3. Verifique se arquivo data/cmed-pmvg.json existe no GitHub');
          }
        } else {
          console.log(`✅ Base já carregada com ${result.total} medicamentos`);
          
          // Tentar atualizar em background se disponível
          try {
            await loadPMVGFromGitHub();
            console.log('🔄 Base atualizada em background com dados mais recentes');
          } catch (error) {
            console.log('⚠️ Falha na atualização background - mantendo base atual');
            console.log(`📊 Continuando com ${result.total} medicamentos em cache`);
          }
        }
      }
    });
  }, 5000); // Aguardar 5 segundos após inicialização
});
