---
description: Fasst den heutigen Fortschritt zusammen und schreibt den Abschnitt „Aktueller Fokus" in CLAUDE.md fort
allowed-tools: Bash(git log:*), Bash(git status:*), Bash(git diff:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Edit, Read
---

Es ist Feierabend. Fasse den heutigen Arbeitsstand zusammen und halte ihn so
fest, dass wir morgen nahtlos weitermachen können.

Vorgehen:

1. **Heutigen Fortschritt sammeln** (nicht raten, aus dem Repo lesen):
   - `git log --since=midnight --oneline` für die heutigen Commits.
   - `git status --short` für noch nicht committete Änderungen.
   - Bei Bedarf `git diff --stat` gegen den ersten heutigen Commit.

2. **Kurze Zusammenfassung** ausgeben (im Chat), gegliedert nach:
   - Was heute fertig wurde (deployed vs. nur committet — sauber trennen).
   - Was offen/blockiert ist, jeweils mit dem konkreten nächsten Schritt.

3. **CLAUDE.md fortschreiben** — den Abschnitt `## Aktueller Fokus` aktualisieren
   (anlegen, falls er fehlt). Inhalt:
   - **Stand heute:** 1–3 Sätze, was live ist / wo wir stehen.
   - **Morgen zuerst:** konkret der erste Schritt für morgen, mit genügend
     Kontext (Dateien, Endpunkte, offene Gates), um ohne Rückfrage anzusetzen.
   - **Offene Punkte:** kurze Liste dessen, was noch aussteht.
   Datum im Format `Stand: JJJJ-MM-TT` mitschreiben.

4. **CLAUDE.md committen und pushen:**
   - `git add CLAUDE.md`
   - Commit mit Nachricht `CLAUDE.md: Feierabend-Update — <kurze Zusammenfassung>`
   - `git push -u origin <aktueller Branch>`

5. Halte dich kurz und konkret. Keine Platzhalter, nur was tatsächlich passiert ist.

$ARGUMENTS
