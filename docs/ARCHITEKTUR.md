# Davenet – Architektur

Dieses Dokument beschreibt, wie das Konzept ([KONZEPT.md](KONZEPT.md)) technisch umgesetzt ist, und
beantwortet die offenen Punkte aus Konzept §20.

## Überblick

```
Browser (React, web/)
   │  REST + Server-Sent Events, nur localhost
   ▼
HTTP-Schicht (server/http)  ── Host-/Origin-/CSRF-Prüfung, Validierung (zod)
   │
Orchestrator (server/engine/orchestrator.ts)
   │  Pipeline-Logik · Freigaben · Gedächtnis · Audit
   ├── Scheduler (scheduler.ts)        Job-Queue, Wiederaufnahme, Zeit-Trigger, Budget-Events
   │      └── JobRunner (runner.ts)    Routing → Prompt → Provider-Aufruf → Prüfung → Ledger → Folgeaktion
   │             └── Router (router.ts)          Capability, Kontingent, Kosten, Policy
   │                    └── Provider-Adapter (server/providers)
   │                          ├── claude_cli     Claude Code CLI (Claude-Abo)
   │                          ├── anthropic_api  Messages API (API-Key)
   │                          └── mock           Simulation
   └── Shared Services
          ├── SQLite (node:sqlite)   Unternehmensdatenbank, Queue, Ledger, Audit
          ├── data/company/…         Unternehmensgedächtnis (Artefakte als Dateien)
          ├── data/workspaces/OPP-…  Projekt-Workspaces (Git, falls installiert)
          └── data/secrets.json      Zugangsdaten (0600, nie an die Oberfläche)
```

Ein Prozess, keine externen Dienste: `npm start` startet API, Scheduler und Oberfläche.
Agents laufen nie dauerhaft – jeder Job ist genau ein (ggf. mehrstufiger) Modellaufruf.

## Datenmodell

| Tabelle | Inhalt |
| --- | --- |
| `departments`, `agents` | Organisation; Agents mit Capability, Werkzeugen, erlaubten Providern, Policy, Limits |
| `job_routes` | Zuständigkeit Job-Typ → Agent (+ optionale Capability-Überschreibung, aktiv/inaktiv) |
| `providers`, `models` | Anbieter mit Abrechnungsart, Kontingent, Kostenlimit, Laufzeitzustand; Modelle je Capability-Klasse mit Preisen |
| `jobs` | Queue inkl. Status, Priorität, Versuchen, Wartegrund, frühestem Start, Verbrauch, Protokoll |
| `opportunities`, `tasks` | Pipeline-Objekte (Konzept §9) inkl. 13 Kriterien, K.-o., Rechtsprüfung, Nachfragetest, Fixkosten, Portfolio-Empfehlung; Projekt-Tasks |
| `approvals` | Freigaben (Nachfragetest, Projektstart, Beenden, Release, Provider-Wechsel) |
| `finance_entries` | Einnahmen, Ausgaben (€) und Owner-Zeit (Std.) je Produkt oder allgemein |
| `artifacts` | Metadaten der Artefakte; Inhalt liegt als Datei im Gedächtnis |
| `usage_events` | Ledger: ein Eintrag pro Modellaufruf (Konzept §12) |
| `audit_log` | Wer hat wann was getan, mit Approval-Level |
| `schedules`, `settings` | Zeit-Trigger und Einstellungen |

## Job-Lebenszyklus (Konzept §6)

```
QUEUED ──Router──► RUNNING ──► COMPLETED
   │                  │
   │                  ├─ Kontingent erschöpft (vom Provider gemeldet) ─► neu routen
   │                  ├─ vorübergehender Fehler ─► QUEUED (Backoff, max. Versuche) ─► FAILED
   │                  └─ Auth/Konfiguration/Billing ─► BLOCKED
   ├─ Provider erschöpft, Policy WAIT ─► WAITING_FOR_PROVIDER_QUOTA ─(Reset/Event)─► QUEUED
   ├─ Policy OWNER_APPROVAL ─► WAITING_FOR_APPROVAL ─(Freigabe)─► QUEUED (festgelegter Provider)
   ├─ Kostenlimit/Budget/kein Modell ─► BLOCKED ─(Owner ändert Konfiguration)─► QUEUED
   └─ Provider ausgelastet (max. parallele Jobs) ─► bleibt QUEUED
```

- Beim Start werden Jobs im Zustand `RUNNING` wieder eingereiht (Wiederaufnahme nach Unterbrechung).
- Wartezeiten wegen Kontingent zählen nicht als Fehlversuch.
- Jeder Job hat ein Protokoll (sichtbar in der Oberfläche) und verlinkte Artefakte/Ledger-Einträge.

## Router (Konzept §4, §5, §7)

1. **Kandidaten:** erlaubte Provider des Agents in dessen Reihenfolge (leer = alle aktiven nach
   Priorität), je Provider die aktiven Modelle mit ausreichendem Kontextfenster.
2. **Vorgesehener Provider** = erster Kandidat mit einem Modell der geforderten Capability-Klasse.
3. **Verfügbarkeit:** Kontingent (Zähler je Periode oder vom Provider gemeldete Erschöpfung),
   monatliches Kostenlimit, Systembudget (inkl. Warnschwelle: dann nur Priorität ≥ hoch auf
   kostenpflichtigen Providern), Monatsbudget des Agents, parallele Jobs.
4. **Policy bei Nichtverfügbarkeit:**

| Policy | Verhalten |
| --- | --- |
| `WAIT` (Standard) | Provider-Einstellung `WAIT` → warten bis zum Reset; `BLOCK` → blockieren bis zum Eingreifen |
| `FALLBACK_SAME_TIER` | erster verfügbarer *anderer* Provider mit Modell derselben Klasse, sonst wie `WAIT` |
| `FALLBACK_ANY_ALLOWED` | erster verfügbarer anderer erlaubter Provider (gleiche, dann höhere, dann niedrigere Klasse) |
| `OWNER_APPROVAL` | Freigabe „Provider-Wechsel“ mit konkreter Alternative; Ablehnung → `WAIT` |

Wechsel werden immer im Audit-Log vermerkt (`router.fallback`).

### Kontingente

- Einheiten: `tokens`, `requests`, `cost_usd` (Listenpreis-Gegenwert) oder `none`.
- Perioden: monatlich (Reset-Tag), wöchentlich (Wochentag), täglich, rollierendes Fenster, ohne Periode.
- Verbrauch = Summe der Ledger-Einträge seit Periodenbeginn bzw. seit manuellem Reset.
- **Claude-Abo:** Anthropic nennt kein festes Kontingent. Die Claude-CLI liefert aber bei jedem
  Aufruf ein `rate_limit_event` mit Auslastung und Reset-Zeit der Plan-Fenster (5 Stunden / 7 Tage).
  Davenet speichert diese Information (Anzeige im UI) und nutzt bei einem Limit (`status: rejected`
  bzw. „You've hit your limit“) die gemeldete Reset-Zeit für die Wiederaufnahme. Ohne Angabe wird
  nach 30 Minuten erneut geprüft.
- *Kontingent zurücksetzen* in der Oberfläche markiert die Periode als neu begonnen und weckt wartende Jobs.

## Kosten & Ledger (Konzept §12)

Jeder Modellaufruf erzeugt einen `usage_event` mit Tokens (inkl. Cache), Werkzeugaufrufen,
Websuchen, Periode, Restkontingent sowie zwei Geldbeträgen:

- **Kosten (real):** tatsächlich abgerechnete Beträge (Pay-as-you-go).
- **Gegenwert (Listenpreis):** was der Aufruf über die API gekostet hätte – auch für Abo-Nutzung,
  um Auslastung und „Nutzen pro Agent“ vergleichbar zu machen.

Bei der Claude-CLI stammen die Token-Summen aus `modelUsage` (über alle Werkzeug-Runden
kumuliert); `apiKeySource: none` kennzeichnet eine Abo-Anmeldung ohne Kosten pro Aufruf.

## Pipeline & Job-Typen (Konzept §8, §10, §15)

| Job-Typ | Standard-Agent | Werkzeuge | Ergebnis / Folgeaktion |
| --- | --- | --- | --- |
| Owner-Auftrag | Executive Orchestrator | – | zerlegt Freitext in ≤ 5 Jobs (Scan, Recherche, freie Aufträge) |
| Executive Briefing | Executive Orchestrator | – | Lagebericht in `/decisions` |
| Opportunity-Scan | Opportunity Scout | Websuche, Webseiten | neue Opportunities (Duplikate werden verworfen) → Screening |
| Screening | Opportunity Scout (LOW) | – | 13 Kriterien (vorläufig) + rechtliche K.-o.-Punkte; Score ≥ Schwelle ohne K.-o. → Deep Research, sonst verworfen |
| Deep Research | Research Analyst | Websuche, Webseiten | Recherchebericht inkl. Rechtsprüfung (ob/wie möglich, Aufwand, Schritte, Ampel) → Bewertung |
| Bewertung | Research Analyst | – | 13 Kriterien mit Begründung + Testplan; GO, Score ≥ Schwelle, kein K.-o. → Freigabe Nachfragetest (oder Projektstart, wenn der Test abgeschaltet ist) |
| Nachfragetest vorbereiten | Implementation | Workspace lesen/schreiben | Testpaket unter `test/` + Checkliste für den Owner, ggf. Bildanfragen |
| Nachfragetest auswerten | Research Analyst | – | bauen → Freigabe Projektstart; anpassen → Versuch 2 (höchstens einmal); beenden → Freigabe „Beenden“ |
| Technische Planung | Technical Planner | – | MVP-Spezifikation + Tasks → Umsetzung (optional automatisch) |
| Implementierung | Implementation | Workspace lesen/schreiben | Dateien im Workspace, Git-Commit → Review; Bildanfragen → Bild-Jobs |
| Review | Review | Workspace lesen | PASS → erledigt; REWORK → Nacharbeit (max. Runden) → Eskalation |
| Portfolio-Review | Executive Orchestrator | – | monatlich; je Test/Produkt Empfehlung, „beenden“ → Freigabe; Bericht in `/decisions` |
| Bild erzeugen | Designer | – (Bild-Provider) | PNG in `/media` und – mit Opportunity – im Workspace unter `assets/` |
| Kostenbericht | Cost Controller | – | Bericht in `/finance` (rechnet nur mit gelieferten Ledger-Zahlen) |
| Audit-Prüfung | Auditor | – | Bericht in `/audit` |
| Freier Auftrag | beliebig | je nach Agent | Ergebnis in `/knowledge` bzw. `/research` |

Alle Ergebnisse werden als JSON-Schema-geprüfte Struktur geliefert (native strukturierte Ausgabe
der CLI bzw. API, sonst Extraktion + ein Reparaturversuch). Ungültige Rohausgaben werden zur
Nachvollziehbarkeit gespeichert.

**Gesamt-Score:** gewichtetes geometrisches Mittel der 13 Kriterien (je 0–10, 10 = am besten),
skaliert auf 0–100 – multiplikativ, damit ein sehr schwacher Wert nicht durch gute Werte
ausgeglichen wird. **K.-o.-Kriterien** (Nachfrage unter der Schwelle, Rechtsprüfung rot, Testplan
außerhalb der Leitplanken) deckeln den Score auf 30 und damit unter die Schwellen für Recherche
und Vorschlag. Standard-Schwellen: 50 für die Tiefenrecherche (vorläufige Screening-Werte sind
vorsichtig) und 60 für den Vorschlag an den Owner; Installationen, die noch auf den alten
Standardwerten (60/65) standen, werden beim Update einmalig umgestellt. Gewichte, Schwellen und
Leitplanken unter *Einstellungen*; ältere Opportunities behalten ihr Schema (Markt/Technik/Risiko).

**Nachfragetest & Leitplanken:** Der Testplan (Hypothese, Kanal, Budget, Owner-Zeit, Laufzeit,
Messgröße, Erfolgskriterium) entsteht bei der Bewertung. Test- und Projektfreigaben sind nur
möglich, solange weniger als `guard_max_parallel` Opportunities im Test oder in Umsetzung sind
(Status `TESTING`, `APPROVED` … `READY`; veröffentlichte Produkte zählen nicht). Einnahmen,
Ausgaben und Owner-Zeit liegen in `finance_entries`; daraus entstehen Portfolio-Kennzahlen,
die Hinweise in der Übersicht (Owner-Zeit/Woche, Fixkosten, abgelaufene Tests) und die Daten für
den Portfolio-Review – das Modell rechnet nicht selbst.

**Bilder:** Bild-Jobs (`providerKind: 'image'`) laufen ohne Sprachmodell direkt beim Bild-Provider;
der Router wählt nur Provider der passenden Art (Sprachmodell-Jobs nie bei Bild-Providern). Die
Codex CLI wird mit `exec --json --sandbox read-only --ignore-user-config` gestartet; das erzeugte
PNG liegt unter `$CODEX_HOME/generated_images/<thread>/` und wird übernommen, Limit-Meldungen
werden zu `quota` mit Reset-Zeit.

## Kontextstrategie (Konzept §11)

- System-Prompt = Rolle des Agents + feste Arbeitsprinzipien (stabil, cache-freundlich).
- Auftrag + priorisierte Kontextbausteine (Strategie, Opportunity-Artefakt, letzte relevante
  Berichte). Bausteine werden auf eine Maximalgröße gekürzt; reicht das Input-Limit des Agents
  nicht, fallen Bausteine niedriger Priorität zuerst weg (im Job-Protokoll vermerkt).
- Übergaben zwischen Agents nur über kompakte Artefakte – nie über Chatverläufe.
- Strategie: Agents erhalten `strategy/kurzfassung.md`, falls vorhanden (eine fast leere
  Kurzfassung wird ignoriert), sonst `strategy/strategie.md` – jeweils gekürzt auf
  `strategy_context_chars` (Standard 8.000 Zeichen ≈ 2.300 Tokens). `CompanyMemory.strategyStatus()`
  liefert Quelle, Umfang, Kürzung und ob die Kurzfassung älter ist als die Langfassung
  (Toleranz 2 Minuten); daraus entstehen die Hinweise in der Übersicht und im Gedächtnis.
- Sprache: Berichte in der eingestellten Sprache, Inhalte für Kunden und Märkte (Listings,
  Webseiten) in der Sprache des Zielmarkts.

## Sicherheit & Berechtigungen (Konzept §14)

| Level | Umsetzung |
| --- | --- |
| 0 | Recherche, Analyse, Berichte – autonom |
| 1 | Schreiben im Projekt-Workspace, Projektplanung – autonom, Audit-Eintrag mit Dateiliste/Commit |
| 2 | Projektstart, Release, Provider-Wechsel – nur per Owner-Freigabe |
| 3 | Zugangsdaten, Zahlungen, Verträge – nur der Owner; Agents haben dafür keine Werkzeuge |

Claude-CLI-Aufrufe: `--tools` (Allowlist) + `--allowedTools`, `--restricted` (keine Shell,
Dateien nur im Arbeitsverzeichnis), `--strict-mcp-config` ohne Server, `--setting-sources ""`,
`--permission-prompts none`, `--no-session-persistence`, eigener System-Prompt, Arbeitsverzeichnis
= Projekt-Workspace bzw. Temp-Verzeichnis. Ältere CLI-Versionen, die einzelne Optionen nicht
kennen, werden erkannt (die Option wird dann weggelassen und im Job-Protokoll vermerkt).

## Erweiterung

- **Neuer Provider-Typ:** `ProviderTypeDef` (Info + `create()`) mit `ProviderAdapter`
  (`call()`, `healthCheck()`) implementieren, in `server/providers/registry.ts` registrieren.
  Fehler als `ProviderError` mit passender Art melden (`quota` inkl. `resetAt`, `rate_limit`,
  `auth`, …) – Router, Scheduler und Ledger behandeln den Rest.
- **Neuer Job-Typ:** `JobTypeDef` in `server/engine/jobtypes/` (Prompt, Zod-Schema, Folgeaktion),
  in `index.ts` aufnehmen und in `server/db/seed.ts` (`DEFAULT_ROUTES`) einen Standard-Agent
  zuordnen – fehlende Zuständigkeiten werden beim Start ergänzt.
- **Neue Abteilung/Rolle:** komplett über die Oberfläche (Organisation).

## Entscheidungen zu den offenen Punkten (Konzept §20)

| Offener Punkt | Entscheidung für v0.1 |
| --- | --- |
| Welche Provider zuerst? | Claude-Abo über Claude Code CLI (Standard), Anthropic API (optional), Simulation (Test); für Bilder ChatGPT-Abo über Codex CLI, OpenAI-Bild-API, Bild-Simulation |
| Wie melden Provider ihr Restkontingent? | Claude-CLI: `rate_limit_event` (Auslastung + Reset der Plan-Fenster) und Limit-Meldungen; API: Kostenlimit über das eigene Ledger; sonst konfigurierbare Zähler (Tokens/Requests/USD) oder manuell |
| Welche Jobs dürfen ausweichen? | pro Agent und pro Job über die Policy; Standard überall `WAIT` |
| Prioritätsklassen / Wartezeiten | Prioritäten niedrig/normal/hoch/kritisch; Warten bis Reset (bekannt oder geschätzt); Budget-Warnschwelle lässt nur hoch/kritisch auf kostenpflichtigen Providern laufen |
| Datenbank & Queue | SQLite über das in Node eingebaute `node:sqlite` (keine nativen Abhängigkeiten); Queue als Tabelle mit Scheduler-Schleife |
| Verhältnis zu StarNet | StarNet diente als Referenz (u. a. für die Anbindung der Claude-CLI). Die gesamte Geschäftslogik ist eigenständig; die Agent-Runtime ist über die Provider-Adapter austauschbar |
