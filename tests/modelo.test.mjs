import test from "node:test";
import assert from "node:assert/strict";
import {normalizarBusca, resumir, filtrarLivros, corpoLivro, temProximaPagina} from "../public/modelo.js";
const dados = [
  {id: 1, titulo: "Eletrônica", autores: "João", ano_publicacao: 2024, status: "quero_ler"},
  {id: 2, titulo: "Álgebra", autores: "Ana", ano_publicacao: null, status: "lendo"},
  {id: 3, titulo: "Programação", autores: "José", ano_publicacao: 2020, status: "concluido"},
];
test("normaliza acentos e espaços", () => assert.equal(normalizarBusca("  ELETRÔNICA  "), "eletronica"));
test("resume coleção vazia sem divisão por zero", () => assert.deepEqual(resumir([]), {total:0,quero_ler:0,lendo:0,concluido:0,percentual:0}));
test("conta cada estado e calcula proporção concluída", () => assert.deepEqual(resumir(dados), {total:3,quero_ler:1,lendo:1,concluido:1,percentual:33}));
test("filtra por título sem acentos", () => assert.equal(filtrarLivros(dados,"eletronica")[0].id,1));
test("filtra por autor", () => assert.equal(filtrarLivros(dados,"jose")[0].id,3));
test("combina busca e estado", () => assert.equal(filtrarLivros(dados,"eletronica","lendo").length,0));
test("ordena títulos sem alterar array original", () => {assert.equal(filtrarLivros(dados,"","","titulo")[0].id,2); assert.equal(dados[0].id,1);});
test("anos ausentes ficam no fim", () => assert.deepEqual(filtrarLivros(dados,"","","ano").map(x=>x.id),[1,3,2]));
test("recentes usam identificador local decrescente", () => assert.deepEqual(filtrarLivros(dados).map(x=>x.id),[3,2,1]));
test("cadastro manual completo não envia id local", () => assert.deepEqual(corpoLivro({id:88,titulo:" Teste "}), {titulo:"Teste",autores:"",ano_publicacao:null,status:"quero_ler",observacoes:"",open_library_id:null}));
test("edição preserva identificador externo", () => assert.equal(corpoLivro({titulo:"X",open_library_id:"/works/OL1W"}).open_library_id,"/works/OL1W"));
test("ano em branco vira null", () => assert.equal(corpoLivro({titulo:"X",ano_publicacao:""}).ano_publicacao,null));
test("ano preenchido vira inteiro", () => assert.equal(corpoLivro({titulo:"X",ano_publicacao:"2024"}).ano_publicacao,2024));
test("rejeita título em branco", () => assert.throws(()=>corpoLivro({titulo:"  "})));
test("rejeita estados inválidos", () => assert.throws(()=>corpoLivro({titulo:"X",status:"apagado"})));
test("rejeita ano fracionário ou booleano", () => {assert.throws(()=>corpoLivro({titulo:"X",ano_publicacao:2024.5}));assert.throws(()=>corpoLivro({titulo:"X",ano_publicacao:true}));});
test("próxima página usa total mesmo se documentos foram descartados", () => assert.equal(temProximaPagina({pagina:1,limite:6,total:20,itens:[]}),true));
test("não ultrapassa página 100", () => assert.equal(temProximaPagina({pagina:100,limite:6,total:10000,itens:[]}),false));
test("última página não oferece próxima", () => assert.equal(temProximaPagina({pagina:2,limite:6,total:8,itens:[{},{}]}),false));
test("sem total usa tamanho da resposta", () => assert.equal(temProximaPagina({pagina:1,limite:6,total:null,itens:[{}]}),false));
