# Rede no GitHub Codespaces — diagnóstico e validação

> Registro de um problema observado no ambiente de desenvolvimento deste MVP.
> Não é uma etapa obrigatória para todo computador com Docker e não deve ser
> aplicado como alteração genérica de firewall. As verificações abaixo não
> modificam regras, contêineres ou dados.

## Contexto

A Estante Acadêmica foi executada no GitHub Codespaces, com os serviços `api`
e `front` em contêineres Docker na rede `estante-academica_default`.
O Nginx entrega a interface na porta publicada 8080 e encaminha `/api/` ao
serviço `api:8000`. A API usa o SQLite e consulta a Open Library.

## Sintomas observados

Inicialmente, a consulta direta a `http://127.0.0.1:8000/` devolvia HTTP 200,
e a página inicial do front-end na porta 8080 também respondia. Entretanto,
`http://127.0.0.1:8080/api/` retornava HTTP 504.

O nome `api` era resolvido para o endereço correto do contêiner, mas a conexão
entre o front-end e a API não se completava. O Nginx registrava:

```text
upstream timed out ... while connecting to upstream
```

Após restabelecer essa comunicação interna, a consulta externa ainda falhava.
Uma execução direta, sem o cache da aplicação, identificou:

```text
gaierror: [Errno -3] Temporary failure in name resolution
```

Logo, foram investigados dois percursos diferentes: comunicação entre os
contêineres e acesso da API ao serviço externo.

## Evidências da configuração

As verificações mostraram regras coexistindo nas variantes `iptables-legacy`
e `iptables-nft`. A política da cadeia `FORWARD` no legacy era `DROP` e as
permissões explícitas visualizadas se referiam a `docker0`. Na variante nft,
a política de `FORWARD` era `ACCEPT`. O encaminhamento IPv4 do kernel estava
habilitado (`net.ipv4.ip_forward = 1`).

Uma política `DROP`, isoladamente, não prova que há defeito: redes Docker podem
usar essa política com exceções apropriadas. Neste ambiente, o diagnóstico
foi sustentado pela comparação antes/depois das exceções restritas e pelos
contadores de pacotes. A existência de `iptables-nft` não demonstra, por si só,
que o daemon utiliza o backend nativo de nftables.

## Ajustes que foram validados neste ambiente

Antes dos ajustes foram guardadas cópias das regras e instruções de reversão
fora dos repositórios. Foram acrescentadas exceções em `DOCKER-USER`, na
variante legacy, preservando a política geral e as regras da variante nft.

| Exceção | Escopo usado no teste |
|---|---|
| Comunicação interna | Entrada e saída na mesma bridge do projeto, com origem e destino na sua sub-rede. |
| Resolução DNS | Saída UDP/TCP na porta 53, a partir do IPv4 atual da API. |
| HTTPS | Saída TCP na porta 443, a partir do IPv4 atual da API. |
| Retorno | Tráfego para essa API pertencente a conexões estabelecidas ou relacionadas. |

A regra interna permitiu novamente a consulta ao FastAPI através do Nginx.
As exceções de saída permitiram uma consulta real à Open Library, sem cache,
que retornou três resultados. Os testes HTTP do front-end e do catálogo
voltaram a passar no ambiente em execução.

Essas permissões de saída foram delimitadas por origem e protocolo, não pelo
nome de domínio da Open Library. Não foram publicadas novas portas, alterados
os dados do SQLite, desativada a verificação TLS ou substituído o serviço externo.

## Limitação que permanece

**As regras foram aplicadas ao ambiente em execução. Não há reaplicação automática
configurada nem garantia de permanência após reiniciar ou reconstruir o Codespace.**

A bridge e o IP de um contêiner podem mudar quando a rede ou o contêiner são
recriados. Portanto, não copie endereços de logs anteriores para uma nova regra
sem verificar a configuração atual. Uma exceção antiga associada a um IP que
foi reutilizado também precisa ser revisada.

Este documento registra a solução testada e seus limites; não é um script de
recuperação. A validação da inicialização em ambiente limpo e após reinicialização
completa ainda deve ser registrada separadamente. Não considere esses cenários
aprovados apenas porque a sessão atual funciona.

O volume `estante-academica-dados` preserva o banco frente à substituição dos
contêineres da aplicação. Ele não preserva regras do firewall e não substitui
um backup externo do banco.

## Verificações em caso de recorrência

No terminal do Codespace, a partir da raiz de `estante-academica-front`, use
as verificações somente de leitura abaixo. Não aplique novos ajustes enquanto
o percurso que falhou não estiver identificado.

```bash
# Estado dos componentes:
docker compose -p estante-academica ps

# API diretamente, sem o encaminhamento do Nginx:
curl --noproxy '*' -sS -i --connect-timeout 3 --max-time 10 \
  http://127.0.0.1:8000/

# Mesma API através do Nginx:
curl --noproxy '*' -sS -i --connect-timeout 3 --max-time 35 \
  http://127.0.0.1:8080/api/

# Rede e endereços atuais:
docker network inspect estante-academica_default

docker inspect --format \
  '{{.Name}} {{range $nome, $rede := .NetworkSettings.Networks}}rede={{$nome}} ip={{$rede.IPAddress}} {{end}}' \
  estante-api estante-front

# Políticas, regras e contadores, se essas ferramentas estiverem disponíveis:
sudo -n iptables-legacy -n -v -L FORWARD --line-numbers
sudo -n iptables-legacy -n -v -L DOCKER-USER --line-numbers
sudo -n iptables-nft -n -v -L FORWARD --line-numbers
sysctl net.ipv4.ip_forward

# Mensagens recentes:
docker compose -p estante-academica logs --no-color --tail=40 api front
```

Depois de confirmar a conectividade, as verificações da aplicação são:

```bash
python scripts/testar_front.py
python ../estante-academica-api/scripts/testar_catalogo.py
```

O teste HTTP do catálogo pode aproveitar uma resposta recente do cache; isso
não equivale, isoladamente, à confirmação de uma nova conexão externa.

Não utilize como tentativa de correção a limpeza de todas as regras, a mudança
global da política de encaminhamento para `ACCEPT`, a remoção do volume, a
exposição pública da aplicação ou a desativação da verificação de certificados.
Mantenha os arquivos de backup e o histórico completo do terminal fora do
repositório público, pois podem conter detalhes do ambiente.

## Referências técnicas

Os registros do incidente acima vêm dos testes deste projeto. As fontes abaixo
explicam o funcionamento geral, mas não comprovam por si sós a causa de um erro
em qualquer outro ambiente:

- [Docker: regras de iptables e cadeia DOCKER-USER](https://docs.docker.com/engine/network/firewall-iptables/).
- [Docker: interação entre filtragem iptables e nftables](https://docs.docker.com/engine/network/firewall-nftables/).
- [Docker Compose: rede, nomes de serviços e alteração de endereços](https://docs.docker.com/compose/how-tos/networking/).
- [Docker: persistência de dados em volumes](https://docs.docker.com/engine/storage/volumes/).

Documentação elaborada a partir das verificações relatadas em 25/09/2026.
