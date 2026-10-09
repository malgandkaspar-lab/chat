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

## Veebiversioon (Vercel)

Sama `server.js` töötab ka Vercelis aadressil https://metsachat.vercel.app. Seal ei ole Ollamat, seega kasutab server pilvemudeleid (`lib/models.js`):

- **Cloudflare Workers AI** tasuta plaan, kui Verceli projekti seadetes (Environment Variables) on `CLOUDFLARE_ACCOUNT_ID` ja `CLOUDFLARE_API_TOKEN`. Tasuta on 10 000 „neuronit“ päevas ehk mudeliga `gpt-oss-120b` umbes 100 küsimust; kui maht saab täis, ütleb leht seda ja järgmisel päeval töötab jälle. Cloudflare'il on sama otsingumudel (`bge-m3`), nii et kasutusel on sama indeks mis kohalikult.
- Kui Cloudflare'i andmeid ei ole, proovib server Verceli AI Gatewayd. See on tasuline ja vajab eraldi indeksit (`node ingest.js --cloud`).

Kohalikuks proovimiseks pilvemudelitega: pane samad kaks väärtust faili `.env.local` ja käivita `node server.js --cloud`.

## Näidis Keskkonnaportaali lehel

Praktikaprojekti esitlemiseks näitab veebiversiooni avaleht Keskkonnaportaali metsalehte (`keskkonnaportaal.ee/et/teemad/mets`) täpselt sellisena, nagu see parajasti on, ja lisab sisu algusesse vestluskasti. See ei ole Keskkonnaportaali ametlik leht.

- Portaali sisu siia reposse ei kopeerita: server toob lehe päringu ajal portaalist (`server.js`, `portalPage`) ning stiilid, skriptid ja pildid laetakse otse portaalist. Lingid viivad päris portaali.
- Teadlikud erinevused: leht keelab otsimootoritel indekseerimise, portaali külastusstatistika ja reCAPTCHA skriptid on välja jäetud, tagasisidevorm ei saada midagi, vahekaardi pealkirja lõpus on „praktika näidis“ ja vestluskastis märge „näidis“.
- Aadressid: `/` näidisleht (kohalikult `/portaal`), `/vestlus` vestlus eraldi lehena, `/vestlus?embed=1` kast ise, `/naidis` järjehoidja-nupp, millega saab kasti oma brauseris päris portaali lehele panna.

## Andmete uuendamine

`uuenda-andmeid.bat` laeb allikad uuesti alla ja arvutab muutunud osa indeksist. Esimene kord uues arvutis võtab see umbes poolteist tundi, sest lehtede koopiaid repos ei ole.

- Allikad ja teema on failis `sources.json`. Plokk `focus` piirab indeksi märksõnade järgi.
- `node ingest.js --all` indekseerib kõik teemad (mitu tundi).

## Kuidas vastust kontrollitakse

Põhimõte on „pigem jäta vastamata kui vasta valesti“ (`server.js`, `lib/verify.js`):

1. **Otsingulävi.** Kui ükski lõik küsimusega piisavalt hästi ei sobi, vastab server ise, et infot ei leitud, ja mudelit ei kutsuta.
2. **Värskus.** Küsimusele praeguse seisu või kindla aasta kohta antakse mudelile ainult selle aja allikad; muidu jäetakse välja kõik, mis on uusimast sobivast allikast üle kahe aasta vanem.
3. **Arvude kontroll.** Iga vastuses olev arv ja aastaarv peab olema kirjas allikas, millele vastus viitab. Kui ei ole, vastust ei näidata.
4. **Kaks katset** (ainult veebis). Arvuga vastus küsitakse mudelilt teist korda; kui kaks katset annavad eri arvu, vastust ei näidata. See kahekordistab arvuga küsimuse kulu, nii et tasuta mahust jätkub umbes 50 sellisele küsimusele päevas.
5. **Jätkuküsimused** (ainult veebis). „Aga see aasta?“ sõnastatakse enne otsingut terviklikuks küsimuseks ja leht näitab, kuidas küsimusest aru saadi.

## Teadaolevad piirid

- Kontrollid püüavad kinni vale aasta, väljamõeldud arvu ja kõikuva vastuse, aga mitte iga vea: kui mudel loeb allikat kaks korda ühtemoodi valesti, läheb vastus läbi. Tähtsa arvu puhul klõpsa allikas lahti.
- Kontrollid on ranged ja jätavad vahel näitamata ka õige vastuse (näiteks kui mudel teisendab ühikuid või arv on PDF-i joonisel teistega kokku kleepunud).
- Integreeritud graafikaga sülearvutis võtab vastus 15–30 sekundit.
- Proovitud on ainult mudeliga `Llama-3.1-EstLLM-8B-Instruct-1125 (Q4_K_M)`; teisi mudeleid saab valida vestluslehe päisest.

## Failid

- `server.js` – veebiserver: otsib küsimusele sobivad lõigud ja annab need mudelile.
- `index.html` – vestlusleht.
- `ingest.js`, `lib/` – allikate allalaadimine, teksti eraldamine ja indeksi tegemine.
