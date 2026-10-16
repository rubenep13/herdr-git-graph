# herdr-git-graph

Visor web **de solo lectura** del historial Git de los repositorios del Mac, con las
ramas y tags a la izquierda del grafo, unidas a su commit:

```
RAMA / TAG                  GRAFO     COMMIT
main ⇅origin ────────────────●        Merge…
feat/example ────────────────┼──●     feat: …
```

Se sirve en `127.0.0.1:3020` del Mac y se abre desde Herdr, que crea el túnel SSH
hasta el cliente (Omarchy) y abre el navegador. No hace falta ningún `ssh -L`.

- Base: [`@web-git-graph/{node,protocol,web}` 1.0.7](https://github.com/GIS-Info/web-git-graph)
  (MIT, tag `v1.0.7` = `a376b1b7`, publicado en npm). Se usan su backend Git local y
  su motor de carriles (`layoutGitGraph`); el renderizador de filas es propio para poder
  poner las referencias a la izquierda.
- Sin dependencias de GitHub, sin analítica, sin avatares ni fuentes remotas.

## Uso

Desde cualquier pestaña de Herdr de un workspace **del Mac**:

```sh
hgg            # = hgg open: arranca si hace falta y pide a Herdr que lo abra
```

`hgg` es un enlace `~/.local/bin/hgg → ~/Devs/herdr-git-graph/bin/hgg` (ya en el PATH vía `~/.zshrc`).

| Comando | Qué hace |
| --- | --- |
| `hgg` / `hgg open [--no-focus]` | Arranca el servidor (si no corre) y ejecuta `herdr-gpui browser open http://localhost:3020/` |
| `hgg start` / `stop` / `restart` | Gestiona solo esta instancia (PID verificado; nunca arranca dos) |
| `hgg status` / `logs [-f]` | Estado y log (`.run/server.log`) |
| `hgg url` | Enlace de acceso de un solo uso (2 min), para abrir el visor en otro navegador |
| `hgg rotate-token` | Cambia el secreto: cierra todas las sesiones de navegador (sin reiniciar) |
| `hgg launchd-plist` | Imprime un LaunchAgent para arrancarlo con la sesión (no lo instala) |

Aspecto calcado de la vista de GitKraken: filas teñidas por carril, burbujas de autor (iniciales, sin
avatares remotos), merges como puntos, líneas en ángulo recto con esquinas redondeadas, etiquetas
sólidas con ✓ (rama actual) e iconos local/remoto, y marcas de tiempo relativas. Por defecto solo
RAMA / TAG · GRAFO · MENSAJE; el engranaje añade Autor, Fecha y SHA (se recuerda).

Teclado: `j/k` mover · `Enter` detalle · `/` buscar · `n/N` resultados · `Ctrl+K` repos ·
`w` cambios sin commit · `h` HEAD · `c` copiar hash · `r` recargar · `?` ayuda.

## Instalación y desarrollo

```sh
cd ~/Devs/herdr-git-graph
npm ci                 # dependencias locales (node_modules/)
npm run build          # página en dist/public
npm test               # pruebas unitarias y de integración (fixtures en /tmp)
npm run test:e2e       # navegador real (Chrome en macOS; HGG_BROWSER=/ruta/chromium en Linux)
npm run typecheck
npm run dev            # recompila y reinicia al cambiar, en el puerto 3022
```

Requiere Node ≥ 24.2 (ejecuta TypeScript directamente) y git.

## Configuración

`config.json` (ver `config.example.json`); `HGG_PORT` y `HGG_CONFIG` la sobrescriben.

```json
{ "port": 3020, "roots": [{ "path": "~/Devs", "depth": 3 }], "repositories": [], "includeLinkedWorktrees": true }
```

- Solo se listan repositorios encontrados bajo `roots` (hasta `depth` niveles, sin seguir
  enlaces simbólicos, sin entrar en `node_modules` ni carpetas ocultas) o en `repositories`.
  Cada candidato se confirma con `git rev-parse`; un `.git` suelto no basta.
- Los worktrees enlazados se descubren con `git worktree list` de un repositorio permitido,
  aunque estén fuera de las raíces (p. ej. `~/.herdr/worktrees/...`).
- Una petición nunca nombra una ruta: solo ids del registro. `host` solo admite loopback.

## Acceso con token

Escuchar solo en loopback no basta: cualquier proceso local, o una extensión del navegador de
Omarchy a través del reenvío de Herdr, podría leer `127.0.0.1:3020`. Por eso la API exige sesión:

- El secreto vive en `.run/token` (permisos `0600`, fuera de Git) y no sale del Mac.
- `hgg` firma con él un billete de un solo uso (válido 2 minutos) y abre
  `http://localhost:3020/#t=<billete>`. Al ir en el fragmento `#`, no llega al servidor en la URL
  ni en el `Referer`; una vez usado no sirve de nada aunque quede en el historial.
- La página lo canjea (`POST /api/session`) por un token de sesión que guarda en `localStorage`
  (aislado por origen y puerto; una cookie de `localhost` la recibiría cualquier otro servidor
  local) y lo envía como `Authorization: Bearer`. Sin sesión, la página explica cómo entrar.
- Sin sesión solo responden `/api/health` (estado, sin datos de repos) y los ficheros de la página.
- La sesión sobrevive a reinicios del servidor; `hgg rotate-token` las invalida todas.
- `config.json` admite `"auth": false` para desactivarlo (no recomendado).

## Solo lectura

- No hay rutas de escritura: solo `GET`, y dos `POST` que calculan comparación/diff.
- Todo proceso git corre con `GIT_OPTIONAL_LOCKS=0` (no reescribe `.git/index`),
  `core.fsmonitor=false`, `core.hooksPath=/dev/null` (ningún hook), `GIT_NO_LAZY_FETCH=1`,
  `protocol.allow=never` (nunca contacta remotos), `gc.auto=0`, y sin variables `GIT_*` heredadas.
  Nunca hay fetch, checkout, stash ni mantenimiento.
- **Checkpoints de Herdr**: el historial solo recorre `refs/heads`, `refs/remotes` y
  `refs/tags` (+ HEAD y stash). `refs/herdr-gpui/*` no se lee como punta ni se modifica;
  un commit que también alcanza una rama sigue visible. Equivale a
  `git log --exclude=refs/herdr-gpui/* --all` sin el resto de espacios de `--all`.
- Las pruebas lo verifican con huellas de todos los ficheros del repo y trampas (hook,
  fsmonitor, índice desfasado) que un `git status` normal sí dispara.

## Herdr: túnel y recuperación

`hgg open` usa el shim que Herdr UI instala en el Mac
(`~/.local/state/herdr/gpui/bin/herdr-gpui`): deja la petición en el workspace (30 s) y la
ventana de Herdr UI conectada al Mac reenvía `localhost:3020` a `127.0.0.1:3020` del cliente
(su propio `ssh -N` con ControlMaster privado) y abre el navegador del sistema.

| Situación | Qué pasa | Qué hacer |
| --- | --- | --- |
| Cerrar la pestaña y volver a abrir | El reenvío sigue activo; la URL sigue sirviendo | Reabrir la URL, o `hgg open` (reutiliza el reenvío) |
| Reiniciar solo el servidor (`hgg restart`) | El túnel sigue; mientras está caído las peticiones fallan; la página se reconecta sola (indicador «en vivo») | Nada, o recargar |
| Puerto local ocupado en el cliente | Herdr reintenta en un puerto aleatorio y reescribe la URL | Nada (el servidor acepta cualquier puerto loopback) |
| Se cae el SSH del reenvío | El reenvío queda «ended»; **no se reconecta solo** | `hgg open` otra vez, o menú del host Mac › *Forward port…* 3020 |
| Herdr UI se cierra | Se cierran sus reenvíos | Reabrir Herdr UI y `hgg open` |
| Ninguna ventana conectada al Mac en 30 s | La petición caduca sin aviso | Conectar la ventana al Mac y repetir |

La página muestra «reconectando…» y un aviso cuando el servidor o el túnel no responden.

## Mantenerlo vivo

Instalado como LaunchAgent `local.herdr-git-graph` (`~/Library/LaunchAgents/local.herdr-git-graph.plist`,
copia de `launchd/`): arranca con la sesión y launchd lo relanza si muere. Log: `.run/launchd.log`.
Con launchd activo, `hgg stop` no lo detiene (se relanzaría); para pararlo:

```sh
launchctl bootout gui/$(id -u)/local.herdr-git-graph     # parar y descargar
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.herdr-git-graph.plist   # volver a cargar
launchctl kickstart -k gui/$(id -u)/local.herdr-git-graph  # reiniciar (p. ej. tras cambiar config.json)
```

Sin el LaunchAgent, `hgg` arranca el servidor en segundo plano bajo demanda. El túnel es cosa
de Herdr, no del LaunchAgent.

## Desinstalar

```sh
launchctl bootout gui/$(id -u)/local.herdr-git-graph && rm ~/Library/LaunchAgents/local.herdr-git-graph.plist
rm ~/.local/bin/hgg                      # el atajo
rm -rf ~/Devs/herdr-git-graph            # nada más fuera de esta carpeta
```

## Licencia y créditos

MIT (ver `LICENSE`). Usa [web-git-graph](https://github.com/GIS-Info/web-git-graph) (MIT, © kian-zh)
como dependencia de npm y el icono «settings» de [Feather](https://feathericons.com) (MIT, © Cole Bemis).
El aspecto se inspira en la vista de grafo de GitKraken; no contiene código ni recursos de GitKraken.
