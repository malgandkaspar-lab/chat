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

- **Cloudflare Workers AI** tasuta plaan, kui Verceli projekti seadetes (Environment Variables) on `CLOUDFLARE_ACCOUNT_ID` ja `CLOUDFLARE_API_TOKEN`. Tasuta on 10 000 „neuronit“ päevas. Mudeliga `gpt-oss-120b` jätkub sellest hinnanguliselt 25–60 küsimusele: arvudega küsimus kulutab kaks kuni kolm mudelikutset (vt „Kuidas vastust kontrollitakse“). Kui maht saab täis, ütleb leht seda; uus päev algab kell 00.00 UTC (Eesti aja järgi kell 2 või 3 öösel). Cloudflare'il on sama otsingumudel (`bge-m3`), nii et kasutusel on sama indeks mis kohalikult.
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
3. **Arvude kontroll.** Iga vastuses olev arv ja aastaarv peab olema kirjas allikas, millele vastus viitab, ja arvuga vastuses peab viide olema. Tabeli real peavad aasta ja arv olema ühes ja samas allikas.
4. **Ei mingeid hinnanguid.** Vastus esitab allikate arvud koos aja ja allika nimega ega tee ise järeldusi. Koguste ja võrdluste küsimusele ei vastata sõnaga „Jah“ ega „Ei“; küsimusele „kas … on rohkem/vähem“ peab vastus algama allika nimetamisega („Keskkonnaagentuuri 9.04.2026 ülevaate järgi …“). Järeldavad sõnad („seega“, „järelikult“) ja hinnangulised sõnad, mida allikad ise ei kasuta („drastiliselt“, „murettekitav“, „liiga“), ei ole lubatud.
5. **Üks parandus** (ainult veebis). Kui vastus punktides 3–4 läbi kukub, saab mudel põhjenduse ja ühe võimaluse see ümber kirjutada. Kui ka teine katse ei sobi, vastust ei näidata. Kui viga on siis ainult tabelis või mõnes hilisemas lauses (mitte vastuse avalauses), jäetakse välja tabel või see lause ja ülejäänu näidatakse.
6. **Kaks katset** (ainult veebis). Arvuga vastus küsitakse mudelilt teist korda (samal ajal esimesega, et ootamine ei pikeneks); kui kaks katset annavad eri arvu, vastust ei näidata.
7. **Jätkuküsimused** (ainult veebis). „Aga see aasta?“ sõnastatakse enne otsingut terviklikuks küsimuseks ja leht näitab, kuidas küsimusest aru saadi.

## Tabelid ja graafikud

Kui allikates on arvurida (vähemalt kolm väärtust), lisab mudel vastuse lõppu tabeli. Graafiku joonistab leht ise selle tabeli põhjal (`index.html`, `addCharts`), nii et graafikul saavad olla ainult arvud, mis läbisid arvude kontrolli. Aastate ja hooaegade rida joonistatakse joonena, nimetuste rida tulpadena; telg algab alati nullist. Sama ühikuga veerud (kuni kolm) on ühel graafikul, eri ühikuga veerud eraldi.

## Teadaolevad piirid

- Kontrollid püüavad kinni vale aasta, väljamõeldud arvu ja kõikuva vastuse, aga mitte iga vea: kui mudel loeb allikat kaks korda ühtemoodi valesti, läheb vastus läbi. Tähtsa arvu puhul klõpsa allikas lahti.
- Kontrollid on ranged ja jätavad vahel näitamata ka õige vastuse (näiteks kui mudel teisendab ühikuid või arv on PDF-i joonisel teistega kokku kleepunud).
- Veebis võtab vastus tavaliselt 10–20 sekundit, ümberkirjutuse korral kuni minuti.
- Kohalik mudel parandusvõimalust ei saa: selle vastus kirjutatakse ekraanile jooksvalt ja võetakse tagasi, kui kontroll ebaõnnestub.
- Integreeritud graafikaga sülearvutis võtab vastus 15–30 sekundit.
- Proovitud on ainult mudeliga `Llama-3.1-EstLLM-8B-Instruct-1125 (Q4_K_M)`; teisi mudeleid saab valida vestluslehe päisest.

## Failid

- `server.js` – veebiserver: otsib küsimusele sobivad lõigud ja annab need mudelile.
- `index.html` – vestlusleht.
- `ingest.js`, `lib/` – allikate allalaadimine, teksti eraldamine ja indeksi tegemine.
