const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function buscarHistorico(telefone, limite = 20) {
  const { data } = await supabase
    .from('conversas')
    .select('role, conteudo')
    .eq('telefone', telefone)
    .order('created_at', { ascending: true })
    .limit(limite);
  return (data || []).map(m => ({ role: m.role, content: m.conteudo }));
}

async function salvarMensagem(telefone, role, conteudo) {
  await supabase.from('conversas').insert({ telefone, role, conteudo });
}

async function salvarAgendamento(dados) {
  await supabase.from('pacientes').upsert(
    { nome: dados.nome_paciente, telefone: dados.telefone, convenio: dados.convenio },
    { onConflict: 'telefone' }
  );
  const { data, error } = await supabase
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
  if (error) throw error;
  return data;
}

async function buscarAgendamentos(filtros = {}) {
  let query = supabase.from('agendamentos').select('*').order('created_at', { ascending: false });
  if (filtros.status) query = query.eq('status', filtros.status);
  if (filtros.telefone) query = query.eq('telefone', filtros.telefone);
  if (filtros.data) query = query.eq('data_consulta', filtros.data);
  if (filtros.limite) query = query.limit(filtros.limite);
  const { data } = await query;
  return data || [];
}

async function atualizarStatus(id, status) {
  await supabase.from('agendamentos').update({ status }).eq('id', id);
}

async func
