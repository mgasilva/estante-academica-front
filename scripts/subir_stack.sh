#!/usr/bin/env bash
# Inicia as duas aplicações e migra, uma única vez, a API criada sem Compose.
# Nunca remove volumes e nunca modifica os fontes da API.
set -euo pipefail
cd "$(dirname "$0")/.."

for command in docker python curl; do
  command -v "$command" >/dev/null || { echo "ERRO: comando ausente: $command" >&2; exit 1; }
done
if [[ ! -f ../estante-academica-api/Dockerfile ]]; then
  echo "ERRO: a pasta ../estante-academica-api deve existir ao lado do front-end." >&2
  exit 1
fi
docker info >/dev/null
docker compose version
docker compose -p estante-academica config --quiet

# Verificação ANTES do build e antes de parar qualquer contêiner.
legacy_api=0
for container in estante-api estante-front; do
  if docker container inspect "$container" >/dev/null 2>&1; then
    project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$container")"
    if [[ "$project" == "estante-academica" ]]; then
      : # O Compose já gerencia este contêiner.
    elif [[ "$container" == "estante-api" && ( -z "$project" || "$project" == "<no value>" ) ]]; then
      legacy_api=1
    else
      echo "ERRO: $container não pertence a este Compose. Não vou removê-lo." >&2
      exit 1
    fi
    if [[ "$container" == "estante-api" ]]; then
      docker inspect "$container" | python -c '
import json, sys
info = json.load(sys.stdin)[0]
mounts = [m for m in info.get("Mounts", []) if m.get("Destination") == "/data"]
if len(mounts) != 1 or mounts[0].get("Type") != "volume" or mounts[0].get("Name") != "estante-academica-dados":
    sys.exit("ERRO: /data não usa o volume esperado. Nenhum contêiner foi removido.")
'
    fi
  fi
done

echo "Construindo as imagens antes de substituir os contêineres..."
docker compose -p estante-academica build

docker volume create estante-academica-dados >/dev/null
if [[ "$legacy_api" == 1 ]]; then
  if [[ "$(docker inspect -f '{{.State.Running}}' estante-api)" != "true" ]]; then
    echo "ERRO: a API anterior está parada. Execute docker start estante-api e repita este script." >&2
    exit 1
  fi
  # Snapshot consistente pela API de backup do SQLite. A origem é aberta somente para leitura.
  stamp="$(date -u +%Y%m%d-%H%M%S)-$$"
  backup="../backups-estante-academica/migracao-compose-$stamp"
  mkdir -p "$backup"
  docker exec -i estante-api python - <<'PY'
from pathlib import Path
import sqlite3
origem = Path('/data/estante.db')
if not origem.is_file():
    raise SystemExit('ERRO: banco esperado não existe. A migração foi interrompida.')
with sqlite3.connect('file:/data/estante.db?mode=ro', uri=True) as fonte:
    with sqlite3.connect('/tmp/estante-pre-compose.db') as copia:
        fonte.backup(copia)
PY
  docker cp estante-api:/tmp/estante-pre-compose.db "$backup/estante.db"
  docker exec estante-api rm /tmp/estante-pre-compose.db
  echo "Cópia de segurança do banco: $backup/estante.db"
  echo "Substituindo apenas o contêiner antigo da API. O volume será reutilizado."
  docker stop estante-api >/dev/null
  docker rm estante-api >/dev/null
fi

if ! docker compose -p estante-academica up -d --wait --wait-timeout 90; then
  echo "ERRO: a inicialização falhou. Não remova volumes. Confira os logs abaixo." >&2
  docker compose -p estante-academica logs --tail=60 >&2
  exit 1
fi
curl -fsS --retry 5 --retry-connrefused --retry-delay 2 http://127.0.0.1:8080/api/ >/dev/null
echo
echo "APLICAÇÃO PRONTA."
echo "Interface: http://127.0.0.1:8080"
echo "Swagger da API: http://127.0.0.1:8000/docs"
echo "No Codespaces: abra a porta 8080 em Ports. Mantenha as portas privadas."
echo "Daqui em diante, use este script para subir as duas aplicações."
echo "Não volte a executar scripts/subir_api.sh da etapa anterior."
echo
docker compose -p estante-academica ps
