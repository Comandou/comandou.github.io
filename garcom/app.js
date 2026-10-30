// App do garçom: parear o celular, entrar com o PIN, ver as mesas, lançar e pedir a conta.
// Pedido vai primeiro para a fila do aparelho (IndexedDB) e sai dela quando o PC confirma, então
// nada se perde sem sinal; o id do envio, criado antes da primeira tentativa, evita duplicar.
import * as banco from "./banco.js";
import { b64url, deB64url, derivar, novoParDeChaves, uuid } from "./cripto.js";
import { aoMudar, chamar, chaveDaOrigem, configurar, enderecosParaParear, ErroDoApp, estado as rede, parear, sondarRotas } from "./rede.js";

const raiz = document.getElementById("app");
const caixaDeAviso = document.getElementById("aviso");

const s = {
  tela: "abertura",
  aparelho: null,      // { id, chavePc, ips, porta, restaurante, privada, chamadas }
  sessao: null,        // { token, nome, funcionarioId, expiraEm }
  equipe: [], escolhido: null, pin: "",
  salao: [], filtro: "minhas",
  mesa: null, cardapio: null, categoria: null, busca: "",
  carrinho: [], pessoas: 2,
  fila: [], folha: null, ocupado: false, mensagem: null,
};

// ---------- utilidades ----------
function h(tag, atributos = {}, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(atributos ?? {})) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const f of filhos.flat()) if (f != null && f !== false) el.append(f.nodeType ? f : document.createTextNode(String(f)));
  return el;
}
/** Troca o conteúdo ignorando os "false" e "null" das condições (senão viram texto na tela). */
const repor = (el, ...filhos) => el.replaceChildren(...filhos.flat().filter((f) => f != null && f !== false));
const brl = (v) => Number(v ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dois = (n) => String(n).padStart(2, "0");
function tempo(desde) {
  if (!desde) return "";
  const min = Math.max(0, Math.round((Date.now() + rede.desvio - new Date(desde).getTime()) / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h ${dois(min % 60)}`;
}
let relogioDoAviso;
function aviso(texto, tipo = "") {
  clearTimeout(relogioDoAviso);
  repor(caixaDeAviso, h("div", { class: `msg ${tipo}` }, texto));
  relogioDoAviso = setTimeout(() => caixaDeAviso.replaceChildren(), tipo === "erro" ? 6000 : 3200);
}
function nomeDoAparelho() {
  const ua = navigator.userAgent;
  const sistema = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : "Celular";
  const navegador = /EdgA?\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  return `${sistema} · ${navegador}`;
}
const ir = (tela) => { s.tela = tela; s.folha = null; desenhar(); window.scrollTo(0, 0); };

// ---------- estado guardado ----------
async function carregar() {
  s.aparelho = (await banco.ler("aparelho")) ?? null;
  const sessao = await banco.ler("sessao");
  s.sessao = sessao && new Date(sessao.expiraEm).getTime() > Date.now() ? sessao : null;
  s.fila = (await banco.ler("fila")) ?? [];
  s.cardapio = (await banco.ler("cardapio")) ?? null;
  s.salao = (await banco.ler("salao")) ?? [];
}
const salvarFila = () => banco.gravar("fila", s.fila);

function usarAparelho() {
  const a = s.aparelho;
  configurar({ aparelho: a.id, chavePc: deB64url(a.chavePc), ips: a.ips, porta: a.porta, chamadas: a.chamadas });
}

async function esquecerAparelho(motivo) {
  await banco.limparTudo();
  Object.assign(s, { aparelho: null, sessao: null, fila: [], cardapio: null, salao: [], mesa: null });
  configurar(null);
  s.mensagem = motivo;
  ir("parear");
}

/** Erros que valem para qualquer tela: celular desconectado, turno vencido. */
async function tratar(e) {
  if (e instanceof ErroDoApp && e.desconectado) return esquecerAparelho(e.message);
  if (e instanceof ErroDoApp && !e.sessao) {
    s.sessao = null;
    await banco.apagar("sessao");
    aviso(e.message);
    return entrar();
  }
  aviso(e?.message ?? "Algo deu errado. Tente de novo.", "erro");
}

const comSessao = (acao, dados) => chamar(acao, dados, s.sessao?.token);

// ---------- pareamento ----------
async function parearCom(codigo, chavePc, ips, porta) {
  s.ocupado = true; desenhar();
  try {
    const par = await novoParDeChaves();
    const publicaDoPc = typeof chavePc === "string" ? deB64url(chavePc) : chavePc;
    const resposta = await parear(enderecosParaParear(ips, porta), par.publica, await derivar(par.privada, publicaDoPc, "parear"), codigo, nomeDoAparelho());
    s.aparelho = {
      id: resposta.aparelho, chavePc: b64url(publicaDoPc), ips: resposta.ips ?? ips, porta: resposta.porta ?? porta, restaurante: resposta.restaurante,
      privada: par.privada, chamadas: await derivar(par.privada, publicaDoPc, "chamadas"),
    };
    await banco.gravar("aparelho", s.aparelho);
    await banco.apagar("sessao");
    s.sessao = null;
    usarAparelho();
    aviso("Celular pareado com o restaurante.", "ok");
    await prepararRede();
    await entrar();
  } catch (e) {
    s.mensagem = e.message;
    aviso(e.message, "erro");
    ir("parear");
  } finally {
    s.ocupado = false; desenhar();
  }
}

function telaParear() {
  let campo;
  const enviar = async (ev) => {
    ev.preventDefault();
    const codigo = campo.value.replace(/\D/g, "");
    if (codigo.length !== 6) return aviso("O código tem 6 números.", "erro");
    try { await parearCom(codigo, await chaveDaOrigem(), [], 5081); } catch (e) { aviso(e.message, "erro"); }
  };
  return h("section", { class: "passo" },
    h("span", { class: "marca-grande", "aria-hidden": "true" }),
    h("h1", {}, "Conecte este celular ao restaurante"),
    h("p", {}, "No computador do caixa, abra Funcionários → Celulares → Parear celular e leia o QR com a câmera."),
    s.mensagem && h("div", { class: "faixa", role: "alert" }, s.mensagem),
    h("form", { onsubmit: enviar, style: "display:flex;flex-direction:column;gap:12px" },
      h("label", { for: "codigo", class: "dica" }, "Sem câmera? Digite o código de 6 números que aparece no caixa."),
      campo = h("input", { id: "codigo", class: "campo", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", placeholder: "000000" }),
      h("button", { class: "bt bt-escuro bt-largo", disabled: s.ocupado }, s.ocupado ? "Conectando…" : "Conectar")));
}

// ---------- rede local (permissão do navegador) ----------
// O Chrome dividiu a permissão: "local-network" vale para IP da rede (é a que a rota local usa);
// versões anteriores só conhecem "local-network-access".
async function permissaoDeRedeLocal() {
  for (const name of ["local-network", "local-network-access"]) {
    try { return (await navigator.permissions.query({ name })).state; } catch { /* nome desconhecido nesta versão */ }
  }
  return "desconhecida";
}

async function prepararRede() {
  const precisaExplicar = s.aparelho?.ips?.length && !/^(localhost|127\.|10\.|192\.168\.)/.test(location.hostname)
    && !localStorage.getItem("explicou-rede-local") && (await permissaoDeRedeLocal()) !== "granted";
  if (precisaExplicar) {
    await new Promise((ok) => { s.continuar = ok; ir("rede-local"); });
    localStorage.setItem("explicou-rede-local", "1");
  }
  await sondarRotas();
}

function telaRedeLocal() {
  return h("section", { class: "passo" },
    h("h1", {}, "Mais rápido no Wi-Fi do restaurante"),
    h("p", {}, "O navegador vai perguntar se o Comandou pode acessar dispositivos na rede local. Toque em Permitir: assim o pedido vai direto para o computador do caixa e continua funcionando mesmo se a internet do restaurante cair."),
    h("p", { class: "dica" }, "Fora do Wi-Fi, o app segue pela internet do celular."),
    h("button", { class: "bt bt-escuro bt-largo", onclick: () => s.continuar?.() }, "Entendi"));
}

// ---------- entrar com o PIN ----------
async function entrar() {
  s.escolhido = null; s.pin = "";
  ir("entrar");
  await carregarEquipe();
}

let carregandoEquipe = false;
async function carregarEquipe() {
  if (carregandoEquipe) return;
  carregandoEquipe = true;
  try {
    s.equipe = await chamar("equipe");
    if (s.tela === "entrar") desenhar();
  } catch (e) {
    if (!(e instanceof ErroDoApp && e.rede)) tratar(e);
  } finally { carregandoEquipe = false; }
}

/** O PC manda os IPs dele na rede: se o roteador trocou, a rota local volta sozinha. */
async function atualizarIps(ips, porta) {
  if (!ips || !s.aparelho || (JSON.stringify(ips) === JSON.stringify(s.aparelho.ips) && porta === s.aparelho.porta)) return;
  s.aparelho = { ...s.aparelho, ips, porta };
  await banco.gravar("aparelho", s.aparelho);
  usarAparelho();
  sondarRotas();
}

async function confirmarPin() {
  if (s.pin.length < 4 || s.ocupado) return;
  s.ocupado = true; desenhar();
  try {
    const r = await chamar("entrar", { funcionarioId: s.escolhido.id, pin: s.pin });
    s.sessao = { token: r.sessao, nome: r.nome, funcionarioId: r.funcionarioId, expiraEm: r.expiraEm };
    await banco.gravar("sessao", s.sessao);
    await atualizarIps(r.ips, r.porta);
    s.pin = "";
    await abrirSalao();
    processarFila();
  } catch (e) {
    s.pin = "";
    tratar(e);
  } finally { s.ocupado = false; desenhar(); }
}

function telaEntrar() {
  if (!s.escolhido)
    return h("section", { class: "passo" },
      h("h1", {}, "Quem está no turno?"),
      s.aparelho?.restaurante && h("p", {}, s.aparelho.restaurante),
      s.equipe.length ? h("div", { class: "equipe" }, s.equipe.map((f) => h("button", { onclick: () => { s.escolhido = f; s.pin = ""; desenhar(); } }, f.nome)))
        : h("p", { class: "dica" }, rede.rota ? "Carregando a equipe…"
          : "Procurando o computador do restaurante… Confira se o celular está no Wi-Fi do restaurante. Se não achar, peça ao caixa o QR de pareamento (Funcionários → Celulares dos garçons) e leia de novo: o endereço é atualizado sem perder nada."),
      s.fila.length > 0 && h("div", { class: "faixa" }, `${s.fila.length} pedido(s) guardado(s) neste celular. Entre para enviar.`));
  const tecla = (t) => h("button", { onclick: () => { if (s.pin.length < 6) { s.pin += t; desenhar(); } } }, t);
  return h("section", { class: "passo", style: "align-items:center" },
    h("h1", { style: "text-align:center" }, `Olá, ${s.escolhido.nome}`),
    h("p", {}, "Digite o seu PIN"),
    h("div", { class: "pin-pontos", "aria-label": `${s.pin.length} dígitos` }, [0, 1, 2, 3, 4, 5].slice(0, Math.max(4, s.pin.length)).map((i) => h("span", { class: i < s.pin.length ? "cheio" : "" }))),
    h("div", { class: "teclado" },
      ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(tecla),
      h("button", { class: "acao", onclick: () => { s.escolhido = null; desenhar(); } }, "Trocar"),
      tecla("0"),
      h("button", { class: "acao", onclick: () => { s.pin = s.pin.slice(0, -1); desenhar(); }, "aria-label": "Apagar" }, "⌫")),
    h("button", { class: "bt bt-escuro bt-largo", style: "max-width:360px", disabled: s.pin.length < 4 || s.ocupado, onclick: confirmarPin }, s.ocupado ? "Entrando…" : "Entrar"));
}

// ---------- salão ----------
async function abrirSalao() {
  ir("mesas");
  await atualizarSalao();
}

async function atualizarSalao() {
  if (!s.sessao) return;
  try {
    s.salao = await comSessao("salao");
    banco.gravar("salao", s.salao);
    if (s.tela === "mesas") desenhar();
  } catch (e) {
    if (!(e instanceof ErroDoApp && e.rede)) tratar(e);
    else if (s.tela === "mesas") desenhar();
  }
}

function textoDaRota() {
  if (rede.sondando && !rede.rota) return { classe: "sem", texto: "Procurando o restaurante…" };
  if (!rede.rota) return { classe: "sem", texto: "Sem conexão: pedidos ficam guardados" };
  return rede.rota.nome === "local"
    ? { classe: "", texto: `Wi-Fi do restaurante · ${rede.rota.ms} ms` }
    : { classe: "internet", texto: "Pela internet" };
}

function topo(titulo, { voltar, sub } = {}) {
  const r = textoDaRota();
  return h("header", { class: "topo" },
    h("div", { class: "topo-linha" },
      voltar && h("button", { class: "voltar", onclick: voltar, "aria-label": "Voltar para as mesas",
        html: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>' }),
      h("h1", {}, titulo),
      s.fila.length > 0 && h("span", { class: "fila-topo" }, `${s.fila.length} na fila`)),
    sub && h("small", {}, sub),
    h("span", { class: `rota ${r.classe}` }, h("i"), r.texto));
}

function telaMesas() {
  const todas = s.salao;
  const lista = s.filtro === "minhas" ? todas.filter((m) => m.minha) : s.filtro === "livres" ? todas.filter((m) => m.status === "livre") : todas;
  const cabecalho = topo(`Olá, ${s.sessao?.nome ?? ""}`);
  cabecalho.append(h("div", { class: "abas", role: "group", "aria-label": "Filtrar mesas" },
    [["minhas", "Minhas"], ["todas", "Todas"], ["livres", "Livres"]].map(([v, t]) =>
      h("button", { "aria-pressed": String(s.filtro === v), onclick: () => { s.filtro = v; desenhar(); } }, t))));
  cabecalho.querySelector(".topo-linha").append(h("button", { class: "bt", style: "min-height:40px;color:#D7D8DB", onclick: sair }, "Sair"));
  const erros = s.fila.filter((f) => f.erro);
  return h("div", {}, cabecalho,
    erros.map((f) => h("div", { class: "faixa", role: "alert" },
      h("span", { style: "flex:1" }, `Mesa ${dois(f.numero)}: ${f.erro}`),
      h("button", { class: "bt bt-claro", onclick: () => descartar(f.idDoEnvio) }, "Descartar"))),
    lista.length ? h("ul", { class: "mesas" }, lista.map((m) => h("li", {},
      h("button", { class: `mesa ${m.status}${m.minha ? " minha" : ""}`, onclick: () => abrirMesa(m.mesaId) },
        h("b", {}, dois(m.numero)),
        m.status === "livre" ? h("span", {}, `${m.lugares} lugares`) : [
          h("span", {}, `${m.garcom ?? "Caixa"} · ${tempo(m.abertaEm)}`),
          h("span", {}, brl(m.total)),
          m.status === "conta" && h("span", { class: "selo" }, "Conta"),
        ]))))
      : h("p", { class: "vazio" }, s.filtro === "minhas" ? "Nenhuma mesa sua aberta. Toque em Livres para abrir uma." : "Nenhuma mesa aqui."));
}

async function sair() {
  try { await comSessao("sair"); } catch { /* sai mesmo sem conexão */ }
  s.sessao = null;
  await banco.apagar("sessao");
  entrar();
}

// ---------- mesa, cardápio e pedido ----------
async function abrirMesa(mesaId) {
  const resumo = s.salao.find((m) => m.mesaId === mesaId);
  s.mesa = { mesaId, numero: resumo?.numero ?? 0, status: resumo?.status ?? "livre", comanda: null, carregando: true };
  s.carrinho = []; s.busca = ""; s.pessoas = 2;
  ir("mesa");
  garantirCardapio();
  try {
    s.mesa = await comSessao("mesa", { mesaId });
  } catch (e) {
    if (!(e instanceof ErroDoApp && e.rede)) return tratar(e);
    s.mesa.semConexao = true;
  }
  if (s.tela === "mesa") desenhar();
}

async function garantirCardapio() {
  try {
    const r = await comSessao("cardapio", { versao: s.cardapio?.versao });
    if (!r.igual) {
      s.cardapio = { versao: r.versao, categorias: r.categorias, produtos: r.produtos };
      banco.gravar("cardapio", s.cardapio);
    }
  } catch (e) {
    if (!(e instanceof ErroDoApp && e.rede)) tratar(e);
  }
  if (s.tela === "mesa") desenhar(); // categorias e lista (a busca em uso não perde o foco)
}

const chaveDoItem = (i) => `${i.produtoId}|${i.observacao ?? ""}|${(i.adicionais ?? []).join(",")}`;

function adicionar(produto, { quantidade = 1, observacao = "", adicionais = [] } = {}) {
  const novo = { produtoId: produto.id, nome: produto.nome, preco: produto.preco + adicionais.reduce((t, a) => t + (produto.adicionais.find((x) => x.nome === a)?.preco ?? 0), 0), quantidade, observacao: observacao.trim() || null, adicionais };
  const igual = s.carrinho.find((i) => chaveDoItem(i) === chaveDoItem(novo));
  if (igual) igual.quantidade += quantidade; else s.carrinho.push(novo);
  desenharRodape(); desenharProdutos();
}

function tirar(produtoId) {
  const i = s.carrinho.findLastIndex((x) => x.produtoId === produtoId);
  if (i < 0) return;
  if (--s.carrinho[i].quantidade <= 0) s.carrinho.splice(i, 1);
  desenharRodape(); desenharProdutos();
}

function semAcento(t) { return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }

function produtosVisiveis() {
  const todos = s.cardapio?.produtos ?? [];
  if (s.busca.trim()) {
    const termo = semAcento(s.busca.trim());
    return todos.filter((p) => semAcento(p.nome).includes(termo) || p.codigo === s.busca.trim());
  }
  return s.categoria ? todos.filter((p) => p.categoriaId === s.categoria) : todos;
}

let listaDeProdutos, rodape;
function desenharProdutos() {
  if (!listaDeProdutos) return;
  if (!s.cardapio) return repor(listaDeProdutos, h("li", { class: "vazio" }, "Carregando o cardápio…"));
  const itens = produtosVisiveis();
  repor(listaDeProdutos, ...(itens.length ? itens.map((p) => {
    const qtd = s.carrinho.filter((i) => i.produtoId === p.id).reduce((t, i) => t + i.quantidade, 0);
    const obs = s.carrinho.filter((i) => i.produtoId === p.id && (i.observacao || i.adicionais.length)).map((i) => [i.observacao, ...i.adicionais].filter(Boolean).join(", "));
    return h("li", {},
      h("button", { class: "info", style: "text-align:left", onclick: () => abrirFolha(p) },
        h("b", {}, p.nome), h("span", {}, brl(p.preco)), obs.length > 0 && h("span", { class: "obs" }, ` · ${obs.join(" / ")}`)),
      qtd > 0 && h("button", { class: "redondo", onclick: () => tirar(p.id), "aria-label": `Tirar um ${p.nome}` }, "−"),
      qtd > 0 && h("span", { class: "qtd" }, qtd),
      h("button", { class: "redondo mais", onclick: () => adicionar(p), "aria-label": `Adicionar ${p.nome}` }, "+"));
  }) : [h("li", { class: "vazio" }, "Nenhum produto encontrado.")]));
}

function desenharRodape() {
  if (!rodape) return;
  const qtd = s.carrinho.reduce((t, i) => t + i.quantidade, 0);
  const total = s.carrinho.reduce((t, i) => t + i.quantidade * i.preco, 0);
  const comanda = s.mesa?.comanda;
  if (qtd === 0) {
    // Sem itens escolhidos: o rodapé serve para a conta (mesa aberta) ou só orienta (mesa livre).
    repor(rodape, comanda
      ? h("button", { class: "bt bt-claro bt-largo", onclick: pedirConta, disabled: s.ocupado }, s.mesa.status === "conta" ? "Imprimir a conta de novo" : "Pedir a conta")
      : h("span", { class: "resumo", style: "text-align:center" }, "Toque em + para escolher os itens."));
    return;
  }
  repor(rodape,
    h("span", { class: "resumo" }, s.carrinho.map((i) => `${i.quantidade} ${i.nome}${i.observacao ? ` (${i.observacao})` : ""}`).join(" · ")),
    !comanda && h("div", { class: "pessoas" }, "Pessoas na mesa",
      h("button", { class: "redondo", onclick: () => { s.pessoas = Math.max(1, s.pessoas - 1); desenharRodape(); }, "aria-label": "Menos uma pessoa" }, "−"),
      h("span", { class: "qtd" }, s.pessoas),
      h("button", { class: "redondo", onclick: () => { s.pessoas++; desenharRodape(); }, "aria-label": "Mais uma pessoa" }, "+")),
    h("button", { class: "bt bt-escuro bt-largo", onclick: enviar }, `Enviar ${qtd} ${qtd === 1 ? "item" : "itens"} · ${brl(total)}`));
}

function telaMesa() {
  const m = s.mesa;
  const c = m.comanda;
  const naFila = s.fila.filter((f) => f.mesaId === m.mesaId);
  const sub = c ? `${c.pessoas} pessoas · ${c.garcom ?? "Caixa"} · ${tempo(c.abertaEm)} · ${brl(c.total)}` : m.carregando ? "Carregando…" : "Mesa livre: o primeiro pedido abre a mesa";
  let busca;
  const conteudo = h("div", { class: "conteudo" },
    m.semConexao && h("div", { class: "faixa" }, "Sem conexão agora. Pode lançar: o pedido fica guardado e sai sozinho."),
    (c?.itens?.length || naFila.length) ? h("section", { class: "cartao" },
      h("h2", {}, "Nesta mesa"),
      h("ul", { class: "itens" },
        naFila.flatMap((f) => f.itens.map((i) => h("li", {}, h("span", { class: "q" }, `${i.quantidade}×`), h("span", { class: "n" }, i.nome, i.observacao && h("small", {}, i.observacao)), h("span", { class: "fila" }, f.erro ? "não enviado" : "na fila")))),
        (c?.itens ?? []).filter((i) => i.status !== "cancelado").map((i) => h("li", {},
          h("span", { class: "q" }, `${i.quantidade}×`),
          h("span", { class: "n" }, i.nome, (i.observacao || i.adicionais?.length > 0) && h("small", {}, [...(i.adicionais ?? []), i.observacao].filter(Boolean).join(", "))),
          h("span", {}, brl(i.total))))),
      c && h("div", { class: "total" }, h("span", {}, "Total com 10%"), h("span", {}, brl(c.total)))) : null,
    h("section", { class: "cartao", style: "padding:12px;display:flex;flex-direction:column;gap:10px" },
      h("label", { class: "oculto", for: "busca" }, "Buscar produto"),
      busca = h("input", { id: "busca", class: "busca", type: "search", placeholder: "Buscar produto ou código", value: s.busca, autocomplete: "off",
        oninput: () => { s.busca = busca.value; desenharProdutos(); } }),
      h("div", { class: "categorias", role: "group", "aria-label": "Categorias" },
        h("button", { "aria-pressed": String(!s.categoria), onclick: () => { s.categoria = null; desenhar(); } }, "Tudo"),
        (s.cardapio?.categorias ?? []).map((cat) => h("button", { "aria-pressed": String(s.categoria === cat.id), onclick: () => { s.categoria = cat.id; s.busca = ""; desenhar(); } }, cat.nome)))),
    h("section", { class: "cartao" }, listaDeProdutos = h("ul", { class: "produtos" })));
  rodape = h("footer", { class: "rodape" });
  const tela = h("div", {}, topo(`Mesa ${dois(m.numero)}`, { voltar: () => { listaDeProdutos = rodape = null; abrirSalao(); }, sub }), conteudo, rodape);
  desenharProdutos(); desenharRodape();
  return tela;
}

function abrirFolha(produto) {
  s.folha = { produto, quantidade: 1, observacao: "", adicionais: [] };
  desenharFolha();
}

function desenharFolha() {
  document.querySelector(".fundo")?.remove();
  if (!s.folha) return;
  const f = s.folha, p = f.produto;
  let obs;
  const fechar = () => { s.folha = null; desenharFolha(); };
  const fundo = h("div", { class: "fundo", onclick: (e) => { if (e.target === fundo) fechar(); } },
    h("div", { class: "folha", role: "dialog", "aria-modal": "true", "aria-label": p.nome },
      h("h2", {}, p.nome), h("span", {}, brl(p.preco)),
      p.adicionais?.length > 0 && [h("label", {}, "Adicionais"), h("div", { class: "opcoes" }, p.adicionais.map((a) =>
        h("button", { "aria-pressed": String(f.adicionais.includes(a.nome)), onclick: () => { f.adicionais = f.adicionais.includes(a.nome) ? f.adicionais.filter((x) => x !== a.nome) : [...f.adicionais, a.nome]; f.observacao = obs.value; desenharFolha(); } },
          `${a.nome}${a.preco ? ` +${brl(a.preco)}` : ""}`)))],
      h("label", { for: "obs" }, "Observação"),
      obs = h("textarea", { id: "obs", maxlength: "120", placeholder: "Ex.: sem cebola, ponto da carne" }, f.observacao),
      h("div", { class: "opcoes" }, ["sem cebola", "bem passado", "ao ponto", "sem gelo", "pouco sal"].map((t) =>
        h("button", { onclick: () => { obs.value = obs.value ? `${obs.value}, ${t}` : t; } }, t))),
      h("div", { class: "pessoas" }, "Quantidade",
        h("button", { class: "redondo", onclick: () => { f.quantidade = Math.max(1, f.quantidade - 1); f.observacao = obs.value; desenharFolha(); } }, "−"),
        h("span", { class: "qtd" }, f.quantidade),
        h("button", { class: "redondo", onclick: () => { f.quantidade++; f.observacao = obs.value; desenharFolha(); } }, "+")),
      h("div", { class: "linha", style: "display:flex;gap:8px" },
        h("button", { class: "bt bt-claro", style: "flex:1", onclick: fechar }, "Cancelar"),
        h("button", { class: "bt bt-escuro", style: "flex:2", onclick: () => { adicionar(p, { quantidade: f.quantidade, observacao: obs.value, adicionais: f.adicionais }); fechar(); } }, "Adicionar"))));
  document.body.append(fundo);
}

async function enviar() {
  if (!s.carrinho.length) return;
  const envio = {
    idDoEnvio: uuid(), mesaId: s.mesa.mesaId, numero: s.mesa.numero, pessoas: s.pessoas, criadoEm: Date.now(),
    itens: s.carrinho.map(({ produtoId, nome, quantidade, observacao, adicionais }) => ({ produtoId, nome, quantidade, observacao, adicionais })),
  };
  s.fila.push(envio);
  await salvarFila();
  s.carrinho = [];
  desenhar();
  processarFila();
}

let processando = false;
async function processarFila() {
  if (processando || !s.sessao || !s.fila.some((f) => !f.erro)) return;
  processando = true;
  try {
    for (const envio of [...s.fila]) {
      if (envio.erro) continue;
      try {
        const r = await comSessao("enviar", { idDoEnvio: envio.idDoEnvio, mesaId: envio.mesaId, pessoas: envio.pessoas, itens: envio.itens });
        s.fila = s.fila.filter((f) => f.idDoEnvio !== envio.idDoEnvio);
        await salvarFila();
        if (s.mesa?.mesaId === envio.mesaId) s.mesa = r.mesa;
        aviso(`Mesa ${dois(envio.numero)}: pedido enviado para a produção.`, "ok");
      } catch (e) {
        if (e instanceof ErroDoApp && e.rede) break;            // sem conexão: tenta de novo depois
        if (e instanceof ErroDoApp && (!e.sessao || e.desconectado)) { tratar(e); break; }
        envio.erro = e.message;                                  // regra (mesa, produto): o garçom decide
        await salvarFila();
      }
    }
  } finally {
    processando = false;
    desenhar();
  }
}

async function descartar(idDoEnvio) {
  s.fila = s.fila.filter((f) => f.idDoEnvio !== idDoEnvio);
  await salvarFila();
  desenhar();
}

async function pedirConta() {
  if (!s.mesa?.comanda || s.ocupado) return;
  s.ocupado = true; desenharRodape();
  try {
    s.mesa = await comSessao("pedir-conta", { comandaId: s.mesa.comanda.id });
    aviso(`Conta da mesa ${dois(s.mesa.numero)} impressa no caixa.`, "ok");
  } catch (e) { tratar(e); }
  finally { s.ocupado = false; if (s.tela === "mesa") desenhar(); }
}

// ---------- desenho ----------
function desenhar() {
  const telas = { abertura: () => h("div", { class: "abertura" }, h("span", { class: "marca-grande" }), h("p", {}, "Abrindo o Comandou…")),
    parear: telaParear, "rede-local": telaRedeLocal, entrar: telaEntrar, mesas: telaMesas, mesa: telaMesa };
  if (s.tela !== "mesa") listaDeProdutos = rodape = null;
  // Não redesenha a mesa enquanto o garçom digita na busca (perderia o foco).
  if (s.tela === "mesa" && document.activeElement?.id === "busca" && raiz.querySelector("#busca")) { desenharProdutos(); desenharRodape(); return; }
  repor(raiz, telas[s.tela]());
  desenharFolha();
}

// ---------- início ----------
async function iniciar() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  banco.pedirGuardaPersistente();
  await carregar();

  const pedido = /#parear=([^&]+)/.exec(location.hash)?.[1];
  if (pedido) history.replaceState(null, "", location.pathname + location.search);
  if (pedido) {
    const [codigo, chave, ips, porta] = decodeURIComponent(pedido).split(".");
    const lista = (ips ?? "").split(",").filter(Boolean);
    // Mesmo PC (a chave confere): só o endereço na rede mudou (o roteador trocou o IP). Atualiza e
    // segue, sem criar outro aparelho; se ainda assim não achar o PC, faz o pareamento completo.
    if (s.aparelho && s.aparelho.chavePc === chave) {
      await atualizarIps(lista, Number(porta) || 5081);
      usarAparelho();
      await prepararRede();
      if (rede.rota) {
        aviso("Endereço do computador atualizado.", "ok");
        if (s.sessao) { await abrirSalao(); processarFila(); } else await entrar();
        return;
      }
    }
    return parearCom(codigo, chave, lista, Number(porta) || 5081);
  }
  if (!s.aparelho) return ir("parear");

  usarAparelho();
  await prepararRede();
  if (s.sessao) { await abrirSalao(); processarFila(); } else await entrar();
}

aoMudar(() => {
  if (["mesas", "mesa", "entrar"].includes(s.tela)) desenhar();
  if (rede.rota) processarFila();
  if (s.tela === "entrar" && !s.equipe.length && rede.rota && s.aparelho) carregarEquipe();
});
addEventListener("online", () => sondarRotas());
addEventListener("offline", () => sondarRotas());
navigator.connection?.addEventListener?.("change", () => sondarRotas());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && s.aparelho) sondarRotas().then(atualizarSalao); });
setInterval(() => { if (s.aparelho && document.visibilityState === "visible") sondarRotas(); }, 20000);
setInterval(() => { if (document.visibilityState === "visible" && s.tela === "mesas") atualizarSalao(); }, 6000);
setInterval(processarFila, 15000);

iniciar().catch((e) => { console.error(e); aviso("Não foi possível abrir o app. Recarregue a página.", "erro"); });
