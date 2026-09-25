# Etapa 4 — Interface e execução conjunta

## O que foi acrescentado

Interface em português, sem framework e sem dependências de CDN, com busca no catálogo,
cadastro manual, edição, exclusão confirmada, filtros, ordenação, contadores e distribuição
visual dos estados de leitura. Os valores do painel são calculados a partir dos livros
realmente recebidos da API. Uma falha inicial não é representada como estante vazia.

Os filtros de título/autor/estado e a ordenação desta interface operam em memória,
sobre a coleção carregada por GET `/livros`. A busca local da interface ignora acentos.
A API continua oferecendo seus próprios filtros SQL, com a semântica documentada no
repositório da API. Os contadores sempre resumem a coleção inteira, e não o filtro.

## Pastas

- `public/index.html`: estrutura e formulários.
- `public/styles.css`: layout responsivo e estados visuais.
- `public/app.js`: DOM, ações e requisições HTTP.
- `public/modelo.js`: funções puras de validação, filtro e contagem.
- `nginx.conf`: arquivos estáticos e proxy reverso.
- `Dockerfile`: imagem da interface baseada na imagem oficial do Nginx.
- `compose.yaml`: sobe os dois componentes e conecta o volume já utilizado pela API.
- `scripts/subir_stack.sh`: validação, build e migração segura da API da etapa anterior.
- `scripts/testar_front.py`: cinco verificações HTTP de arquivos e proxy, sem escrita.
- `tests/modelo.test.mjs`: 20 testes unitários com Node, sem dependências externas.
- `docs/arquitetura.svg`: diagrama da arquitetura.

## Teste manual de aceitação

1. Abra a interface na porta 8080. O indicador deve mostrar API conectada.
2. Abra Buscar no catálogo e pesquise `python`; aguarde a resposta real.
3. Adicione um resultado e confira-o em Minha estante.
4. Edite o estado para Lendo e escreva uma observação. Salve e confira o painel.
5. Use os filtros por título, autor e estado; confira também a ordenação.
6. Recarregue a página. O livro e suas observações devem continuar no banco.
7. Clique em Remover; cancele uma vez e confirme que o registro permaneceu.
8. Remova um livro de teste, confirme e confira a atualização da coleção.
9. Expanda Por dentro da aplicação para observar GET, POST, PUT e DELETE.

Não abra `public/index.html` com duplo clique ou Live Server. A interface depende do
proxy `/api` do Nginx. No Codespaces use Ports → 8080 → Open in Browser.
O Swagger continua na porta 8000, caminho `/docs`; não use `/api/docs` no front-end.

## Migração de execução

Use `bash scripts/subir_stack.sh` **na raiz do front-end**. A API existente só é
substituída depois do build das imagens, da conferência do volume e de uma cópia
consistente do SQLite. A cópia vai para `../backups-estante-academica/`, fora dos
repositórios. Nenhum volume é removido e nenhum arquivo do código da API é alterado.
A migração não é uma cópia externa à VM: baixe backups importantes antes de excluir
o Codespace. Reinicializações seguintes do stack não geram novos snapshots automáticos.

Após a migração, use apenas o script do stack/Compose para iniciar as aplicações;
o antigo `scripts/subir_api.sh` foi criado para execução isolada e não conecta o
contêiner à rede do Compose. A execução isolada ainda é possível em outro ambiente,
mas não deve ser misturada com este stack no mesmo Docker.

## Cuidados

Não há autenticação de aplicação nem isolamento de usuários: esta é uma demonstração
educacional de uma coleção compartilhada. Deixe os encaminhamentos de porta privados.
Nenhum token do GitHub vai no código da página, em JSON, em URL ou em arquivo versionado.
A página usa texto (`textContent`) para dados externos, evitando interpretar títulos
como HTML. Requisições de escrita não são repetidas automaticamente após falha de rede,
porque a gravação pode ter ocorrido apesar de a resposta não ter chegado.

Não há importação de imagens de capas, PDFs ou texto integral. O retângulo decorativo
nos cartões é apenas uma identificação gráfica; não é a capa do livro.

## Referências técnicas

- Nginx proxy: https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass
- Fetch: https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch
- Rede Compose: https://docs.docker.com/compose/how-tos/networking/
- Volume externo: https://docs.docker.com/reference/compose-file/volumes/
- Encaminhamento de portas: https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace
