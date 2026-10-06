# Davenet v0.1

Konzept für ein provider-unabhängiges Multi-Agent-Unternehmen

Ziel ist eine virtuelle, weitgehend automatisierte Organisation, die Geschäftsmöglichkeiten
recherchiert, bewertet und freigegebene Projekte umsetzt. Agents, Rollen und KI-Modelle werden
bewusst voneinander entkoppelt. Provider-Kontingente und Kosten werden zentral gesteuert.

> Dieses Dokument ist die Markdown-Fassung des ursprünglichen Konzepts (`Konzept.docx`).
> Wie die einzelnen Punkte umgesetzt sind, steht in [ARCHITEKTUR.md](ARCHITEKTUR.md).

## 1. Leitbild und Grundprinzipien

Das System bildet ausgewählte Strukturen eines Unternehmens ab, ohne unnötige
Agent-zu-Agent-Kommunikation zu erzeugen. Der Owner bleibt die höchste Entscheidungsinstanz. Die
Software orchestriert Jobs, speichert Ergebnisse dauerhaft und startet Agents nur bei Bedarf.

- **Provider-unabhängig:** Kein Agent ist fest an OpenAI, Anthropic, Google oder einen anderen
  Anbieter gebunden.
- **Modell-unabhängig:** In der Konfiguration werden zunächst nur Modell-Platzhalter bzw.
  Capability-Klassen verwendet.
- **Event- und Job-basiert:** Agents laufen nicht permanent, sondern werden für konkrete Aufgaben
  aktiviert.
- **Artefakt-basierte Übergaben:** Agents übergeben strukturierte Reports statt vollständiger
  Chatverläufe.
- **Budget-first:** Jeder Job, Agent, Provider und das Gesamtsystem besitzen Verbrauchs- und
  Kostenlimits.
- **Human Approval:** Kritische Aktionen benötigen eine explizite Freigabe des Owners.
- **Persistentes Gedächtnis:** Unternehmenswissen liegt in Datenbank/Dateisystem, nicht im
  LLM-Kontext.

## 2. Organisationsmodell

```
OWNER
|
+-- [AGENT: EXECUTIVE_ORCHESTRATOR]
|
+-- Research / R&D
|   +-- [AGENT: OPPORTUNITY_SCOUT]
|   +-- [AGENT: RESEARCH_ANALYST]
|
+-- Development
|   +-- [AGENT: TECHNICAL_PLANNER]
|   +-- [AGENT: IMPLEMENTATION]
|   +-- [AGENT: REVIEW]
|
+-- Finance / Controlling
    +-- [AGENT: COST_CONTROLLER]
    +-- [AGENT: AUDITOR]
```

Die Namen sind funktionale Platzhalter. Die spätere Implementierung darf Rollen zusammenlegen,
aufteilen oder mit unterschiedlichen Modellen ausführen. Eine Rolle beschreibt Verantwortung und
Berechtigungen – nicht den Anbieter.

## 3. Agent-Definition statt Modellbindung

Jeder Agent wird über eine abstrakte Konfiguration beschrieben. Ein konkretes Modell wird erst zur
Laufzeit durch den Model/Provider Router ausgewählt.

```
agent_id: RESEARCH_ANALYST
capability_required: reasoning_medium
context_limit_required: >= 64k
tools: [web_search, company_db]
max_job_cost: configurable
priority: normal
provider_policy: WAIT_IF_PRIMARY_QUOTA_EXHAUSTED
```

## 4. Model- und Provider-Router

Zwischen Agent und KI-Anbieter liegt ein zentraler Router. Er prüft Anforderungen, erlaubte
Provider, verfügbares Kontingent, Rate Limits, Kosten und die für den Job notwendige Modellklasse.

```
JOB
 |
 v
AGENT ROLE
 |
 v
CAPABILITY REQUIREMENTS
 |
 v
MODEL / PROVIDER ROUTER
 |
 +--> Provider A / Model ...
 +--> Provider B / Model ...
 +--> Provider C / Model ...
 |
 v
USAGE + COST LEDGER
```

| Capability | Beispielaufgaben                          | Modell           | Provider             |
| ---------- | ----------------------------------------- | ---------------- | -------------------- |
| LOW        | Formatierung, Extraktion, Klassifikation  | `[MODEL_LOW]`    | `[PROVIDER_DYNAMIC]` |
| MEDIUM     | Research, Analyse, Standard-Code          | `[MODEL_MEDIUM]` | `[PROVIDER_DYNAMIC]` |
| HIGH       | Architektur, schwierige Reviews, Strategie | `[MODEL_HIGH]`   | `[PROVIDER_DYNAMIC]` |

## 5. Quota- und Kontingent-Management

Neben Geldbudgets werden Provider-Kontingente als eigene Ressource behandelt. Das ist besonders
wichtig bei Abonnements oder Plänen, deren Nutzung nicht sinnvoll als Preis pro Token abgebildet
werden kann.

```
Provider A
  monthly_quota: configured
  used: tracked
  reset_at: known/estimated
  policy_on_exhaustion: WAIT

Provider B
  monthly_quota: configured
  used: tracked
  policy_on_exhaustion: WAIT

Pay-as-you-go Provider
  monthly_cost_limit: configured
  policy_on_exhaustion: BLOCK
```

Standardverhalten: Ist das für einen Job vorgesehene Kontingent erschöpft, wird der Job NICHT
automatisch auf einen anderen oder teureren Provider verschoben. Er erhält den Status
`WAITING_FOR_PROVIDER_QUOTA` und wird nach dem Reset erneut eingeplant.

## 6. Warteschlange und Wiederaufnahme

```
QUEUED
 |
 v
CHECK PROVIDER / MODEL
 |
 +-- available ------> RUNNING ------> COMPLETED
 |
 +-- quota exhausted
       |
       v
WAITING_FOR_PROVIDER_QUOTA
       |
       v
quota reset/event
       |
       v
     QUEUED
```

Der Scheduler speichert dabei Jobzustand, Eingabeartefakte, Priorität und den frühestmöglichen
Wiederaufnahmezeitpunkt. Ein Monatswechsel oder ein manuell aktualisiertes Kontingent kann
wartende Jobs erneut aktivieren.

## 7. Optionale Fallback-Policies

Für einzelne Aufgaben kann später bewusst eine andere Policy gewählt werden. Der Wechsel ist
explizit und nicht implizit.

| Policy                 | Verhalten                           | Geeignet für                |
| ---------------------- | ----------------------------------- | --------------------------- |
| `WAIT`                 | Bis zum Provider-Reset pausieren    | Standard / kostenoptimiert  |
| `FALLBACK_SAME_TIER`   | Alternativen gleicher Capability nutzen | Zeitkritische Routinejobs |
| `FALLBACK_ANY_ALLOWED` | Freigegebene Alternative verwenden  | Wichtige Jobs               |
| `OWNER_APPROVAL`       | Alternative erst nach Freigabe      | Teure oder sensible Jobs    |

## 8. Research- und Opportunity-Pipeline

```
DISCOVERED
 |
SCREENING
 |
RESEARCH
 |
EVALUATION
 |
PROPOSED
 |
OWNER APPROVAL
 |
APPROVED
 |
DEVELOPMENT
 |
REVIEW / TESTING
 |
READY
 |
OWNER APPROVAL
 |
DEPLOYED
```

Der Opportunity Scout sucht neue Möglichkeiten. Der Research Analyst prüft nur vorgefilterte
Kandidaten. Ergebnisse werden strukturiert gespeichert, damit spätere Agents keine langen
Rechercheverläufe erneut einlesen müssen.

## 9. Standardisiertes Opportunity-Artefakt

```json
{
  "id": "OPP-XXXX",
  "title": "...",
  "problem": "...",
  "target_customer": "...",
  "proposed_solution": "...",
  "competition_summary": "...",
  "revenue_model": "...",
  "market_score": 0,
  "technical_score": 0,
  "risk_score": 0,
  "confidence": 0.0,
  "sources": [],
  "status": "DISCOVERED"
}
```

## 10. Entwicklungs-Pipeline

Nach Owner-Freigabe erstellt die technische Planung kleine, klar begrenzte Tasks. Implementierung
und Review werden getrennt. Der Reviewer kann REWORK verlangen; produktive Veröffentlichung bleibt
ein Approval Gate.

```
APPROVED OPPORTUNITY
 |
[AGENT: TECHNICAL_PLANNER]
 |
SPEC + TASKS
 |
[AGENT: IMPLEMENTATION]
 |
CODE / ARTIFACT
 |
[AGENT: REVIEW]
 |
PASS / REWORK
 |
OWNER RELEASE APPROVAL
```

## 11. Token- und Kontextstrategie

Das System optimiert nicht nur den Modellpreis, sondern vor allem die Menge wiederholt
übertragener Informationen. Vollständige Agenten-Chats werden nicht an Folgeagents weitergegeben.

```
Web/Tools -> großer temporärer Kontext
 |
 v
kompakter Report
 |
 v
nächster Agent
 |
 v
kompaktes Ergebnis
```

- Nur relevante Artefakte werden in den Prompt geladen.
- Reports besitzen definierte Maximalgrößen.
- Tool-Ausgaben werden vor Übergabe extrahiert/verdichtet.
- Langzeitwissen wird bei Bedarf aus der Unternehmensdatenbank abgerufen.
- Jeder Job erhält Limits für Input, Output, Tool Calls, Laufzeit und ggf. Kosten.

## 12. Kosten-, Usage- und Quota-Ledger

Jeder Modellaufruf wird protokolliert. Bei Abomodellen kann die Einheit je nach Anbieter Tokens,
Credits, Requests oder ein manuell gepflegtes Kontingent sein.

```
usage_event
- timestamp
- job_id
- agent_id
- provider_id
- model_id
- input_tokens
- output_tokens
- cached_tokens (optional)
- provider_units (optional)
- monetary_cost (optional)
- quota_period
- quota_remaining (if known)
```

Damit lässt sich später nicht nur 'Kosten pro Monat', sondern auch 'Tokens pro Opportunity',
'Kosten pro Projekt', 'Provider-Auslastung' und 'Nutzen pro Agent' messen.

## 13. Unternehmensgedächtnis

```
/company
  /strategy
  /opportunities
  /projects
  /research
  /finance
  /decisions
  /knowledge
  /audit
```

Strukturierte Metadaten gehören vorzugsweise in eine Datenbank; größere Reports, Code und andere
Artefakte in geeignete Datei-/Repository-Systeme. Agents erhalten nur die für ihren Job benötigten
Ausschnitte.

## 14. Berechtigungen und Approval Levels

| Level | Freigabe              | Beispiele                                                   |
| ----- | --------------------- | ----------------------------------------------------------- |
| 0     | Autonom               | Recherche, Analyse, interne Reports, Tests                  |
| 1     | Autonom + Audit Log   | Code/Branches, interne Datenänderungen                      |
| 2     | Owner Approval        | Deployment, öffentliche Veröffentlichung, neue bezahlte Dienste |
| 3     | Immer Owner           | Geldtransaktionen, Verträge, Accounts, Zugangsdaten         |

## 15. Scheduler und Trigger

Jobs können zeitgesteuert oder ereignisgesteuert entstehen. Ein Agent selbst muss dafür nicht
dauerhaft laufen.

```
TIME TRIGGER
  -> Research Cycle

EVENT: Opportunity score > threshold
  -> Deep Research

EVENT: Owner approved project
  -> Technical Planning

EVENT: Provider quota reset
  -> Resume waiting jobs

EVENT: Budget threshold reached
  -> Restrict / stop non-critical jobs
```

## 16. Technische Zielarchitektur

```
UI / DASHBOARD
 |
ORCHESTRATOR
 |
 +--------------+--------------+
 |              |              |
JOB QUEUE   POLICY ENGINE   APPROVALS
 |              |
 +------+-------+
        |
MODEL/PROVIDER ROUTER
        |
 +-----------+-----------+
 |           |           |
[PROVIDER A] [PROVIDER B] [PROVIDER C]
 |
 v
LLM / MODEL

Shared services:
- Company Database
- Artifact Storage / Git
- Usage & Cost Ledger
- Scheduler
- Audit Log
- Tool Gateway
- Secrets Management
```

## 17. Verhältnis zu StarNet

StarNet kann zunächst als Agent-Runtime und Orchestrierungsbasis eingesetzt werden. Die
geschäftskritische Logik (Jobstatus, Provider-Policies, Quotas, Freigaben, Unternehmensdaten und
Audit-Trail) sollte jedoch möglichst in eigenen, klar abgegrenzten Komponenten liegen. Dadurch
bleibt ein späterer Wechsel der Agent-Runtime möglich.

## 18. Umsetzungsphasen

### Phase 1 – Proof of Concept

- [AGENT: EXECUTIVE_ORCHESTRATOR]
- [AGENT: RESEARCH]
- [AGENT: DEVELOPMENT]
- [AGENT: CONTROLLER]
- Provider Router mit mindestens zwei abstrakten Provider-Konfigurationen
- WAIT_IF_QUOTA_EXHAUSTED
- Job Queue, persistente Statuswerte und Usage Ledger
- Owner Approval für Projektstart und Release

Erfolgskriterium: Das System kann eine Opportunity finden, bewerten, zur Freigabe vorlegen, nach
Freigabe einen MVP-Plan erzeugen und sämtliche Modellnutzung nachvollziehbar protokollieren.

### Phase 2 – Departments

- Research in Scout + Analyst aufteilen
- Development in Planning + Implementation + Review aufteilen
- Finance in Controller + Auditor aufteilen
- Capability-basiertes Model Routing
- Provider-spezifische Quota-Adapter und Reset-Events
- Dashboard für Jobs, Approvals, Kosten und Kontingente

### Phase 3 – Erweiterte Autonomie

- Weitere Abteilungen nur bei messbarem Bedarf ergänzen
- KPIs und Quartals-/Monatsziele
- Marketing, Operations, Support oder Sales als optionale Rollen
- Optimierung anhand realer Kosten-, Token- und Erfolgsdaten

## 19. Zentrale Designentscheidungen

- Agents sind Rollen – keine fest verdrahteten Modelle.
- Modelle sind austauschbare Ressourcen hinter einem Router.
- Provider-Kontingente werden wie begrenzte Betriebsmittel behandelt.
- Standardmäßig wird bei erschöpftem Kontingent gewartet, nicht automatisch Geld ausgegeben.
- Alle Jobs sind persistent und nach Unterbrechung wiederaufnehmbar.
- Agentenkommunikation erfolgt über kompakte, strukturierte Artefakte.
- Autonomie endet an definierten Approval Gates.
- Das System wird zunächst klein gebaut und anhand realer Usage-Daten erweitert.

## 20. Offene Punkte für die technische Spezifikation

- Welche Provider und Vertrags-/Abomodelle sollen zuerst unterstützt werden?
- Wie können die jeweiligen Provider ihr Restkontingent technisch melden – API, Header, Dashboard
  oder manuell?
- Welche Jobs dürfen optional auf einen anderen Provider ausweichen?
- Welche Prioritätsklassen und maximale Wartezeiten sollen existieren?
- Welche Datenbank und Queue-Technologie wird für Phase 1 eingesetzt?
- Welche StarNet-Funktionen werden direkt genutzt und welche Funktionen werden als eigene Services
  implementiert?
