// Guarda local do app (IndexedDB): chaves do aparelho, turno, cardápio, último retrato do salão e a
// fila de pedidos esperando sinal. Chave privada e chaves AES ficam como CryptoKey não exportável.

const NOME = "comandou-garcom", VERSAO = 1, LOJA = "kv";
let conexao;

function abrirBanco() {
  conexao ??= new Promise((ok, erro) => {
    const r = indexedDB.open(NOME, VERSAO);
    r.onupgradeneeded = () => r.result.createObjectStore(LOJA);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => erro(r.error);
  });
  return conexao;
}

async function operar(modo, f) {
  const db = await abrirBanco();
  return new Promise((ok, erro) => {
    const tx = db.transaction(LOJA, modo);
    const r = f(tx.objectStore(LOJA));
    tx.oncomplete = () => ok(r?.result);
    tx.onerror = () => erro(tx.error);
  });
}

export const ler = (chave) => operar("readonly", (s) => s.get(chave));
export const gravar = (chave, valor) => operar("readwrite", (s) => s.put(valor, chave));
export const apagar = (chave) => operar("readwrite", (s) => s.delete(chave));
export const limparTudo = () => operar("readwrite", (s) => s.clear());

/** Pede ao navegador para não apagar a guarda quando faltar espaço (fila e chaves importam). */
export async function pedirGuardaPersistente() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* opcional */ }
}
