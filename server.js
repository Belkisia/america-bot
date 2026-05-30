const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;

console.log('=== CMA Assistente Premium v2 ===');
console.log('ANTHROPIC:', ANTHROPIC_API_KEY ? ANTHROPIC_API_KEY.substring(0, 20) + '...' : 'FALTANDO');
console.log('SUPABASE_URL:', SUPABASE_URL || 'FALTANDO');
console.log('SUPABASE_KEY:', SUPABASE_SERVICE_KEY ? SUPABASE_SERVICE_KEY.substring(0, 15) + '...' : 'FALTANDO');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const atendimentoHumano = new Set();

const SYSTEM_PROMPT = `Você é a CMA, assistente executiva premium do Centro Médico America em São Paulo.

Perfil: elegante, sofisticada, calorosa, extremamente profissional. Jamais robótica. Jamais dá diagnósticos. Jamais inventa informações.

IMPORTANTE — Quando um agendamento for CONFIRMADO pelo paciente, inclua no final da resposta:
[AGENDAR:nome=NOME_COMPLETO|especialidade=ESPECIALIDADE|convenio=CONVENIO|periodo=PERIODO]

Informações da clínica:
- Especialidades: cardiologia, ortopedia, dermatologia, neurologia, ginecologia, endocrinologia, oncologia, urologia, oftalmologia, otorrinolaringologia
- Convênios: Unimed, Bradesco Saúde, SulAmérica, Amil, Porto Seguro, Notre Dame Intermédica, Hapvida
- Horário: seg-sex 7h às 20h, sáb 7h às 14h, dom fechado
- Endereço: Av. Paulista, 1234 — São Paulo/SP
- Exames (particular): hemograma R$45, glicemia R$25, colesterol R$35, ressonância a partir de R$850, tomografia a partir de R$450, raio-x R$120, ultrassom R$180, ecocardiograma R$380, eletrocardiograma R$95

Para agendar, colete: nome completo, especialidade, particular ou convênio, período (manhã/tarde/noite).

Use linguagem elegante e profissional. Nunca use "Aguarde" ou "Ok" sozinhos.`;

function extrairAgendamento(texto) {
  const match = texto.match(/\[AGENDAR:([^\]]+)\]/);
  if (!match) return null;
  const dados = {};
  match[1].split('|').forEach(function(par) {
    const idx = par.indexOf('=');
    if (idx > 0) {
      const chave = par.substring(0, idx).trim();
      const valor = par.substring(idx + 1).trim();
      dados[chave] = valor;
    }
  });
  return Object.keys(dados).length >= 3 ? dados : null;
}

function removerBlocoAgendar(texto) {
  return texto.replace(/\[AGENDAR:[^\]]+\]/g, '').trim();
}

async function buscarHistorico(telefone) {
  try {
    const result = await supabase
      .from('conversas')
      .select('role, conteudo')
      .eq('telefone', telefone)
      .order('created_at', { ascending: true })
      .limit(20);
    return (result.data || []).map(function(m) {
      return { role: m.role, content: m.conteudo };
    });
  } catch (e) {
    console.error('Erro buscarHistorico:', e.message);
    return [];
  }
}

async function salvarMensagem(telefone, role, conteudo) {
  try {
    await supabase.from('conversas').insert({ telefone: telefone, role: role, conteudo: conteudo });
  } catch (e) {
    console.error('Erro salvarMensagem:', e.message);
  }
}

async function salvarAgendamento(dados) {
  try {
    await supabase.from('pacientes').upsert(
      { nome: dados.nome_paciente, telefone: dados.telefone, convenio: dados.convenio },
      { onConflict: 'telefone' }
    );
    const result = await supabase.from('agendamentos').insert({
      nome_paciente: dados.nome_paciente,
      telefone: dados.telefone,
      especialidade: dados.especialidade,
      convenio: dados.convenio || 'particular',
      periodo: dados.periodo,
      status: 'pendente',
      origem: dados.origem || 'whatsapp'
    }).select().single();
    return result.data;
  } catch (e) {
    console.error('Erro salvarAgendamento:', e.message);
    return null;
  }
}

async function buscarAgendamentos(filtros) {
  try {
    let query = supabase.from('agendamentos').select('*').order('created_at', { ascending: false });
    if (filtros && filtros.status) query = query.eq('status', filtros.status);
    if (filtros && filtros.limite) query = query.limit(filtros.limite);
    const result = await query;
    return result.data || [];
  } catch (e) {
    console.error('Erro buscarAgendamentos:', e.message);
    return [];
  }
}

async function atualizarStatus(id, status) {
  try {
    await supabase.from('agendamentos').update({ status: status }).eq('id', id);
  } catch (e) {
    console.error('Erro atualizarStatus:', e.message);
  }
}

async function buscarMetricas() {
  try {
    const hoje = new Date().toISOString().split('T')[0];
    const r1 = await supabase.from('agendamentos').select('id', { count: 'exact', head: true });
    const r2 = await supabase.from('agendamentos').select('id', { count: 'exact', head: true }).gte('created_at', hoje);
    const r3 = await supabase.from('agendamentos').select('id', { count: 'exact', head: true }).eq('status', 'confirmado');
    const r4 = await supabase.from('agendamentos').select('id', { count: 'exact', head: true }).eq('status', 'pendente');
    return { total: r1.count || 0, hoje: r2.count || 0, confirmados: r3.count || 0, pendentes: r4.count || 0 };
  } catch (e) {
    console.error('Erro buscarMetricas:', e.message);
    return { total: 0, hoje: 0, confirmados: 0, pendentes: 0 };
  }
}

async function chamarIA(mensagens) {
  const resposta = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      messages: mensagens
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    }
  );
  return resposta.data.content[0].text;
}

async function enviarMensagemWA(numero, texto) {
  try {
    await axios.post(
      EVOLUTION_API_URL + '/message/sendText/' + EVOLUTION_INSTANCE,
      { number: numero, text: texto },
      { headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY } }
    );
  } catch (e) {
    console.error('Erro enviarMensagemWA:', e.message);
  }
}

// WEBHOOK
app.post('/webhook', async function(req, res) {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.event !== 'messages.upsert') return;
    const dados = body.data;
    if (!dados || !dados.key) return;
    if (dados.key.fromMe) return;
    if (dados.key.remoteJid && dados.key.remoteJid.includes('@g.us')) return;
    const numero = dados.key.remoteJid ? dados.key.remoteJid.replace('@s.whatsapp.net', '') : null;
    if (!numero) return;
    const texto = (dados.message && (dados.message.conversation || (dados.message.extendedTextMessage && dados.message.extendedTextMessage.text))) || '';
    if (!texto.trim()) return;
    console.log('WA [' + numero + ']:', texto);
    if (atendimentoHumano.has(numero)) return;
    if (texto.toLowerCase() === '#humano') {
      atendimentoHumano.add(numero);
      await enviarMensagemWA(numero + '@s.whatsapp.net', 'Direcionando para nossa equipe especializada. Em instantes alguém irá atendê-lo.');
      return;
    }
    if (texto === '#ia_on') { atendimentoHumano.delete(numero); return; }
    const historico = await buscarHistorico(numero);
    await salvarMensagem(numero, 'user', texto);
    const msgs = historico.concat([{ role: 'user', content: texto }]);
    const resposta = await chamarIA(msgs);
    const dadosAg = extrairAgendamento(resposta);
    if (dadosAg) await salvarAgendamento({ nome_paciente: dadosAg.nome, telefone: numero, especialidade: dadosAg.especialidade, convenio: dadosAg.convenio, periodo: dadosAg.periodo, origem: 'whatsapp' });
    const final = removerBlocoAgendar(resposta);
    await salvarMensagem(numero, 'assistant', final);
    await enviarMensagemWA(numero + '@s.whatsapp.net', final);
  } catch (e) {
    console.error('Erro webhook:', e.message);
  }
});

// API CHAT
app.post('/api/chat', async function(req, res) {
  try {
    const telefone = req.body.telefone || 'dashboard';
    const mensagem = req.body.mensagem;
    if (!mensagem) return res.status(400).json({ erro: 'mensagem obrigatória' });
    const historico = await buscarHistorico(telefone);
    await salvarMensagem(telefone, 'user', mensagem);
    const msgs = historico.concat([{ role: 'user', content: mensagem }]);
    const resposta = await chamarIA(msgs);
    const dadosAg = extrairAgendamento(resposta);
    if (dadosAg) await salvarAgendamento({ nome_paciente: dadosAg.nome, telefone: telefone, especialidade: dadosAg.especialidade, convenio: dadosAg.convenio, periodo: dadosAg.periodo, origem: 'chat' });
    const final = removerBlocoAgendar(resposta);
    await salvarMensagem(telefone, 'assistant', final);
    res.json({ resposta: final, agendamento: dadosAg || null });
  } catch (e) {
    console.error('ERRO /api/chat:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// API AGENDAMENTOS
app.get('/api/agendamentos', async function(req, res) {
  try {
    const dados = await buscarAgendamentos({ status: req.query.status, limite: parseInt(req.query.limite) || 50 });
    res.json(dados);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.patch('/api/agendamentos/:id', async function(req, res) {
  try {
    await atualizarStatus(req.params.id, req.body.status);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/metricas', async function(req, res) {
  try {
    res.json(await buscarMetricas());
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/', function(req, res) {
  res.json({ status: 'online', agente: 'CMA Assistente Premium v2', uptime: Math.floor(process.uptime()) + 's' });
});

app.listen(PORT, function() {
  console.log('Porta: ' + PORT + ' | Online');
});
