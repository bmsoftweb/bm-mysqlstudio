/**
 * Ao entrar num campo de digitação, todo o conteúdo fica selecionado: o que o usuário digitar substitui o valor.
 * Instalado uma vez para o documento inteiro (main.tsx). Ficam de fora as áreas de texto (textarea), os controles
 * que não são de digitação e os editores de célula das grades (.sem-barra), que cuidam da própria seleção.
 * (Copiado do crmWeb.)
 */
const TIPOS_DIGITACAO = new Set(['text', 'search', 'email', 'tel', 'url', 'password', 'number', '']);

function ehCampoDeDigitacao(el: EventTarget | null): el is HTMLInputElement {
  return el instanceof HTMLInputElement && TIPOS_DIGITACAO.has(el.type) && !el.readOnly && !el.disabled && !el.classList.contains('sem-barra');
}

export function instalarSelecaoAoFocar() {
  // Campo que acabou de ganhar foco por clique: o mouseup desse clique desfaria a seleção
  let focadoPorClique: HTMLInputElement | null = null;

  document.addEventListener('mousedown', (e) => {
    const alvo = e.target;
    focadoPorClique = ehCampoDeDigitacao(alvo) && document.activeElement !== alvo ? alvo : null;
  });

  document.addEventListener('focusin', (e) => {
    const alvo = e.target;
    if (!ehCampoDeDigitacao(alvo)) return;
    try {
      alvo.select();
    } catch {
      // alguns tipos não suportam seleção
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (focadoPorClique && e.target === focadoPorClique) e.preventDefault(); // mantém a seleção feita no focusin
    focadoPorClique = null;
  });
}
