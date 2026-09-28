"""Cobaia do agendador: prova, em dois segundos, se uma tarefa consegue mesmo
iniciar um processo naquele modo de logon.

O `instalar_e_agendar.ps1` registra uma tarefa temporaria apontando para ca,
dispara e espera o arquivo `_teste_agendador.txt` aparecer. Se aparecer, o modo
funciona e as tarefas de verdade sao criadas com ele. Se nao aparecer em 45
segundos, o script tenta o proximo modo.

Nao toca no banco, nao le o ENV, nao importa nada do ETL: se ate isto falhar,
o problema e o agendamento, nunca o pipeline.
"""

import datetime
import os
import sys

PASTA = os.path.dirname(os.path.abspath(__file__))
MARCA = os.path.join(PASTA, "_teste_agendador.txt")

with open(MARCA, "w", encoding="utf-8") as arq:
    arq.write("horario   : " + datetime.datetime.now().strftime("%d/%m/%Y %H:%M:%S") + "\n")
    arq.write("usuario   : " + os.environ.get("USERNAME", "?") + "\n")
    arq.write("dominio   : " + os.environ.get("USERDOMAIN", "?") + "\n")
    arq.write("python    : " + sys.executable + "\n")
    arq.write("pasta     : " + os.getcwd() + "\n")
