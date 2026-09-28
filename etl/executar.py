"""Inicializador a prova de silencio.

O `pythonw.exe` nao tem console: se o Python quebrar antes do logging existir -
um `import` que falta, o ENV ausente, a pasta errada - a mensagem de erro nao
tem para onde ir e a tarefa agendada simplesmente "roda" sem fazer nada. Foi
exatamente esse o sintoma que travou o agendamento.

Este arquivo existe para que isso nunca mais seja invisivel: ele chama o
`sync_bi_comercial.py` de dentro de um try/except que grava qualquer falha em
`falha_inicial.log`, na mesma pasta. Se a tarefa "rodou" e nada aconteceu,
esse arquivo diz o motivo.

A tarefa agendada aponta para ca:
    pythonw.exe "C:\\BI\\COMERCIAL\\executar.py" --grupo rapidas
"""

import os
import sys
import datetime

PASTA = os.path.dirname(os.path.abspath(__file__))
ALVO = os.path.join(PASTA, "sync_bi_comercial.py")
FALHA = os.path.join(PASTA, "falha_inicial.log")


def _registrar_falha(texto: str) -> None:
    """Grava o erro em arquivo. Nunca levanta excecao - se nem isso funcionar,
    nao ha mais nada a fazer, e quebrar aqui so apagaria o rastro."""
    try:
        with open(FALHA, "a", encoding="utf-8") as arq:
            arq.write("=" * 70 + "\n")
            arq.write(datetime.datetime.now().strftime("%d/%m/%Y %H:%M:%S") + "\n")
            arq.write("executavel : " + sys.executable + "\n")
            arq.write("pasta      : " + PASTA + "\n")
            arq.write("argumentos : " + " ".join(sys.argv[1:]) + "\n")
            arq.write("usuario    : " + os.environ.get("USERNAME", "?") + "\n")
            arq.write("-" * 70 + "\n")
            arq.write(texto)
            arq.write("\n")
    except Exception:
        pass


def main() -> int:
    # Sem console, `sys.stdout` e `sys.stderr` sao None e qualquer print quebra.
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")

    if not os.path.isfile(ALVO):
        _registrar_falha("Nao encontrei o sync_bi_comercial.py em " + PASTA)
        return 2

    # A pasta do script precisa estar no path de import, porque o
    # sync_bi_comercial importa o bi_comum e o consultas_comercial como vizinhos.
    if PASTA not in sys.path:
        sys.path.insert(0, PASTA)

    # O bi_comum acha o ENV e o log a partir de `sys.argv[0]`. Apontando para o
    # alvo, tudo cai na mesma pasta, como se ele tivesse sido chamado direto.
    sys.argv = [ALVO] + sys.argv[1:]
    os.chdir(PASTA)

    try:
        with open(ALVO, "r", encoding="utf-8") as arq:
            codigo = compile(arq.read(), ALVO, "exec")
        escopo = {"__name__": "__main__", "__file__": ALVO}
        exec(codigo, escopo)
        return 0
    except SystemExit as saida:
        return int(saida.code or 0)
    except BaseException:
        import traceback
        _registrar_falha(traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
