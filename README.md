# change-desk

Una mod per Claude Code che aggiunge:

- **una fascia sopra il prompt** con file modificati, contesto della chat, limiti a 5 ore e settimanali e costo della sessione. Resta grigia finché va tutto bene e si colora dal 60%. Ha i bottoni Pannello, Compact e Handoff, e si adatta alla larghezza, anche con due chat affiancate;
- **un pannello "Modifiche"** con l'utilizzo dettagliato (barre, percentuali, tempo al reset) e l'elenco dei file modificati da Claude, ognuno con il suo bottone **↺ Annulla**, che riporta il file a com'era prima delle modifiche;
- il comando `/change-desk` per riaprire il pannello.

La mod non salva dati suoi: mostra solo quello che Claude Code riporta. I limiti compaiono con la prima risposta del server (prima si vede "—"), e l'elenco dei file di una sessione riaperta viene riletto dalle modifiche registrate nella chat.

## Installazione

Dal prompt di una sessione di Claude Code in terminale:

```
/plugin install change-desk --marketplace gianlucaam04/change-desk
```

Da una shell:

```bash
claude plugin install change-desk --marketplace gianlucaam04/change-desk
```

Nell'app desktop, dove `/plugin` non funziona: clicca **+** accanto al prompt, poi **Plugins**, **Add marketplace** con `gianlucaam04/change-desk`, poi **Add plugin**.

Se il repository è privato, l'installazione funziona solo per chi può leggerlo su GitHub e ha già una credenziale git per github.com sul proprio computer (una chiave SSH, oppure `gh auth login` e poi `gh auth setup-git`).

## Sviluppo

Per provare le modifiche senza installare, avvia una sessione con la cartella del progetto:

```bash
claude --plugin-dir /percorso/di/change-desk
```

Per controllare la mod prima di un commit:

```bash
claude plugin validate .
```

## Licenza

MIT, vedi [LICENSE](LICENSE).
