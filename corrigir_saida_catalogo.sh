#!/usr/bin/env bash
# Diagnóstico e correção restrita para o Codespace da Estante Acadêmica.
# Não altera fontes, contêineres, volumes, políticas globais nem regras nft.
# Permissões novas: DNS (UDP/TCP 53) e HTTPS (TCP 443), somente para o IPv4
# atual da API, além das respostas a conexões estabelecidas/relacionadas.
# Não restringe HTTPS a um domínio. Não publica portas de entrada.
set -euo pipefail
umask 077

REDE="estante-academica_default"
CONTAINER="estante-api"
BASE="/workspaces/backups-estante-academica"

falhar() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }
for comando in docker python ip sudo mktemp; do
  command -v "$comando" >/dev/null || falhar "Comando ausente: $comando. Nenhuma regra foi alterada."
done
[[ -d /workspaces ]] || falhar "Execute no terminal Linux do Codespace, não dentro do contêiner."
[[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" == "true" ]] || 
  falhar "O contêiner estante-api precisa estar em execução."
mkdir -p "$BASE"
PASTA="$(mktemp -d "$BASE/saida-catalogo-XXXXXX")"
printf 'Diagnóstico e backup: %s\n' "$PASTA"

# Processo novo: não aproveita o cache da API que atende o navegador.
# Só faz uma consulta; não importa app.main nem inicializa/acessa o banco.
cat > "$PASTA/testar_conexao.py" <<'PY'
import errno
import signal
import socket
import ssl
import sys
from app.catalogo import ClienteOpenLibrary


def tempo_esgotado(signum, frame):
    raise TimeoutError("Prazo global de 35 segundos excedido no diagnóstico.")


signal.signal(signal.SIGALRM, tempo_esgotado)
signal.alarm(35)
try:
    resultado = ClienteOpenLibrary().buscar("python", 3, 1)
    print(f'CONSULTA EXTERNA REAL: OK ({len(resultado["itens"])} resultado(s)).')
    for item in resultado["itens"]:
        print(f'  - {item["titulo"]} [{item["open_library_id"]}]')
except Exception as erro:
    causa = erro.__cause__ if erro.__cause__ is not None else erro
    motivo = getattr(causa, "reason", causa)
    print(f'FALHA: {type(erro).__name__}: {erro}', flush=True)
    print(f'CAUSA TÉCNICA: {type(motivo).__name__}: {motivo}', flush=True)
    # Falhas HTTP, certificado ou programação não justificam esse ajuste.
    if isinstance(motivo, ssl.SSLError):
        sys.exit(20)
    erros_rede = {errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ETIMEDOUT,
                  errno.ECONNREFUSED, errno.ECONNRESET}
    parece_rede = (
        isinstance(motivo, (socket.gaierror, TimeoutError, ConnectionError))
        or (isinstance(motivo, OSError) and motivo.errno in erros_rede)
    )
    sys.exit(10 if parece_rede else 20)
finally:
    signal.alarm(0)
PY

sondar() {
  docker exec -i "$CONTAINER" python -u - < "$PASTA/testar_conexao.py"
}

printf '\n=== 1. Consulta antes de alterar o firewall ===\n'
if sondar; then
  echo 'A conexão externa já funciona neste teste. Nenhuma regra foi alterada.'
  echo 'Teste agora a busca pela interface. Se falhar, envie este resultado.'
  exit 0
else
  RESULTADO=$?
fi
if [[ "$RESULTADO" != 10 ]]; then
  falhar "A falha não foi classificada como DNS/conectividade. Firewall inalterado; envie a causa técnica."
fi

printf '\n=== 2. Conferindo a rede e o firewall legacy ===\n'
[[ "$(docker network inspect -f '{{.Driver}}' "$REDE")" == bridge ]] || 
  falhar "A rede não é bridge. Nenhuma regra foi alterada."
ID="$(docker network inspect -f '{{.Id}}' "$REDE")"
PONTE="$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "$REDE")"
if [[ -z "$PONTE" || "$PONTE" == '<no value>' ]]; then
  PONTE="br-${ID:0:12}"
fi
IP_API="$(docker inspect -f '{{with index .NetworkSettings.Networks "estante-academica_default"}}{{.IPAddress}}{{end}}' "$CONTAINER")"
python -c 'import ipaddress,sys; ipaddress.IPv4Address(sys.argv[1])' "$IP_API"
ip link show "$PONTE" >/dev/null
sudo -n iptables-legacy -w 5 -C FORWARD -j DOCKER-USER
POLITICA="$(sudo -n iptables-legacy -w 5 -S FORWARD)"
[[ "$POLITICA" == *'-P FORWARD DROP'* ]] || 
  falhar "A política legacy não é DROP. Nenhuma regra foi alterada; precisamos revisar o diagnóstico."
sudo -n iptables-legacy -w 5 -S DOCKER-USER >/dev/null
sudo -n iptables-legacy-save > "$PASTA/iptables-legacy-antes.rules"
printf 'Bridge: %s | IPv4 atual da API: %s\n' "$PONTE" "$IP_API"

DESFAZER="$PASTA/desfazer.sh"
cat > "$DESFAZER" <<'UNDO'
#!/usr/bin/env bash
# Remove apenas as regras adicionadas nesta execução; sinaliza qualquer falha.
status=0
trap 'exit "$status"' EXIT
UNDO
MANTER=0
NOVAS=0

limpar() {
  local codigo=$?
  trap - EXIT
  if [[ "$MANTER" == 0 && "$NOVAS" -gt 0 ]]; then
    echo 'O teste não concluiu com sucesso. Removendo somente as novas regras...'
    if bash "$DESFAZER"; then
      echo 'Exceções adicionadas nesta execução removidas.'
    else
      printf 'ATENÇÃO: a reversão apresentou erro. Guarde este caminho: %s\n' "$DESFAZER" >&2
    fi
  fi
  exit "$codigo"
}
trap limpar EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

adicionar() {
  if sudo -n iptables-legacy -w 5 -C DOCKER-USER "$@" 2>/dev/null; then
    echo 'Regra equivalente já existente; não será duplicada.'
    return 0
  fi
  sudo -n iptables-legacy -w 5 -I DOCKER-USER 1 "$@"
  NOVAS=$((NOVAS + 1))
  {
    printf 'sudo -n iptables-legacy -w 5 -D DOCKER-USER'
    printf ' %q' "$@"
    printf ' || status=1\n'
  } >> "$DESFAZER"
}

printf '\n=== 3. Aplicando exceções restritas ao IPv4 atual da API ===\n'
# Volta: somente conexões já estabelecidas/relacionadas para esta API.
adicionar ! -i "$PONTE" -o "$PONTE" -d "$IP_API/32" \
  -m conntrack --ctstate ESTABLISHED,RELATED \
  -m comment --comment estante-api-retorno -j ACCEPT

# Saída: resolução DNS, protocolo UDP.
adicionar -i "$PONTE" ! -o "$PONTE" -s "$IP_API/32" \
  -p udp --dport 53 -m conntrack --ctstate NEW,ESTABLISHED \
  -m comment --comment estante-api-dns-udp -j ACCEPT

# Saída: resolução DNS por TCP e consultas HTTPS.
adicionar -i "$PONTE" ! -o "$PONTE" -s "$IP_API/32" \
  -p tcp -m multiport --dports 53,443 \
  -m conntrack --ctstate NEW,ESTABLISHED \
  -m comment --comment estante-api-dns-https -j ACCEPT

printf '\n=== 4. Nova consulta real, ainda sem cache ===\n'
if ! sondar; then
  falhar "A consulta continuou falhando. As regras novas serão removidas. Envie a saída completa."
fi
MANTER=1
printf '\nAJUSTE VALIDADO: a consulta externa passou após o teste das exceções.\n'
printf 'Regras adicionadas nesta execução: %s\n' "$NOVAS"
if [[ "$NOVAS" -gt 0 ]]; then
  printf 'Para desfazer somente estas regras: bash %q\n' "$DESFAZER"
fi
sudo -n iptables-legacy -n -v -L DOCKER-USER --line-numbers
printf '\nNenhum código, livro, volume ou porta publicada foi alterado.\n'
echo 'O ajuste é local ao ambiente e ao IP/rede atuais; não configura persistência após reinicialização.'
echo 'Mantenha a regra de comunicação interna que funcionou anteriormente.'
echo 'Próximo passo: python ../estante-academica-api/scripts/testar_catalogo.py'
