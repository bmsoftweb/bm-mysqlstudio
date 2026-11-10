import React, { useState } from 'react';
import { AlertCircle, ArrowRight, Database, Eye, EyeOff, Lock, Mail, Moon, Sun } from 'lucide-react';
import { UsuarioSessao, login } from '../lib/api';
import { Tema, emailLembrado } from '../lib/sessao';
import { Toggle } from './Toggle';

interface LoginProps {
  /** Mensagem mostrada ao abrir a tela, ex.: sessão recusada pelo servidor */
  avisoInicial?: string | null;
  tema: Tema;
  onTrocarTema: () => void;
  /** lembrar = "Lembrar neste dispositivo" marcado */
  onEntrar: (usuario: UsuarioSessao, token: string, lembrar: boolean) => void;
}

const CAMPO_LOGIN = 'w-full bg-stone-50 dark:bg-stone-800/80 p-3 pl-11 text-sm font-medium text-stone-800 dark:text-stone-100 placeholder:text-stone-400 placeholder:font-normal';
const ROTULO = 'block text-[10px] font-bold uppercase tracking-widest ml-1 mb-1.5 text-stone-400 dark:text-stone-500';

/** Tela de login, no padrão do crmWeb (sem guardar a senha no navegador). */
export const Login: React.FC<LoginProps> = ({ avisoInicial, tema, onTrocarTema, onEntrar }) => {
  const [email, setEmail] = useState(emailLembrado);
  const [senha, setSenha] = useState('');
  const [lembrar, setLembrar] = useState(() => Boolean(emailLembrado()));
  const [mostrar, setMostrar] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(avisoInicial ?? null);

  const entrar = async (e: React.FormEvent) => {
    e.preventDefault();
    setOcupado(true);
    setErro(null);
    try {
      const r = await login(email.trim().toLowerCase(), senha);
      onEntrar(r.usuario, r.token, lembrar);
    } catch (err) {
      setErro((err as Error).message || 'Não foi possível validar o acesso. Tente novamente.');
    } finally {
      setOcupado(false);
    }
  };

  const marca = (
    <div className="flex items-center gap-2.5">
      <div className="w-9 h-9 bg-blue-600 rounded-xl flex items-center justify-center shrink-0">
        <Database className="w-5 h-5 text-white" />
      </div>
      <span className="text-sm font-black tracking-wider uppercase text-stone-800 dark:text-stone-100">MySQL Studio</span>
    </div>
  );

  return (
    <div className="h-full overflow-auto flex relative bg-white dark:bg-stone-900 text-stone-900 dark:text-white">
      {/* Painel esquerdo: identidade visual (oculto em telas pequenas) */}
      <div className="hidden lg:flex lg:w-1/2 relative overflow-hidden flex-col p-12 bg-white dark:bg-stone-950 isolate">
        <div className="absolute inset-0 -z-10 pointer-events-none overflow-hidden">
          <Database className="absolute top-1/2 right-[8%] -translate-y-1/2 w-[min(380px,60%)] h-auto text-blue-100 dark:text-blue-400/15" strokeWidth={0.7} />
          <div className="absolute top-[15%] left-[10%] w-[280px] h-[280px] rounded-[40%] rotate-12 blur-3xl bg-indigo-100/70 dark:bg-indigo-500/10" />
        </div>
        {marca}
        <div className="flex-1 flex flex-col justify-center">
          <h1 className="text-6xl font-black leading-[0.95] tracking-tight">MySQL</h1>
          <p className="mt-4 text-sm font-medium max-w-xs text-stone-500 dark:text-stone-400">
            Consultas, edição de tabelas, comparação e sincronização de bancos e backup, de qualquer lugar.
          </p>
        </div>
      </div>

      {/* Painel direito: formulário */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-6 relative bg-stone-50 dark:bg-stone-900">
        <button
          type="button"
          onClick={onTrocarTema}
          title={tema === 'dark' ? 'Tema claro' : 'Tema escuro'}
          className="absolute top-6 right-6 p-2 rounded-lg text-stone-500 hover:bg-stone-200 dark:hover:bg-stone-800 cursor-pointer"
        >
          {tema === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>

        <div className="w-full max-w-md">
          <div className="flex lg:hidden mb-8">{marca}</div>
          <h2 className="text-3xl font-black tracking-tight">Login</h2>
          <p className="text-sm font-medium mt-1.5 text-stone-500 dark:text-stone-400">
            Insira suas credenciais para acessar. No primeiro acesso, a senha digitada (8 caracteres ou mais) passa a ser a sua.
          </p>

          <form onSubmit={entrar} className="flex flex-col gap-5 mt-8">
            {erro && (
              <div role="alert" className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 flex items-start gap-2.5 text-xs font-bold text-rose-700 dark:text-rose-300">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
                <span>{erro}</span>
              </div>
            )}

            <div>
              <label htmlFor="login-email" className={ROTULO}>
                E-mail
              </label>
              <div className="relative">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
                <input
                  id="login-email"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setErro(null);
                  }}
                  placeholder="voce@suaempresa.com.br"
                  autoComplete="username"
                  autoFocus={!email}
                  required
                  className={CAMPO_LOGIN}
                />
              </div>
            </div>

            <div>
              <label htmlFor="login-senha" className={ROTULO}>
                Senha
              </label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
                <input
                  id="login-senha"
                  type={mostrar ? 'text' : 'password'}
                  value={senha}
                  onChange={(e) => {
                    setSenha(e.target.value);
                    setErro(null);
                  }}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  autoFocus={Boolean(email)}
                  required
                  className={`${CAMPO_LOGIN} pr-10`}
                />
                <button
                  type="button"
                  onClick={() => setMostrar(!mostrar)}
                  tabIndex={-1}
                  title={mostrar ? 'Esconder a senha' : 'Mostrar a senha'}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 cursor-pointer"
                >
                  {mostrar ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <Toggle
              checked={lembrar}
              onChange={setLembrar}
              size="sm"
              label={<span className="text-xs font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400">Lembrar neste dispositivo</span>}
              title="Mantém a sessão ativa ao fechar o navegador e traz o e-mail preenchido no próximo acesso. A senha não é guardada."
            />

            <button
              type="submit"
              disabled={ocupado}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3.5 rounded-xl transition-all flex items-center justify-center gap-2 mt-2 group disabled:opacity-70 cursor-pointer"
            >
              {ocupado ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <span className="uppercase tracking-wide">Entrar</span>
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                </>
              )}
            </button>
          </form>

          <div className="flex items-center justify-between mt-8 pt-4 border-t border-stone-200 dark:border-stone-800 text-[10px] font-bold uppercase tracking-wider text-stone-400 dark:text-stone-500">
            <span>MySQL Studio by BMsoft Sistemas</span>
            <span className="normal-case">
              v{__APP_VERSION__} • © {new Date().getFullYear()}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
