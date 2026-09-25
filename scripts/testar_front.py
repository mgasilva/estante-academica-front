#!/usr/bin/env python3
"""Confere arquivos estáticos e proxy da interface. Não grava nem exclui livros."""
import argparse
import json
import sys
import urllib.error
import urllib.request


def verificar(base: str) -> None:
    def ler(caminho: str):
        with urllib.request.urlopen(base + caminho, timeout=15) as resposta:
            return resposta.status, resposta.headers.get('Content-Type', ''), resposta.read()

    codigo, tipo, html = ler('/')
    if codigo != 200 or 'text/html' not in tipo or 'Estante Acadêmica'.encode() not in html:
        raise RuntimeError('Página inicial não corresponde à Estante Acadêmica.')
    print('OK: página inicial da interface (HTML).')
    for arquivo in ('/app.js', '/modelo.js'):
        codigo, tipo, corpo = ler(arquivo)
        if codigo != 200 or 'javascript' not in tipo or not corpo:
            raise RuntimeError(f'JavaScript ausente ou MIME incorreto: {arquivo} ({tipo}).')
        print(f'OK: {arquivo} servido como JavaScript.')
    codigo, tipo, corpo = ler('/api/')
    dados = json.loads(corpo)
    if codigo != 200 or dados.get('service') != 'estante-academica-api':
        raise RuntimeError('O proxy não alcançou a API esperada.')
    print('OK: Nginx encaminha /api/ para o FastAPI.')
    codigo, tipo, corpo = ler('/api/livros')
    livros = json.loads(corpo)
    if codigo != 200 or not isinstance(livros, list):
        raise RuntimeError('Listagem da estante não retornou um array JSON.')
    print(f'OK: estante consultada pelo proxy ({len(livros)} livro(s)).')
    print('TESTE DO FRONT: OK. Nenhum livro foi cadastrado ou excluído.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:8080')
    args = parser.parse_args()
    try:
        verificar(args.base_url.rstrip('/'))
    except (OSError, ValueError, RuntimeError) as exc:
        print(f'ERRO: {exc}', file=sys.stderr)
        sys.exit(1)
