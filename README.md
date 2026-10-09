# Vestlus

Kohalik vestlusrobot, mis vastab ainult otsinguindeksist leitud allikate põhjal ja näitab iga vastuse all, kust info pärineb. Kõik töötab sinu arvutis: keelemudel jookseb Ollamas ja vestlus ei lahku masinast.

Praegu on indeksis teema **metsandus ja ulukid** (850 dokumenti, 9164 lõiku):

- statistilise metsainventuuri (SMI) 2023–2025 tulemused ja ettekanded, välitööde juhend, aastaraamat „Mets 2023“;
- ulukiseire: „Ulukiasurkondade seisund ja küttimissoovitus 2026“, küttimisstatistika, küttimisettepanekud, suurkiskjate tegevuskava;
- Keskkonnaagentuuri ja Keskkonnaameti metsa- ja ulukiteemalised lehed ja uudised.

## Käivitamine uues arvutis

Vaja on [Node.js](https://nodejs.org) ja [Ollama](https://ollama.com) (Windows).

1. `paigalda.bat` – paigaldab paketid ja laeb alla kaks mudelit (umbes 6 GB).
2. `start.bat` – avab vestluse aadressil http://127.0.0.1:3939.

Valmis otsinguindeks (`data/index.json`, `data/vectors.bin`) on repos kaasas, nii et midagi arvutada ei ole vaja.

## Andmete uuendamine

`uuenda-andmeid.bat` laeb allikad uuesti alla ja arvutab muutunud osa indeksist. Esimene kord uues arvutis võtab see umbes poolteist tundi, sest lehtede koopiaid repos ei ole.

- Allikad ja teema on failis `sources.json`. Plokk `focus` piirab indeksi märksõnade järgi.
- `node ingest.js --all` indekseerib kõik teemad (mitu tundi).

## Teadaolevad piirid

- Arvudega vastuseid tuleb allikast üle kontrollida. Kui otsing leiab mitu sarnast allikat (sama tabel eri aastatest, Eesti ja maailma näitajad), võib mudel need segi ajada ja viidata valele allikale.
- Integreeritud graafikaga sülearvutis võtab vastus 15–30 sekundit.
- Proovitud on ainult mudeliga `Llama-3.1-EstLLM-8B-Instruct-1125 (Q4_K_M)`; teisi mudeleid saab valida vestluslehe päisest.

## Failid

- `server.js` – veebiserver: otsib küsimusele sobivad lõigud ja annab need mudelile.
- `index.html` – vestlusleht.
- `ingest.js`, `lib/` – allikate allalaadimine, teksti eraldamine ja indeksi tegemine.
