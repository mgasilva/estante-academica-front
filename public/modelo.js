/** Funções puras: não acessam DOM, rede, armazenamento ou banco de dados. */
export const ESTADOS = Object.freeze({quero_ler: "Quero ler", lendo: "Lendo", concluido: "Concluído"});

export function normalizarBusca(texto) {
  return String(texto ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim();
}

export function resumir(livros) {
  const resumo = {total: livros.length, quero_ler: 0, lendo: 0, concluido: 0, percentual: 0};
  for (const livro of livros) {
    if (Object.hasOwn(ESTADOS, livro.status)) resumo[livro.status]++;
  }
  resumo.percentual = resumo.total ? Math.round(100 * resumo.concluido / resumo.total) : 0;
  return resumo;
}

export function filtrarLivros(livros, busca = "", status = "", ordem = "recentes") {
  const termo = normalizarBusca(busca);
  const filtrados = livros.filter(livro => (!status || livro.status === status) &&
    (!termo || normalizarBusca(`${livro.titulo} ${livro.autores}`).includes(termo)));
  return filtrados.sort((a, b) => {
    if (ordem === "titulo") return a.titulo.localeCompare(b.titulo, "pt-BR");
    if (ordem === "ano") return (b.ano_publicacao ?? 0) - (a.ano_publicacao ?? 0) || b.id - a.id;
    return b.id - a.id;
  });
}

/** Produz o corpo completo aceito pelo POST e PUT, sem enviar o id local. */
export function corpoLivro(dados) {
  const titulo = String(dados.titulo ?? "").trim();
  const autores = String(dados.autores ?? "").trim();
  const observacoes = String(dados.observacoes ?? "").trim();
  const anoBruto = dados.ano_publicacao;
  const ano = anoBruto === "" || anoBruto === null || anoBruto === undefined ? null : Number(anoBruto);
  const status = dados.status ?? "quero_ler";
  const externo = typeof dados.open_library_id === "string" ? dados.open_library_id.trim() || null : null;
  if (!titulo || titulo.length > 300) throw new Error("Informe um título de 1 a 300 caracteres.");
  if (autores.length > 500) throw new Error("Os autores devem ocupar no máximo 500 caracteres.");
  if (observacoes.length > 5000) throw new Error("As observações devem ocupar no máximo 5.000 caracteres.");
  if (ano !== null && (!Number.isInteger(ano) || ano < 1 || ano > 9999 || typeof anoBruto === "boolean")) {
    throw new Error("O ano deve ser um inteiro entre 1 e 9999, ou ficar em branco.");
  }
  if (!Object.hasOwn(ESTADOS, status)) throw new Error("Selecione um estado de leitura válido.");
  if (externo && externo.length > 100) throw new Error("O identificador externo é muito longo.");
  return {titulo, autores, ano_publicacao: ano, status, observacoes, open_library_id: externo};
}

/** O total pode incluir documentos descartados pela API; nunca ultrapassa a página 100. */
export function temProximaPagina(resultado) {
  if (resultado.pagina >= 100) return false;
  if (Number.isInteger(resultado.total)) return resultado.pagina * resultado.limite < resultado.total;
  return resultado.itens.length >= resultado.limite;
}
