# Lumen — messagerie web

Node.js + Express + SQLite (better-sqlite3). Front en HTML/CSS/JS pur.

## Lancer
    npm install
    npm start        # http://localhost:3000

Les comptes et messages sont dans `data/messagerie.db`.

## Utiliser depuis n'importe quel appareil
Le serveur doit être joignable : héberge-le (VPS, Railway, Render, Fly.io…) ou, sur ton réseau local, ouvre `http://IP-DE-TON-PC:3000`.
En production : mets-le derrière HTTPS et définis `JWT_SECRET`.

