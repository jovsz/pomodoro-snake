# CODEC // Pomodoro

**English** · **Español**

A Pomodoro timer dressed as a Metal Gear codec. The same instructions are below in English and in Spanish.

Un temporizador Pomodoro con pinta de codec de Metal Gear. Las mismas instrucciones están abajo en inglés y en español.

![Codec ready for an infiltration](docs/infiltration.png)

## English

Register the work you are about to do, run the clock, and keep a monthly record of the time, including minutes you add by hand. The screen itself is in Spanish. The labels below are translated.

### Run it

Docker Compose starts the app and Postgres.

```bash
docker compose up -d --build
```

Open [http://127.0.0.1:8757](http://127.0.0.1:8757).

`docker compose down` stops the containers and keeps the database. `docker compose down -v` deletes the data.

Postgres is not published on the host. The app reaches it with `postgres://codec:codec@db:5432/pomodoro`.

### Phases

| Control | Frequency | Default | What it is |
| --- | --- | --- | --- |
| INFILTRACIÓN | 140.85 | 25 min | Focus block |
| PAUSA TÁCTICA | 141.12 | 5 min | Short break |
| EXTRACCIÓN | 141.80 | 15 min | Long break, after a full cycle |

Press **INICIAR** to start the selected phase. **PAUSA** holds it, **ABORTAR** throws the block away, and **SALTAR** moves on without recording it. A long break arrives after four completed infiltrations. Change that count in settings.

When you start a phase from its full duration, a short animation plays in the center and then leaves. It does not stay under the clock. Resuming a paused phase does not play it again. When an infiltration reaches zero, a salute marks **FASE CLEAR** and the block is stored.

### Activities

Type the work under **ACTIVIDAD**, set how many infiltrations you expect, choose **RUTINA**, **PRIORIDAD**, or **URGENTE**, and press **REGISTRAR**.

The active row is the target (**BLANCO**) credited when the block finishes. **ABIERTAS** lists open work. **LISTAS** lists finished work. **REGISTRO** is the recent log. **CLR** marks a row done. **DEL** asks once, then deletes it.

**MIN** logs extra minutes on an activity immediately (+5, +10, +15, or +25), even if the clock is stopped. **ALARGAR** adds 5, 10, or 15 minutes to the infiltration that is running. Those minutes count when the block closes. Aborting or skipping drops the extension.

### History

**MES** is a year of days, in the same shape as a contribution graph. The color is the time logged that day, including extra minutes. The list under the grid is the selected month. Click a day to see only that day. The arrows move between months.

![October history](docs/history.png)

### Keyboard

| Key | Action |
| --- | --- |
| Space | Start or pause |
| R | Abort |
| S | Skip |
| I / E | Mark an internal or external interruption during a running infiltration |
| N | Focus the activity field |
| 1 / 2 / 3 | Infiltration, tactical pause, extraction |

### Settings

**SYS** opens the link parameters: call sign, phase lengths, pomodoros per cycle, daily goal, chaining the next phase, codec sound, desktop notifications, closing an activity when its estimate is met, and requiring a target before an infiltration.

![Link parameters](docs/settings.png)

### Where the data lives

Postgres is the record. The timer, activities, and session history survive a restart. The month view reads the full history. The on-screen log only keeps the latest entries.

## Español

Registra lo que vas a hacer, corre el reloj y guarda un historial mensual del tiempo, incluidos los minutos que agregues a mano.

### Arranque

Docker Compose levanta la aplicación y Postgres.

```bash
docker compose up -d --build
```

Abre [http://127.0.0.1:8757](http://127.0.0.1:8757).

`docker compose down` detiene los contenedores y conserva la base. `docker compose down -v` borra los datos.

Postgres no se publica en el host. La aplicación llega con `postgres://codec:codec@db:5432/pomodoro`.

### Fases

| Control | Frecuencia | Por defecto | Qué es |
| --- | --- | --- | --- |
| INFILTRACIÓN | 140.85 | 25 min | Bloque de foco |
| PAUSA TÁCTICA | 141.12 | 5 min | Pausa corta |
| EXTRACCIÓN | 141.80 | 15 min | Pausa larga, al cerrar un ciclo |

**INICIAR** arranca la fase elegida. **PAUSA** la detiene, **ABORTAR** la descarta y **SALTAR** pasa a la siguiente sin registrarla. La extracción llega después de cuatro infiltraciones completas. Ese número se cambia en ajustes.

Al iniciar una fase desde su duración completa, una animación breve aparece en el centro y se va. No se queda debajo del reloj. Reanudar una fase a medias no la vuelve a mostrar. Cuando la infiltración llega a cero, un saludo marca **FASE CLEAR** y el bloque queda guardado.

### Actividades

Escribe el trabajo en **ACTIVIDAD**, indica cuántas infiltraciones estimas, elige **RUTINA**, **PRIORIDAD** o **URGENTE**, y pulsa **REGISTRAR**.

La fila activa es el blanco que se acredita al cerrar el bloque. **ABIERTAS** muestra lo pendiente. **LISTAS** muestra lo terminado. **REGISTRO** es el historial reciente. **CLR** marca una fila como lista. **DEL** pide confirmación y luego la borra.

**MIN** anota minutos extra en una actividad al momento (+5, +10, +15 o +25), aunque el reloj esté detenido. **ALARGAR** suma 5, 10 o 15 minutos a la infiltración en curso. Esos minutos cuentan cuando el bloque se cierra. Abortar o saltar descarta la extensión.

### Historial

**MES** es un año de días, con la forma de un gráfico de contribuciones. El color es el tiempo de ese día, incluido lo añadido. La lista bajo la cuadrícula es el mes elegido. Un clic en un día muestra solo ese día. Las flechas cambian de mes.

![Historial de octubre](docs/history.png)

### Teclado

| Tecla | Acción |
| --- | --- |
| Espacio | Iniciar o pausar |
| R | Abortar |
| S | Saltar |
| I / E | Marcar una interrupción interna o externa durante una infiltración en curso |
| N | Ir al campo de actividad |
| 1 / 2 / 3 | Infiltración, pausa táctica, extracción |

### Ajustes

**SYS** abre los parámetros del enlace: indicativo, duración de las fases, pomodoros por ciclo, meta diaria, encadenar la fase siguiente, sonido del codec, avisos de escritorio, cerrar la actividad al cumplir la estimación y exigir un blanco antes de infiltrar.

![Parámetros del enlace](docs/settings.png)

### Dónde quedan los datos

Postgres es el registro. El reloj, las actividades y el historial sobreviven a un reinicio. La vista del mes lee todo el historial. El registro en pantalla solo conserva las entradas recientes.
