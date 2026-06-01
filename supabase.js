const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function buscarHistorico(telefone, limite) {
  if (!limite) limite = 20;
  const result = await supabase
    .from('conversas')
    .select('role, conteudo')
    .eq('telefone', telefone)
    .order('created_at', { ascending: true })
    .limit(limite);
  const data = result.data || [];
  return data.map(function(m) { return { role: m.role, content: m.conteudo }; });
}

async function salvarMensagem(telefone, role, conteudo) {
  await supabase.from('conversas').insert({ telefone: telefone, role: role, conteudo: conteudo });
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
  var query = supabase.from('agendamentos').select('*').order('created_at', { ascending: false });
  if (filtros.status) query = query.eq('status', filtros.status);
  if (filtros.telefone) query = query.eq('telefone', filtros.telefone);
  if (filtros.data) query = query.eq('data_consulta', filtros.data);
  if (filtros.limite) query = query.limit(filtros.limite);
  const result = await query;
  return result.data || [];
}

async function atualizarStatus(id, status) {
  await supabase.from('agendamentos').update({ status: status }).eq('id', id);
}

async function logMensagem(telefone, mensagem, direcao) {
  await supabase.from('mensagens_whatsapp').insert({ telefone: telefone, mensagem: mensagem, direcao: direcao });
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
  supabase: supabase,
  buscarHistorico: buscarHistorico,
  salvarMensagem: salvarMensagem,
  salvarAgendamento: salvarAgendamento,
  buscarAgendamentos: buscarAgendamentos,
  atualizarStatus: atualizarStatus,
  logMensagem: logMensagem,
  buscarMetricas: buscarMetricas
};
