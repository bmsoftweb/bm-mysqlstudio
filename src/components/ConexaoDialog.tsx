import React, { useState } from 'react';
import { PlugZap } from 'lucide-react';
import { Conexao, DadosConexao, lembrarSenha, esquecerSenha, salvarConexao, testarConexao } from '../lib/api';
import { AMBIENTES } from '../app/contexto';
import { avisar } from '../lib/avisos';
import { Botao, CAMPO, Dialogo, LinhaCampo } from './ui';
import { Toggle } from './Toggle';

interface ConexaoDialogProps {
  /** Conexão em edição; sem id: nova (ou cópia) */
  conexao: Partial<Conexao>;
  /** Nomes das outras conexões, para recusar nome repetido */
  nomesEmUso: string[];
  /**
   * Só pedir a senha de uma conexão salva sem "Salvar senha" (ou com a senha recusada): motivo mostrado no topo.
   * Os outros campos continuam editáveis, como no desktop.
   */
  motivoSenha?: string;
  /** Salvou: a conexão gravada e a senha digitada ('' se não digitou) */
  onSalvar: (conexao: Conexao, senha: string) => void;
  onFechar: () => void;
}

/** Propriedades da conexão (o TfrmConnect do desktop). */
export const ConexaoDialog: React.FC<ConexaoDialogProps> = ({ conexao, nomesEmUso, motivoSenha, onSalvar, onFechar }) => {
  const [nome, setNome] = useState(conexao.nome ?? '');
  const [servidor, setServidor] = useState(conexao.servidor ?? 'localhost');
  const [porta, setPorta] = useState(String(conexao.porta ?? 3306));
  const [usuario, setUsuario] = useState(conexao.usuario ?? 'root');
  const [senha, setSenha] = useState('');
  const [salvarSenha, setSalvarSenha] = useState(conexao.salvar_senha ?? false);
  const [banco, setBanco] = useState(conexao.banco ?? '');
  const [ambiente, setAmbiente] = useState(conexao.ambiente ?? 0);
  const [bancos, setBancos] = useState<string[]>([]);
  const [ocupado, setOcupado] = useState('');
  /** Senha já salva no servidor e não redigitada: fica como está */
  const mantemSenha = Boolean(conexao.id && conexao.tem_senha && senha === '');

  const dados = (): DadosConexao => ({
    id: conexao.id,
    nome: nome.trim() || servidor.trim(), // em branco: usa o nome do servidor, como no dbForge
    servidor: servidor.trim(),
    porta: Number(porta),
    usuario: usuario.trim(),
    senha: mantemSenha ? undefined : senha,
    salvar_senha: salvarSenha,
    banco: banco.trim(),
    ambiente,
  });

  const validar = (): boolean => {
    const d = dados();
    if (!d.servidor) return avisar.alerta('Informe o servidor.'), false;
    if (nomesEmUso.some((n) => n.toLowerCase() === d.nome.toLowerCase())) return avisar.alerta('Já existe uma conexão com esse nome.'), false;
    if (!Number.isInteger(d.porta) || d.porta <= 0 || d.porta > 65535) return avisar.alerta('Porta inválida.'), false;
    if (!d.usuario) return avisar.alerta('Informe o usuário.'), false;
    return true;
  };

  const testar = async () => {
    if (!validar()) return;
    setOcupado('testar');
    try {
      const r = await testarConexao(dados());
      avisar.sucesso(`Conexão OK.\nMySQL ${r.versao}`);
    } catch (e) {
      avisar.erro(e);
    } finally {
      setOcupado('');
    }
  };

  /** Lista os bancos do servidor ao entrar no campo (com os dados digitados até agora). */
  const listarBancos = async () => {
    if (bancos.length || !servidor.trim() || !usuario.trim() || (!conexao.tem_senha && senha === '' && !conexao.id)) return;
    try {
      setBancos((await testarConexao(dados(), true)).bancos ?? []);
    } catch {
      // sem conseguir conectar ainda: o campo aceita digitar o nome
    }
  };

  const ok = async () => {
    if (!validar()) return;
    setOcupado('salvar');
    try {
      const c = await salvarConexao(dados());
      // Sem "Salvar senha", ela fica só na memória até fechar a página
      if (c.tem_senha) esquecerSenha(c.id);
      else if (!mantemSenha) lembrarSenha(c.id, senha);
      onSalvar(c, senha);
    } catch (e) {
      avisar.erro(e);
    } finally {
      setOcupado('');
    }
  };

  return (
    <Dialogo
      titulo={conexao.id ? `Propriedades da conexão - ${conexao.nome}` : 'Nova conexão'}
      subtitulo={motivoSenha || 'Informe o servidor, a porta, o usuário e a senha do MySQL.'}
      largura={480}
      onFechar={onFechar}
      onEnviar={ok}
      rodape={
        <>
          <Botao icone={PlugZap} onClick={testar} ocupado={ocupado === 'testar'} className="mr-auto">
            Testar conexão
          </Botao>
          <Botao onClick={onFechar}>Cancelar</Botao>
          <Botao tom="primario" type="submit" ocupado={ocupado === 'salvar'}>
            OK
          </Botao>
        </>
      }
    >
      <LinhaCampo rotulo="Servidor:">
        <input value={servidor} onChange={(e) => setServidor(e.target.value)} required className={`${CAMPO} flex-1`} />
      </LinhaCampo>
      <LinhaCampo rotulo="Porta:">
        <input value={porta} onChange={(e) => setPorta(e.target.value.replace(/\D/g, '').slice(0, 5))} inputMode="numeric" required className={`${CAMPO} w-20 text-right`} />
      </LinhaCampo>
      <LinhaCampo rotulo="Usuário:">
        <input value={usuario} onChange={(e) => setUsuario(e.target.value)} autoComplete="off" required className={`${CAMPO} flex-1`} />
      </LinhaCampo>
      <LinhaCampo rotulo="Senha:">
        <input
          type="password"
          value={senha}
          onChange={(e) => setSenha(e.target.value)}
          autoComplete="new-password"
          placeholder={conexao.id && conexao.tem_senha ? '(salva: deixe em branco para manter)' : ''}
          className={`${CAMPO} flex-1`}
        />
      </LinhaCampo>
      <LinhaCampo rotulo="Salvar a senha:" dica="Guarda a senha cifrada no servidor do MySQL Studio. Desligado, ela é pedida a cada vez que a página abre.">
        <Toggle checked={salvarSenha} onChange={setSalvarSenha} />
      </LinhaCampo>
      <LinhaCampo rotulo="Banco:">
        <input value={banco} onChange={(e) => setBanco(e.target.value)} onFocus={listarBancos} list="conexao-bancos" className={`${CAMPO} flex-1`} />
        <datalist id="conexao-bancos">
          {bancos.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
      </LinhaCampo>
      <LinhaCampo rotulo="Nome da conexão:">
        <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="em branco: usa o nome do servidor" className={`${CAMPO} flex-1`} />
      </LinhaCampo>
      <LinhaCampo rotulo="Ambiente:">
        <select value={ambiente} onChange={(e) => setAmbiente(Number(e.target.value))} className={`${CAMPO} w-48`}>
          {AMBIENTES.map((a, i) => (
            <option key={a} value={i}>
              {a}
            </option>
          ))}
        </select>
      </LinhaCampo>
    </Dialogo>
  );
};
