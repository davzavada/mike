# Mike na Proxmoxu

Runbook instance `mike.davidzavada.cz`. Hesla tady nejsou: leží jen
v `/opt/mike/.env` na CT 105 (práva 600).

## Co kde běží

- **CT 105 `mike`**: Debian 13, neprivilegovaný, `nesting=1,keyctl=1`, 4 vCPU,
  6 GB RAM, 4 GB swap, disk 32 GB na `local-lvm`. `eth0` 192.168.0.55 (jen
  odchozí provoz), `eth1` 10.10.10.6 (vnitřní síť `vmbr1`).
- V něm Docker Compose z `/opt/mike` (větev `deploy` forku `davzavada/mike`):
  Postgres, Auth (GoTrue), PostgREST, RustFS, Redis, backend, frontend.
  Databáze i soubory jsou v Docker svazcích na disku CT 105.
- Ven jde jen web (`10.10.10.6:3000`) a úložiště (`10.10.10.6:9000`), obojí
  přes Cloudflare Tunnel v CT 102. Ostatní porty poslouchají na loopbacku.
- Claude Code běží v kontejneru `backend`. Přihlášení uživatelů k předplatnému
  jsou ve svazku `claude_data` (`/data/claude/<id uživatele>`).

```bash
ssh pve pct exec 105 -- bash                       # shell v CT
ssh pve pct exec 105 -- bash -c 'cd /opt/mike && docker compose ps'
ssh pve pct exec 105 -- bash -c 'cd /opt/mike && docker compose logs --tail 100 backend'
```

## První instalace

```bash
git clone -b deploy https://github.com/davzavada/mike.git /opt/mike
cd /opt/mike
deploy/proxmox/init-env.sh mike.davidzavada.cz mike-files.davidzavada.cz 10.10.10.6
deploy/proxmox/deploy.sh
```

`init-env.sh` vygeneruje všechna tajemství na serveru a existující `.env`
nepřepíše. Jejich výměna odhlásí uživatele a znečitelní uložené API klíče
(`docs/deployment.md`).

## Nasazení nové verze

```bash
ssh pve "pct exec 105 -- /opt/mike/deploy/proxmox/deploy.sh --pull"
```

Sestavení trvá několik minut. Skript skončí chybou, pokud web do pěti minut
neodpoví. Migrace databáze spouští služba `db-init` při každém startu.

Nová verze upstreamu: na Macu `git fetch upstream`, sloučit tag do `deploy`,
`git push`, pak příkaz výše.

## Účty

Registrace je vypnutá (`GOTRUE_DISABLE_SIGNUP=true`). Účet zakládá správce:

```bash
ssh -t pve "pct exec 105 -- /opt/mike/deploy/proxmox/add-user.sh nekdo@example.com"
```

Skript vypíše jednorázové heslo; uživatel si ho po přihlášení změní.
E-maily se neposílají, takže obnova hesla e-mailem nefunguje. Zapomenuté
heslo: smazat účet v `auth.users` a založit ho znovu, nebo nastavit SMTP.

Každý uživatel si v Nastavení → API Keys připojí vlastní Claude předplatné,
nebo uloží vlastní API klíč (`docs/claude-subscription.md`).

## Google konektory (Drive, Gmail, Kalendář)

Mike nemá vlastního Google klienta; každá instalace si ho zakládá sama
v Google Cloud Console (`docs/google-workspace.md`). Jednorázově:

1. V projektu zapnout **Google Drive API**, **Gmail API** a **Google
   Calendar API**.
2. Vytvořit OAuth klienta typu *Web application* s adresami pro přesměrování:

   ```text
   https://mike.davidzavada.cz/api/user/integrations/google-drive/oauth/callback
   https://mike.davidzavada.cz/api/user/integrations/gmail/oauth/callback
   https://mike.davidzavada.cz/api/user/integrations/google-calendar/oauth/callback
   ```
3. Na souhlasové obrazovce povolit scopes `openid`, `userinfo.email`,
   `drive.file`, `gmail.readonly`, `gmail.compose`,
   `calendar.calendarlist.readonly`, `calendar.events.readonly`,
   `calendar.events`. V režimu Testing přidat každý Google účet mezi
   testovací uživatele; přihlášení pak platí sedm dní.
4. Uložit klienta na server (tajemství se při psaní nezobrazuje):

   ```bash
   ssh -t pve "pct exec 105 -- /opt/mike/deploy/proxmox/set-google-oauth.sh"
   ```

## Tunel

V CT 102, `/etc/cloudflared/config.yml`, tunel `dawmain-databaze`:

```yaml
  - hostname: mike.davidzavada.cz
    service: http://10.10.10.6:3000
  - hostname: mike-files.davidzavada.cz
    service: http://10.10.10.6:9000
```

`mike-files` přijímá jen podepsané požadavky: prohlížeč na něj nahrává
a stahuje soubory přes URL, které vydá backend. Cloudflare omezuje jedno
nahrání na 100 MB.

## Zálohy a místo

- Před větší změnou: `ssh pve pct snapshot 105 pred-<zmena>`. Návrat:
  `pct rollback 105 pred-<zmena>`.
- Snapshot obsahuje databázi, soubory i přihlášení k předplatným.
- Thin pool `local-lvm` je přealokovaný. Sleduj `ssh pve lvs` (Data %);
  zaplněný pool poškodí data všech kontejnerů.
- Staré obrazy po několika nasazeních: `docker image prune -f` v CT 105.
