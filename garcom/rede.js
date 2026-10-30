// Duas rotas até o PC do restaurante (docs/09-infra-do-celular.md, seção 4.6):
//  - local: http://<IP do PC>:<porta>, direto pelo Wi-Fi (rápida; no Chrome do Android funciona
//    mesmo com a internet do restaurante caída, depois da permissão de rede local);
//  - internet: o próprio endereço do app (túnel).
// O app sonda as duas, usa a que respondeu (preferindo a local) e, se um envio falhar, repete pela
// outra. Cada tentativa é um envelope novo; o id do envio dentro dele impede pedido duplicado.
import { abrir, b64url, deB64url, fechar, numero } from "./cripto.js";

const LIMITE_LOCAL = 900, LIMITE_INTERNET = 8000, LIMITE_CHAMADA_LOCAL = 5000, LIMITE_CHAMADA_INTERNET = 15000;
const ouvintes = new Set();

export const estado = {
  rota: null,          // { nome: "local" | "internet", base, ms }
  rotas: [],           // última sondagem
  desvio: 0,           // relógio do PC − relógio do celular (ms)
  sondando: false,
};

let config = null;     // { aparelho, chavePc (Uint8Array), ips, porta, chamadas (CryptoKey) }

export function aoMudar(f) { ouvintes.add(f); return () => ouvintes.delete(f); }
const avisar = () => ouvintes.forEach((f) => { try { f(estado); } catch { /* tela */ } });

export function configurar(c) { config = c; }

const origemEhLocal = () => /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);

// Cópia estática do app (GitHub Pages, sem túnel): ali não há servidor, só os arquivos; os
// pedidos vão sempre direto ao PC pela rede local.
export const origemEstatica = () => location.hostname.endsWith(".github.io");

function candidatas() {
  const lista = [];
  if (config?.ips?.length && !origemEhLocal())
    for (const ip of config.ips) lista.push({ nome: "local", base: `http://${ip}:${config.porta}` });
  if (!origemEstatica())
    lista.push({ nome: origemEhLocal() ? "local" : "internet", base: location.origin });
  return lista;
}

/** fetch com limite de tempo; nas rotas locais, avisa o Chrome que o destino é a rede local. */
async function buscar(url, opcoes, limite, local) {
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), limite);
  try {
    const extra = local && !url.startsWith(location.origin) ? { targetAddressSpace: "local" } : {};
    return await fetch(url, { ...opcoes, ...extra, signal: controle.signal, cache: "no-store" });
  } finally {
    clearTimeout(relogio);
  }
}

/** Testa uma rota: responde e é este PC (a chave pública confere). */
async function sondar(rota) {
  const inicio = performance.now();
  try {
    const local = rota.nome === "local";
    const r = await buscar(`${rota.base}/api/garcom/saude`, {}, local ? LIMITE_LOCAL : LIMITE_INTERNET, local);
    if (!r.ok) return null;
    const s = await r.json();
    if (config?.chavePc && s.chave !== b64url(config.chavePc)) return null; // outro aparelho com o mesmo IP
    estado.desvio = new Date(s.agora).getTime() - Date.now();
    return { ...rota, ms: Math.round(performance.now() - inicio) };
  } catch {
    return null;
  }
}

let sondagem = null;
export function sondarRotas() {
  sondagem ??= (async () => {
    estado.sondando = true; avisar();
    const resultados = (await Promise.all(candidatas().map(sondar))).filter(Boolean);
    estado.rotas = resultados;
    estado.rota = resultados.find((r) => r.nome === "local") ?? resultados[0] ?? null;
    estado.sondando = false; avisar();
    sondagem = null;
    return estado.rota;
  })();
  return sondagem;
}

export class ErroDoApp extends Error {
  constructor(mensagem, { sessao = true, desconectado = false, rede = false } = {}) {
    super(mensagem);
    this.sessao = sessao; this.desconectado = desconectado; this.rede = rede;
  }
}

async function tentar(rota, acao, dados, sessao) {
  const n = numero();
  const local = rota.nome === "local";
  const corpo = { aparelho: config.aparelho, ...(await fechar(config.chamadas, config.aparelho, { t: Date.now() + estado.desvio, n, acao, sessao, dados })) };
  const r = await buscar(`${rota.base}/api/garcom/rpc`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo),
  }, local ? LIMITE_CHAMADA_LOCAL : LIMITE_CHAMADA_INTERNET, local);
  if (r.status === 401) {
    const e = await r.json().catch(() => ({}));
    if (e.erro === "aparelho-desconectado") throw new ErroDoApp(e.mensagem, { desconectado: true });
    throw new ErroDoApp("O PC não reconheceu este celular.", { desconectado: true });
  }
  if (r.status === 400) {
    const e = await r.json().catch(() => ({}));
    if (e.erro === "hora" && e.agora) { estado.desvio = e.agora - Date.now(); return "hora"; }
  }
  if (!r.ok) throw new ErroDoApp("O PC respondeu com erro. Tente de novo.", { rede: true });
  const resposta = await abrir(config.chamadas, config.aparelho, await r.json());
  if (resposta.n !== n) throw new ErroDoApp("Resposta trocada. Tente de novo.", { rede: true });
  if (resposta.agora) estado.desvio = resposta.agora - Date.now();
  if (!resposta.ok) throw new ErroDoApp(resposta.erro, { sessao: resposta.sessao !== false });
  return { dados: resposta.dados };
}

/**
 * Chamada cifrada ao PC. Usa a rota atual; se ela falhar pela rede, sonda e tenta a próxima.
 * Erros de regra (mesa não encontrada, PIN incorreto) voltam como ErroDoApp, sem repetir.
 */
export async function chamar(acao, dados = {}, sessao = null) {
  if (!config) throw new ErroDoApp("Celular ainda não pareado.", { desconectado: true });
  if (!estado.rota) await sondarRotas();
  const tentadas = new Set();
  for (let volta = 0; volta < 3; volta++) {
    const rota = estado.rota && !tentadas.has(estado.rota.base) ? estado.rota
      : estado.rotas.find((r) => !tentadas.has(r.base)) ?? null;
    if (!rota) break;
    try {
      let r = await tentar(rota, acao, dados, sessao);
      if (r === "hora") r = await tentar(rota, acao, dados, sessao); // relógio ajustado: uma nova tentativa
      if (r === "hora") throw new ErroDoApp("O relógio do celular está muito diferente do PC.");
      if (estado.rota?.base !== rota.base) { estado.rota = rota; avisar(); }
      return r.dados;
    } catch (e) {
      if (e instanceof ErroDoApp && !e.rede) throw e;
      tentadas.add(rota.base);
      if (estado.rota?.base === rota.base) { estado.rota = null; avisar(); }
      await sondarRotas();
    }
  }
  throw new ErroDoApp("Sem conexão com o restaurante.", { rede: true });
}

/**
 * Onde parear: na cópia estática não há servidor, então vai direto aos IPs do PC (os do QR); com
 * túnel ou aberto pelo próprio PC, pela origem.
 */
export function enderecosParaParear(ips, porta) {
  if (!origemEstatica()) return [location.origin];
  if (!ips.length) throw new ErroDoApp("Aqui o código sozinho não basta: leia o QR do caixa com a câmera do celular.");
  return ips.map((ip) => `http://${ip}:${porta}`);
}

const semPc = () => /iPhone|iPad/.test(navigator.userAgent) && origemEstatica()
  ? "O iPhone ainda não conecta direto ao computador pela rede local (o Safari bloqueia). Por enquanto, use um celular Android."
  : "Não achei o computador do restaurante. Confira se o celular está no mesmo Wi-Fi do PC e, se o navegador perguntar, permita o acesso à rede local.";

/** Pareamento: cifra o código com a chave combinada com o PC (a do QR) e recebe o id do aparelho. */
export async function parear(bases, publicaDoCelular, chaveDeParear, codigo, nome) {
  for (const base of bases) {
    try {
      return await parearEm(base, publicaDoCelular, chaveDeParear, codigo, nome);
    } catch (e) {
      if (e instanceof ErroDoApp) throw e; // o PC respondeu: não adianta tentar outro endereço
    }
  }
  throw new ErroDoApp(semPc(), { rede: true });
}

async function parearEm(base, publicaDoCelular, chaveDeParear, codigo, nome) {
  const n = numero();
  const local = base !== location.origin;
  const corpo = { chave: b64url(publicaDoCelular), ...(await fechar(chaveDeParear, "parear", { t: Date.now() + estado.desvio, n, codigo, nome })) };
  // Tempo folgado: na primeira vez o Chrome pergunta se pode acessar a rede local.
  const r = await buscar(`${base}/api/garcom/parear`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) },
    local ? 30000 : LIMITE_CHAMADA_INTERNET, local);
  const json = await r.json().catch(() => ({}));
  if (r.status === 400 && json.erro === "hora" && json.agora) {
    estado.desvio = json.agora - Date.now();
    return parearEm(base, publicaDoCelular, chaveDeParear, codigo, nome);
  }
  if (!r.ok) throw new ErroDoApp(json.mensagem ?? "Não foi possível parear. Leia o QR de novo.");
  const resposta = await abrir(chaveDeParear, "parear", json);
  if (resposta.n !== n) throw new ErroDoApp("Resposta trocada. Tente de novo.");
  if (!resposta.ok) throw new ErroDoApp(resposta.erro);
  return resposta;
}

/** Chave do PC pela origem (para quem digita o código em vez de ler o QR). */
export async function chaveDaOrigem() {
  if (origemEstatica()) throw new ErroDoApp("Aqui o código sozinho não basta: leia o QR do caixa com a câmera do celular.");
  const r = await buscar(`${location.origin}/api/garcom/saude`, {}, LIMITE_INTERNET, false);
  const s = await r.json().catch(() => null);
  if (!r.ok || !s?.chave) throw new ErroDoApp("O computador do restaurante não respondeu. Leia o QR do caixa com a câmera.");
  return deB64url(s.chave);
}
