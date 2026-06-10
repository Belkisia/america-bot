const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } }
);

async function buscarHistorico(telefone, limite) {
  if (!limite) limite = 20;
  try {
    const result = await supabase
      .from('conversas')
      .select('role, conteudo')
      .eq('telefone', telefone)
      .order('created_at', { ascending: true })
      .limit(limite);
    if (result.error) {
      console.error('ERRO buscarHistorico:', result.error.message);
      return [];
    }
    return (result.data || []).map(function(m) {
      return { role: m.role, content: m.conteudo };
    });
  } catch(e) {
    console.error('ERRO buscarHistorico exception:', e.message);
    return [];
  }
}

async function salvarMensagem(telefone, role, conteudo) {
  try {
    const result = await supabase
      .from('conversas')
      .insert({ telefone: telefone, role: role, conteudo: conteudo });
    if (result.error) {
      console.error('ERRO salvarMensagem [' + telefone + ']:', result.error.message);
    }
  } catch(e) {
    console.error('ERRO salvarMensagem exception [' + telefone + ']:', e.message);
  }
}

async function salvarAgendamento(dados) {
  await supabase.from('pacientes').upsert(
    { nome: dados.nome_paciente, telefone: dados.telefone, convenio: dados.convenio },
    { onConflict: 'telefone' }
  );
  const result = await supabase
    .from('agendamentos')
    .insert({
      nome_paciente: dados.nome_paciente,
      data_nascimento: dados.data_nascimento || null,
      telefone: dados.telefone,
      especialidade: dados.especialidade,
      convenio: dados.convenio || 'particular',
      periodo: dados.periodo,
      medico: dados.medico || null,
      status: 'pendente',
      origem: dados.origem || 'whatsapp'
    })
    .select()
    .single();
  if (result.error) throw result.error;
  return result.data;
}

async function buscarAgendamentos(filtros) {
  if (!filtros) filtros = {};
  var query = supabase
    .from('agendamentos')
    .select('*')
    .order('created_at', { ascending: false });
  if (filtros.status) query = query.eq('status', filtros.status);
  if (filtros.limite) query = query.limit(filtros.limite);
  const result = await query;
  return result.data || [];
}

async function atualizarStatus(id, status) {
  await supabase.from('agendamentos').update({ status: status }).eq('id', id);
}

async function logMensagem(telefone, mensagem, direcao) {
  try {
    await supabase.from('mensagens_whatsapp').insert({
      telefone: telefone,
      mensagem: mensagem,
      direcao: direcao
    });
  } catch(e) {}
}

async function buscarMetricas() {
  const hoje = new Date().toISOString().split('T')[0];
  const r1 = await supabase.from('agendamentos').select('id', { count: 'exact', head: true });
  const r2 = await supabase.from('agendamentos').select('id', { count: 'exact', head: true }).gte('created_at', hoje);
  const r3 = await supabase.from('agendamentos').select('id', { count: 'exact', head: true }).eq('status', 'confirmado');
  const r4 = await supabase.from('agendamentos').select('id', { count: 'exact', head: true }).eq('status', 'pendente');
  const r5 = await supabase.from('agendamentos').select('id', { count: 'exact', head: true }).eq('status', 'cancelado');
  return {
    total: r1.count || 0,
    hoje: r2.count || 0,
    confirmados: r3.count || 0,
    pendentes: r4.count || 0,
    cancelados: r5.count || 0
  };
}

module.exports = {
  supabase,
  buscarHistorico,
  salvarMensagem,
  salvarAgendamento,
  buscarAgendamentos,
  atualizarStatus,
  logMensagem,
  buscarMetricas
};
