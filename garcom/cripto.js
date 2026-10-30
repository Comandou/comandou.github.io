// Criptografia do app do garçom. Espelho de Comandou.Server/Garcom/ChaveDoPc.cs:
// ECDH P-256 entre a chave do celular e a do PC → HKDF-SHA-256 (sal "comandou-garcom-v1",
// info = uso) → AES-256-GCM com IV de 12 bytes e etiqueta de 16 no fim do texto cifrado.

const texto = new TextEncoder();
const SAL = texto.encode("comandou-garcom-v1");

export function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function deB64url(s) {
  const b = atob(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** Par de chaves do celular. A privada não sai do navegador (não exportável). */
export async function novoParDeChaves() {
  const par = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publica = new Uint8Array(await crypto.subtle.exportKey("raw", par.publicKey));
  return { privada: par.privateKey, publica };
}

/** Chave AES combinada com o PC para um uso ("parear" ou "chamadas"). */
export async function derivar(privada, publicaDoPc, uso) {
  const pc = await crypto.subtle.importKey("raw", publicaDoPc, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const segredo = await crypto.subtle.deriveBits({ name: "ECDH", public: pc }, privada, 256);
  const base = await crypto.subtle.importKey("raw", segredo, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: SAL, info: texto.encode(uso) },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function fechar(chave, adicional, objeto) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const dados = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: texto.encode(adicional), tagLength: 128 },
    chave, texto.encode(JSON.stringify(objeto)));
  return { iv: b64url(iv), dados: b64url(dados) };
}

export async function abrir(chave, adicional, envelope) {
  const claro = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: deB64url(envelope.iv), additionalData: texto.encode(adicional), tagLength: 128 },
    chave, deB64url(envelope.dados));
  return JSON.parse(new TextDecoder().decode(claro));
}

/** Número único de cada envelope (o PC recusa repetido). */
export const numero = () => b64url(crypto.getRandomValues(new Uint8Array(16)));

/** Resumo curto da chave do PC, igual ao ChaveDoPc.Impressao. */
export async function impressao(publicaDoPc) {
  return b64url(await crypto.subtle.digest("SHA-256", publicaDoPc)).slice(0, 16);
}

/** UUID v4 para o id do envio (gerado antes da primeira tentativa). */
export const uuid = () => crypto.randomUUID();
