/** Interface da Estante Acadêmica. Todas as chamadas usam a mesma origem (/api). */
import {ESTADOS, resumir, filtrarLivros, corpoLivro, temProximaPagina} from "./modelo.js";

const $ = id => document.getElementById(id);
const estado = {livros: [], carregou: false, catalogo: null, busca: "", buscando: false,
  edicao: null, exclusao: null, mutacao: false, toastTimer: null, atividades: []};
const formatoNumero = new Intl.NumberFormat("pt-BR");

function elemento(tag, classe = "", texto = undefined) {
  const no = document.createElement(tag);
  if (classe) no.className = classe;
  // Dados externos são texto, nunca HTML executável.
  if (texto !== undefined) no.textContent = String(texto);
  return no;
}
function aviso(id, mensagem = "") { $(id).textContent = mensagem; $(id).hidden = !mensagem; }
function notificar(mensagem) {
  clearTimeout(estado.toastTimer); aviso("notificacao", mensagem);
  estado.toastTimer = setTimeout(() => { $("notificacao").hidden = true; }, 6500);
}
function conexao(ok) {
  $("conexao").className = `connection ${ok ? "online" : "offline"}`;
  $("conexao-texto").textContent = ok ? "API conectada" : "API indisponível";
}
function registrar(metodo, caminho, codigo, inicio) {
  estado.atividades.unshift({metodo, caminho: caminho.split("?")[0], codigo,
    ms: Math.round(performance.now() - inicio), hora: new Date().toLocaleTimeString("pt-BR")});
  estado.atividades = estado.atividades.slice(0, 12);
  const nos = estado.atividades.map(item => {
    const li = elemento("li");
    li.append(elemento("span", "", `${item.hora} · `), elemento("span", "http-method", item.metodo),
      document.createTextNode(` ${item.caminho} → ${item.codigo} · ${item.ms} ms`));
    return li;
  });
  $("atividade").replaceChildren(...nos);
}

class ErroHTTP extends Error {
  constructor(mensagem, codigo) { super(mensagem); this.codigo = codigo; }
}
async function requisicao(caminho, {metodo = "GET", dados} = {}) {
  const controle = new AbortController();
  const timeout = setTimeout(() => controle.abort(), 22000);
  const inicio = performance.now();
  let codigo = "sem resposta";
  try {
    const resposta = await fetch(`/api${caminho}`, {
      method: metodo, signal: controle.signal, credentials: "same-origin", cache: "no-store",
      headers: {Accept: "application/json", ...(dados !== undefined ? {"Content-Type": "application/json"} : {})},
      ...(dados !== undefined ? {body: JSON.stringify(dados)} : {}),
    });
    codigo = resposta.status;
    const texto = resposta.status === 204 ? "" : await resposta.text();
    let conteudo = null;
    try { conteudo = texto ? JSON.parse(texto) : null; } catch { /* Nginx/GitHub podem retornar HTML num erro. */ }
    if (!resposta.ok) {
      const explicacao = typeof conteudo?.detail === "string" ? conteudo.detail :
        resposta.status === 422 ? "Revise os campos enviados: algum valor não foi aceito pela API." :
        resposta.status === 401 || resposta.status === 403 ? "Acesso não autorizado. Reabra a porta privada pelo painel Ports." :
        `Não foi possível concluir a requisição (HTTP ${resposta.status}). Confira a API e tente novamente.`;
      throw new ErroHTTP(explicacao, resposta.status);
    }
    if (resposta.status !== 204 && conteudo === null) {
      throw new Error("A resposta não contém o JSON esperado. Reabra a porta pelo painel Ports do Codespace.");
    }
    return conteudo;
  } catch (erro) {
    if (erro instanceof ErroHTTP) throw erro;
    if (erro.name === "AbortError" || erro instanceof TypeError) {
      const acao = metodo === "GET" ? "Tente novamente em alguns instantes." :
        "A operação pode ter sido concluída. Atualize a estante antes de repetir, para evitar duplicação.";
      throw new Error(`Não foi possível confirmar a resposta do servidor. ${acao}`);
    }
    throw erro;
  } finally { clearTimeout(timeout); registrar(metodo, caminho, codigo, inicio); }
}

function mudarAba(aba) {
  for (const nome of ["estante", "catalogo"]) {
    const ativo = nome === aba;
    $(`tab-${nome}`).classList.toggle("active", ativo);
    $(`tab-${nome}`).setAttribute("aria-pressed", String(ativo));
    $(`painel-${nome}`).hidden = !ativo;
  }
  if (aba === "catalogo") $("busca-catalogo").focus();
}
function atualizarResumo() {
  const resumo = resumir(estado.livros);
  $("total-livros").textContent = formatoNumero.format(resumo.total);
  $("contagem-aba").textContent = formatoNumero.format(resumo.total);
  for (const key of Object.keys(ESTADOS)) {
    $(`total-${key}`).textContent = formatoNumero.format(resumo[key]);
    $(`barra-${key}`).style.width = `${resumo.total ? 100 * resumo[key] / resumo.total : 0}%`;
  }
  $("conclusao-texto").textContent = resumo.total ? `${resumo.percentual}% da coleção concluída` : "Seu percurso começa aqui";
  $("resumo-percurso").textContent = resumo.total ? `${resumo.quero_ler} para ler · ${resumo.lendo} em leitura · ${resumo.concluido} concluídos` : "Adicione o primeiro livro para começar";
  $("distribuicao").setAttribute("aria-label", $("resumo-percurso").textContent);
}
function botao(texto, classe, acao) {
  const no = elemento("button", `button ${classe}`, texto); no.type = "button";
  no.addEventListener("click", acao); return no;
}
function criarCartao(livro, externo = false) {
  const artigo = elemento("article", "book-card");
  const topo = elemento("div", "card-top");
  const marca = elemento("span", "book-mark", livro.titulo.slice(0, 1).toLocaleUpperCase("pt-BR")); marca.setAttribute("aria-hidden", "true");
  const selo = externo ? elemento("span", "badge", "Open Library") : elemento("span", `badge ${livro.status}`, ESTADOS[livro.status]);
  topo.append(marca, selo);
  artigo.append(topo, elemento("h3", "", livro.titulo), elemento("p", "book-author", livro.autores || "Autor não informado"));
  const ano = livro.ano_publicacao ?? "não informado";
  artigo.append(elemento("p", "book-meta", `${externo ? "Primeira publicação" : "Ano"}: ${ano}`));
  if (!externo && livro.observacoes) artigo.append(elemento("p", "book-note", livro.observacoes));
  const acoes = elemento("div", `card-actions ${externo ? "catalog-actions" : ""}`);
  if (externo) {
    const adicionado = estado.livros.some(item => item.open_library_id === livro.open_library_id);
    const adicionar = botao(adicionado ? "✓ Na sua estante" : "＋ Adicionar à estante", adicionado ? "secondary" : "primary", () => adicionarCatalogo(livro, adicionar));
    adicionar.disabled = adicionado || estado.mutacao; acoes.append(adicionar);
  } else {
    const editar = botao("Editar", "subtle", () => abrirEdicao(livro));
    editar.setAttribute("aria-label", `Editar ${livro.titulo}`);
    const remover = botao("Remover", "subtle remove", () => abrirExclusao(livro));
    remover.setAttribute("aria-label", `Remover ${livro.titulo}`);
    acoes.append(editar, remover);
  }
  artigo.append(acoes); return artigo;
}
function renderizarEstante() {
  if (!estado.carregou) return;
  const busca = $("filtro-busca").value;
  const status = $("filtro-status").value;
  const lista = filtrarLivros(estado.livros, busca, status, $("ordenacao").value);
  $("lista-estante").replaceChildren(...lista.map(livro => criarCartao(livro)));
  $("contagem-estante").textContent = `${lista.length} de ${estado.livros.length} livro(s) · O painel acima resume toda a coleção.`;
  $("estante-vazia").hidden = lista.length > 0;
  const filtrada = estado.livros.length > 0;
  $("vazio-titulo").textContent = filtrada ? "Nenhum livro com esses filtros" : "Sua estante começa com uma escolha";
  $("vazio-texto").textContent = filtrada ? "Tente outro título, autor ou estado de leitura." : "Busque um livro no catálogo ou faça um cadastro manual.";
  $("vazio-acao").textContent = filtrada ? "Limpar filtros" : "Buscar no catálogo";
}
async function carregarEstante() {
  $("recarregar").disabled = true; $("lista-estante").setAttribute("aria-busy", "true");
  try {
    const livros = await requisicao("/livros");
    if (!Array.isArray(livros)) throw new Error("A API retornou uma lista de livros em formato inesperado.");
    estado.livros = livros; estado.carregou = true;
    conexao(true); aviso("aviso-global"); atualizarResumo(); renderizarEstante(); renderizarCatalogo();
    return true;
  } catch (erro) {
    conexao(false); aviso("aviso-global", erro.message);
    if (!estado.carregou) $("contagem-estante").textContent = "Não foi possível carregar. Clique em Atualizar após conferir os contêineres.";
    return false;
  } finally { $("recarregar").disabled = false; $("lista-estante").setAttribute("aria-busy", "false"); }
}

function renderizarCatalogo() {
  const resultado = estado.catalogo;
  if (!resultado) return;
  $("lista-catalogo").replaceChildren(...resultado.itens.map(livro => criarCartao(livro, true)));
  const total = resultado.total === null ? "total não informado" : `${formatoNumero.format(resultado.total)} ocorrência(s) no catálogo`;
  $("resultado-catalogo").textContent = `${resultado.itens.length} resultado(s) exibido(s) para “${resultado.busca}” · ${total}.`;
  if (!resultado.itens.length) $("resultado-catalogo").textContent += " Não há itens utilizáveis nesta página. Tente outro termo ou outra página.";
  $("pagina-atual").textContent = `Página ${resultado.pagina}`;
  $("paginacao").hidden = !resultado.itens.length && resultado.pagina === 1 && !temProximaPagina(resultado);
  $("pagina-anterior").disabled = estado.buscando || resultado.pagina <= 1;
  $("pagina-proxima").disabled = estado.buscando || !temProximaPagina(resultado);
}
async function buscarCatalogo(pagina = 1) {
  if (estado.buscando) return;
  const termo = pagina === 1 ? $("busca-catalogo").value.trim() : estado.busca;
  if (termo.length < 2) { aviso("aviso-catalogo", "Informe pelo menos dois caracteres."); return; }
  estado.buscando = true; $("buscar-catalogo").disabled = true; $("buscar-catalogo").textContent = "Buscando…";
  $("lista-catalogo").setAttribute("aria-busy", "true"); aviso("aviso-catalogo"); renderizarCatalogo();
  try {
    const parametros = new URLSearchParams({busca: termo, limite: "6", pagina: String(pagina)});
    const resultado = await requisicao(`/catalogo?${parametros}`);
    if (!Array.isArray(resultado?.itens)) throw new Error("A consulta retornou um formato inesperado.");
    estado.catalogo = resultado; estado.busca = termo;
  } catch (erro) { aviso("aviso-catalogo", erro.message + (estado.catalogo ? " Os resultados abaixo são da última busca bem-sucedida." : "")); }
  finally {
    estado.buscando = false; $("buscar-catalogo").disabled = false; $("buscar-catalogo").textContent = "Buscar livros";
    $("lista-catalogo").setAttribute("aria-busy", "false"); renderizarCatalogo();
  }
}
async function adicionarCatalogo(livro, controle) {
  if (estado.mutacao) return;
  estado.mutacao = true; controle.disabled = true; controle.textContent = "Adicionando…";
  aviso("aviso-catalogo");
  try {
    await requisicao("/livros", {metodo: "POST", dados: corpoLivro(livro)});
    const atualizou = await carregarEstante();
    notificar(atualizou ? "Livro adicionado à sua estante." : "Livro salvo. Clique em Atualizar para conferir a estante.");
  } catch (erro) {
    aviso("aviso-catalogo", erro.message);
    if (erro.codigo === 409) await carregarEstante();
  } finally { estado.mutacao = false; renderizarCatalogo(); }
}
function abrirEdicao(livro = null) {
  if (estado.mutacao) return;
  estado.edicao = livro; $("form-livro").reset(); aviso("erro-form");
  $("dialog-titulo").textContent = livro ? "Editar livro" : "Cadastrar livro";
  $("livro-titulo").value = livro?.titulo ?? "";
  $("livro-autores").value = livro?.autores ?? "";
  $("livro-ano").value = livro?.ano_publicacao ?? "";
  $("livro-status").value = livro?.status ?? "quero_ler";
  $("livro-observacoes").value = livro?.observacoes ?? "";
  $("origem-livro").textContent = livro?.open_library_id ? `Origem: Open Library · ${livro.open_library_id}. O identificador externo será preservado.` : "Cadastro manual: não é necessário informar um identificador externo.";
  $("dialog-livro").showModal(); $("livro-titulo").focus();
}
async function salvarLivro(evento) {
  evento.preventDefault(); if (estado.mutacao) return;
  aviso("erro-form");
  let payload;
  try { payload = corpoLivro({titulo: $("livro-titulo").value, autores: $("livro-autores").value,
    ano_publicacao: $("livro-ano").value, status: $("livro-status").value,
    observacoes: $("livro-observacoes").value, open_library_id: estado.edicao?.open_library_id ?? null}); }
  catch (erro) { aviso("erro-form", erro.message); return; }
  estado.mutacao = true; $("salvar-livro").disabled = true; $("salvar-livro").textContent = "Salvando…";
  const editar = estado.edicao !== null;
  try {
    await requisicao(editar ? `/livros/${estado.edicao.id}` : "/livros", {metodo: editar ? "PUT" : "POST", dados: payload});
    $("dialog-livro").close();
    const atualizou = await carregarEstante();
    notificar(atualizou ? (editar ? "Leitura atualizada." : "Livro cadastrado.") : "Dados salvos. Clique em Atualizar para conferir a estante.");
  } catch (erro) { aviso("erro-form", erro.message); }
  finally { estado.mutacao = false; $("salvar-livro").disabled = false; $("salvar-livro").textContent = "Salvar livro"; renderizarCatalogo(); }
}
function abrirExclusao(livro) {
  if (estado.mutacao) return;
  estado.exclusao = livro; aviso("erro-excluir");
  $("excluir-texto").textContent = `Você está removendo “${livro.titulo}”. Esta ação não pode ser desfeita pela interface.`;
  $("dialog-excluir").showModal();
}
async function excluirLivro() {
  if (!estado.exclusao || estado.mutacao) return;
  estado.mutacao = true; $("confirmar-exclusao").disabled = true;
  try {
    await requisicao(`/livros/${estado.exclusao.id}`, {metodo: "DELETE"});
    $("dialog-excluir").close();
    const atualizou = await carregarEstante();
    notificar(atualizou ? "Livro removido da estante." : "Registro removido. Clique em Atualizar para conferir.");
  } catch (erro) { aviso("erro-excluir", erro.message); }
  finally { estado.mutacao = false; $("confirmar-exclusao").disabled = false; renderizarCatalogo(); }
}

$("tab-estante").addEventListener("click", () => mudarAba("estante"));
$("tab-catalogo").addEventListener("click", () => mudarAba("catalogo"));
$("atalho-catalogo").addEventListener("click", () => mudarAba("catalogo"));
$("recarregar").addEventListener("click", carregarEstante);
$("cadastro-manual").addEventListener("click", () => abrirEdicao());
$("filtro-busca").addEventListener("input", renderizarEstante);
$("filtro-status").addEventListener("change", renderizarEstante);
$("ordenacao").addEventListener("change", renderizarEstante);
$("vazio-acao").addEventListener("click", () => {
  if (!estado.livros.length) mudarAba("catalogo");
  else { $("filtro-busca").value = ""; $("filtro-status").value = ""; renderizarEstante(); }
});
$("form-catalogo").addEventListener("submit", evento => { evento.preventDefault(); buscarCatalogo(); });
$("pagina-anterior").addEventListener("click", () => buscarCatalogo(estado.catalogo.pagina - 1));
$("pagina-proxima").addEventListener("click", () => buscarCatalogo(estado.catalogo.pagina + 1));
$("form-livro").addEventListener("submit", salvarLivro);
$("confirmar-exclusao").addEventListener("click", excluirLivro);
document.querySelectorAll("[data-fechar]").forEach(botao => botao.addEventListener("click", () => { if (!estado.mutacao) $(botao.dataset.fechar).close(); }));
for (const dialog of document.querySelectorAll("dialog")) dialog.addEventListener("cancel", evento => { if (estado.mutacao) evento.preventDefault(); });
carregarEstante();
