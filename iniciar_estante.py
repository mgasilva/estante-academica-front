#!/usr/bin/env python3
"""Retoma os conteineres existentes da Estante Academica no Codespace.

Uso (na raiz do front-end):
    python iniciar_estante.py
    python iniciar_estante.py --corrigir-rede

A segunda forma autoriza reaplicar, SOMENTE se os testes falharem e o cenario
legacy/DROP for confirmado, as excecoes restritas antes validadas neste projeto.
Nao constroi imagens, nao recria conteineres, nao remove volumes e nao grava livros.
Nao instala servicos de inicializacao: execute este arquivo ao retomar o Codespace.
Referencias:
https://docs.docker.com/reference/cli/docker/compose/start/
https://docs.docker.com/engine/network/firewall-iptables/
https://docs.docker.com/engine/network/firewall-nftables/
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

PROJECT = "estante-academica"
NETWORK = PROJECT + "_default"
IPT = ["sudo", "-n", "iptables-legacy", "-w", "5"]
LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Falha(RuntimeError):
    pass


def comando(args: list[str], *, texto: str | None = None,
            timeout: int = 20, conferir: bool = True) -> subprocess.CompletedProcess:
    try:
        res = subprocess.run(args, input=texto, text=True, capture_output=True,
                             timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Falha(f"Nao foi possivel executar {args[0]}: {exc}") from exc
    if conferir and res.returncode:
        raise Falha(f"Comando falhou: {shlex.join(args)}\n{res.stderr.strip() or res.stdout.strip()}")
    return res


def ler_json(url: str, *, timeout: int = 12) -> object:
    try:
        with LOCAL.open(url, timeout=timeout) as res:
            bruto = res.read(2_000_001)
            if len(bruto) > 2_000_000:
                raise Falha("Resposta maior que o limite do diagnostico.")
            return json.loads(bruto)
    except (OSError, ValueError, urllib.error.URLError) as exc:
        raise Falha(f"{url}: {exc}") from exc


def testar_raiz(url: str) -> None:
    dados = ler_json(url)
    if not isinstance(dados, dict) or dados.get("service") != "estante-academica-api" or dados.get("status") != "ok":
        raise Falha("O endereco consultado nao devolveu a identificacao esperada da API.")


def validar_conteineres(infos: list[dict], *, rodando: bool) -> None:
    if {i.get("Name", "").lstrip("/") for i in infos} != {"estante-api", "estante-front"}:
        raise Falha("Os dois conteineres esperados nao foram encontrados.")
    for info in infos:
        nome = info["Name"].lstrip("/")
        labels = info.get("Config", {}).get("Labels") or {}
        if labels.get("com.docker.compose.project") != PROJECT or labels.get("com.docker.compose.service") != nome.removeprefix("estante-"):
            raise Falha(f"{nome} nao pertence ao Compose esperado. Nenhuma recriacao sera feita.")
        if rodando and not info.get("State", {}).get("Running"):
            raise Falha(f"{nome} continua parado.")
        if nome == "estante-api":
            volumes = [m for m in info.get("Mounts", []) if m.get("Destination") == "/data"]
            if len(volumes) != 1 or volumes[0].get("Type") != "volume" or volumes[0].get("Name") != "estante-academica-dados":
                raise Falha("O banco nao utiliza o volume esperado. Pare e confira antes de continuar.")


def rede_atual() -> tuple[str, str, str]:
    infos = json.loads(comando(["docker", "inspect", "estante-api", "estante-front"]).stdout)
    validar_conteineres(infos, rodando=True)
    rede = json.loads(comando(["docker", "network", "inspect", NETWORK]).stdout)[0]
    if rede.get("Driver") != "bridge" or (rede.get("Labels") or {}).get("com.docker.compose.project") != PROJECT:
        raise Falha("A rede atual nao e a bridge esperada do projeto.")
    confs = [ipaddress.ip_network(c["Subnet"]) for c in rede.get("IPAM", {}).get("Config", []) if c.get("Subnet")]
    redes_v4 = [r for r in confs if r.version == 4]
    if len(redes_v4) != 1 or not redes_v4[0].is_private:
        raise Falha("Sub-rede IPv4 privada nao identificada de forma unica.")
    sub = redes_v4[0]
    ponte = (rede.get("Options") or {}).get("com.docker.network.bridge.name") or "br-" + rede["Id"][:12]
    if not re.fullmatch(r"[a-zA-Z0-9_.:-]{1,15}", ponte) or ponte == "docker0":
        raise Falha("Nome inesperado para a bridge do projeto.")
    ip_api = ""
    ips = set()
    for info in infos:
        redes = info.get("NetworkSettings", {}).get("Networks", {})
        if set(redes) != {NETWORK}:
            raise Falha("Os conteineres nao estao exclusivamente na rede esperada. Revise a topologia.")
        endereco = ipaddress.ip_address(redes[NETWORK]["IPAddress"])
        if endereco.version != 4 or endereco not in sub:
            raise Falha("Endereco de conteiner fora da sub-rede esperada.")
        ips.add(str(endereco))
        if info["Name"] == "/estante-api":
            ip_api = str(endereco)
    if len(ips) != 2 or not ip_api:
        raise Falha("Nao foi possivel identificar os IPs de API e front-end.")
    return ponte, str(sub), ip_api


# Executado dentro da API em um processo NOVO: nao reutiliza o cache do servidor.
PROBE_EXTERNO = r'''
import json, socket, ssl, urllib.error
from app.catalogo import ClienteOpenLibrary
try:
    resultado = ClienteOpenLibrary().buscar("python", 3, 1)
    print(json.dumps({"ok": True, "quantidade": len(resultado["itens"])}))
except Exception as exc:
    cadeia, atual, vistos = [], exc, set()
    while atual is not None and id(atual) not in vistos:
        vistos.add(id(atual)); cadeia.append(atual)
        if isinstance(atual, urllib.error.URLError) and isinstance(atual.reason, BaseException):
            atual = atual.reason
        else:
            atual = atual.__cause__ or atual.__context__
    bloqueada = any(isinstance(e, (ssl.SSLError, urllib.error.HTTPError)) for e in cadeia)
    rede = not bloqueada and any(isinstance(e, (socket.gaierror, TimeoutError, ConnectionError)) or
                                (isinstance(e, OSError) and e.errno in (101, 113)) for e in cadeia)
    causa = cadeia[-1]
    print(json.dumps({"ok": False, "rede": rede,
                      "causa": type(causa).__name__ + ": " + str(causa)[:300]}))
'''


def testar_externo() -> dict:
    res = comando(["docker", "exec", "-i", "estante-api", "python", "-"],
                  texto=PROBE_EXTERNO, timeout=35)
    try:
        dados = json.loads(res.stdout)
    except ValueError as exc:
        raise Falha("A verificacao externa nao devolveu o diagnostico esperado. " + res.stderr[:400]) from exc
    if not isinstance(dados, dict) or "ok" not in dados:
        raise Falha("Formato inesperado no diagnostico externo.")
    return dados


def regra_atual(args: list[str], ponte: str, sub: str, ip_api: str) -> bool:
    """Identifica regras marcadas pelo projeto que ainda correspondem a esta rede/IP."""
    tag = args[args.index("--comment") + 1]
    def valor(flag: str) -> str:
        return args[args.index(flag) + 1]
    try:
        if tag == "estante-rede-interna":
            return (valor("-i") == ponte and valor("-o") == ponte and
                    ipaddress.ip_network(valor("-s"), strict=False) == ipaddress.ip_network(sub) and
                    ipaddress.ip_network(valor("-d"), strict=False) == ipaddress.ip_network(sub))
        if tag == "estante-api-retorno":
            return (valor("-i") == ponte and valor("-o") == ponte and
                    ipaddress.ip_network(valor("-d"), strict=False) == ipaddress.ip_network(ip_api + "/32"))
        return (valor("-i") == ponte and valor("-o") == ponte and
                ipaddress.ip_network(valor("-s"), strict=False) == ipaddress.ip_network(ip_api + "/32"))
    except (ValueError, IndexError):
        return False


def regras_desejadas(grupo: str, ponte: str, sub: str, ip_api: str) -> list[list[str]]:
    if grupo == "interna":
        return [["-i", ponte, "-o", ponte, "-s", sub, "-d", sub,
                 "-m", "comment", "--comment", "estante-rede-interna", "-j", "ACCEPT"]]
    return [
        ["-i", ponte, "!", "-o", ponte, "-s", ip_api + "/32", "-p", "tcp",
         "-m", "multiport", "--dports", "53,443", "-m", "conntrack", "--ctstate", "NEW,ESTABLISHED",
         "-m", "comment", "--comment", "estante-api-dns-https", "-j", "ACCEPT"],
        ["-i", ponte, "!", "-o", ponte, "-s", ip_api + "/32", "-p", "udp", "--dport", "53",
         "-m", "conntrack", "--ctstate", "NEW,ESTABLISHED", "-m", "comment", "--comment", "estante-api-dns-udp", "-j", "ACCEPT"],
        ["!", "-i", ponte, "-o", ponte, "-d", ip_api + "/32", "-m", "conntrack",
         "--ctstate", "RELATED,ESTABLISHED", "-m", "comment", "--comment", "estante-api-retorno", "-j", "ACCEPT"],
    ]


def ajustar(grupo: str, testar, raiz: Path) -> None:
    """Transacao restrita, com backup e reversao de mudancas deste grupo em caso de erro."""
    if os.environ.get("CODESPACES", "").lower() != "true":
        raise Falha("Correcao permitida apenas no Codespace (CODESPACES=true).")
    if os.environ.get("DOCKER_HOST", "unix:///var/run/docker.sock").split(":", 1)[0] != "unix":
        raise Falha("Docker remoto nao e suportado por este ajuste local de firewall.")
    ponte, sub, ip_api = rede_atual()
    comando(["ip", "link", "show", ponte])
    politica = comando(IPT + ["-S", "FORWARD"]).stdout.splitlines()
    if "-P FORWARD DROP" not in politica:
        raise Falha("O cenario legacy/FORWARD DROP nao esta presente. Nenhuma regra foi modificada.")
    comando(IPT + ["-C", "FORWARD", "-j", "DOCKER-USER"])
    existentes = comando(IPT + ["-S", "DOCKER-USER"]).stdout.splitlines()
    desejadas = regras_desejadas(grupo, ponte, sub, ip_api)
    tags = {r[r.index("--comment") + 1] for r in desejadas}
    antigas = []
    indice = 0
    for linha in existentes:
        partes = shlex.split(linha)
        if partes[:2] != ["-A", "DOCKER-USER"]:
            continue
        indice += 1
        args = partes[2:]
        if "--comment" in args and args[args.index("--comment") + 1] in tags:
            if "-j" not in args or args[args.index("-j") + 1] != "ACCEPT" or "-i" not in args or "-o" not in args:
                raise Falha("Uma regra identificada com nome do projeto foi modificada. Revise-a manualmente.")
            if not regra_atual(args, ponte, sub, ip_api):
                antigas.append((indice, args))
    base = raiz.parent / "backups-estante-academica"
    base.mkdir(exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix=f"retomada-{grupo}-", dir=base))
    (backup / "iptables-legacy.rules").write_text(comando(["sudo", "-n", "iptables-legacy-save"]).stdout)
    adicionadas, removidas = [], []
    undo = backup / "desfazer.sh"
    def gravar_reversao() -> None:
        linhas = ["#!/usr/bin/env bash", "set -euo pipefail", "# Reverte somente esta tentativa; nao restaura o firewall inteiro."]
        for regra in reversed(adicionadas):
            checar = shlex.join(IPT + ["-C", "DOCKER-USER"] + regra)
            apagar = shlex.join(IPT + ["-D", "DOCKER-USER"] + regra)
            linhas.append(f"if {checar} 2>/dev/null; then {apagar}; fi")
        for pos, regra in sorted(removidas):
            checar = shlex.join(IPT + ["-C", "DOCKER-USER"] + regra)
            restaurar = shlex.join(IPT + ["-I", "DOCKER-USER", str(pos)] + regra)
            linhas.append(f"if ! {checar} 2>/dev/null; then {restaurar}; fi")
        undo.write_text("\n".join(linhas) + "\n")
    gravar_reversao()
    print(f"Ajuste {grupo}: bridge={ponte}; API={ip_api}; backup={backup}", flush=True)
    try:
        for pos, regra in reversed(antigas):
            comando(IPT + ["-D", "DOCKER-USER"] + regra)
            removidas.append((pos, regra)); gravar_reversao()
        for regra in reversed(desejadas):
            res = comando(IPT + ["-C", "DOCKER-USER"] + regra, conferir=False)
            if res.returncode == 0:
                continue
            if res.returncode != 1:
                raise Falha("Nao foi possivel verificar uma regra antes da inclusao: " + res.stderr)
            comando(IPT + ["-I", "DOCKER-USER", "1"] + regra)
            adicionadas.append(regra); gravar_reversao()
        testar()
    except BaseException:
        print(f"A verificacao falhou; revertendo apenas o ajuste {grupo}...", flush=True)
        try:
            comando(["bash", str(undo)])
        except Falha as erro:
            print(f"ATENCAO: reversao nao confirmada: {erro}\nRevisar: {undo}", file=sys.stderr)
        raise
    print(f"Ajuste {grupo} validado. Para desfazer SOMENTE este ajuste: bash {undo}", flush=True)


def principal() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corrigir-rede", action="store_true", help="Autoriza os ajustes restritos, se forem necessarios.")
    args = parser.parse_args()
    os.umask(0o077)
    raiz = Path(__file__).resolve().parent
    if raiz.name != "estante-academica-front" or not (raiz / "compose.yaml").is_file():
        raise Falha("Coloque este arquivo na RAIZ de estante-academica-front, ao lado de compose.yaml.")
    os.chdir(raiz)
    infos = json.loads(comando(["docker", "inspect", "estante-api", "estante-front"]).stdout)
    validar_conteineres(infos, rodando=False)
    print("1/5 Retomando os conteineres existentes, sem recriar ou construir imagens...", flush=True)
    res = comando(["docker", "compose", "-p", PROJECT, "start", "--wait", "--wait-timeout", "90", "api", "front"], timeout=105)
    print(res.stdout.strip() or res.stderr.strip(), flush=True)
    print("2/5 Conferindo a API diretamente...", flush=True)
    testar_raiz("http://127.0.0.1:8000/")
    print("OK: API direta.", flush=True)
    print("3/5 Conferindo a comunicacao Nginx -> API...", flush=True)
    try:
        testar_raiz("http://127.0.0.1:8080/api/")
    except Falha as erro:
        print(str(erro), flush=True)
        # Corrige apenas timeout/502/504; erros de autenticacao/JSON seguem para diagnostico.
        causa = erro.__cause__
        elegivel = isinstance(causa, TimeoutError) or (isinstance(causa, urllib.error.HTTPError) and causa.code in (502, 504))
        if not elegivel or not args.corrigir_rede:
            raise Falha("Nao aplicado ajuste interno. Use --corrigir-rede para permitir a tentativa, ou envie esta saida.") from erro
        ajustar("interna", lambda: testar_raiz("http://127.0.0.1:8080/api/"), raiz)
    print("OK: Nginx -> API.", flush=True)
    print("4/5 Conferindo consulta externa nova, sem cache do servidor...", flush=True)
    externo = testar_externo()
    if not externo.get("ok"):
        print("Causa externa: " + externo.get("causa", "nao identificada"), flush=True)
        if not args.corrigir_rede or not externo.get("rede"):
            raise Falha("Nao aplicado ajuste de saida. Erros HTTP/certificado nao sao corrigidos liberando o firewall.")
        def repetir_externo() -> None:
            retorno = testar_externo()
            if not retorno.get("ok"):
                raise Falha("A consulta externa continua falhando: " + retorno.get("causa", ""))
        ajustar("saida", repetir_externo, raiz)
    print("OK: consulta externa sem cache.", flush=True)
    print("5/5 Conferindo livros e catalogo pelo Nginx...", flush=True)
    livros = ler_json("http://127.0.0.1:8080/api/livros")
    if not isinstance(livros, list):
        raise Falha("A listagem nao retornou o formato esperado; nao conclua que os livros foram perdidos.")
    # O teste externo usa outro processo; espacamos tambem esta consulta.
    time.sleep(1.2)
    catalogo = ler_json("http://127.0.0.1:8080/api/catalogo?busca=python&limite=3&pagina=1", timeout=35)
    if not isinstance(catalogo, dict) or catalogo.get("fonte") != "Open Library" or not isinstance(catalogo.get("itens"), list):
        raise Falha("O catalogo pelo Nginx nao retornou o formato esperado.")
    print(f"OK: {len(livros)} livro(s) na estante; {len(catalogo['itens'])} resultado(s) no catalogo.")
    print("\nAPLICACAO PRONTA. Abra Ports -> 8080 -> Open in Browser e atualize a pagina.")
    print("Nenhum livro foi cadastrado, editado ou excluido por este script.")
    print("Na proxima retomada: python iniciar_estante.py --corrigir-rede")
    print("O arquivo nao instala reaplicacao automatica no sistema; deve ser executado a cada retomada.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(principal())
    except (Falha, ValueError, KeyError, IndexError, OSError) as exc:
        print(f"\nERRO: {exc}", file=sys.stderr)
        print("Pare aqui e envie esta mensagem. Nao remova volumes nem desative o firewall.", file=sys.stderr)
        raise SystemExit(1)
    except KeyboardInterrupt:
        print("\nInterrompido. Confira as mensagens de reversao, caso um ajuste estivesse em andamento.", file=sys.stderr)
        raise SystemExit(130)
