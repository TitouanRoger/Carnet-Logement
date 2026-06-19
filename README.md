# Lancement du projet

Pour lancer ce projet, suivez les étapes ci-dessous :

## 1. Configuration du fichier `.env`

À la racine du projet, copiez le fichier d'exemple et renommez-le :

```bash
cp .env.example .env
```

Ouvrez ensuite .env et renseignez votre clé API Anthropic :

```env
# --- Anthropic (Claude) ---
# Obtenez votre clé sur [https://console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022
```

## 2. Installation des dépendances

Assurez-vous d'avoir [Node.js](https://nodejs.org/) et [npm](https://www.npmjs.com/) installés sur votre machine.

Ouvrez un terminal dans le répertoire racine du projet (`c:\xampp\htdocs\carnet-logement`) et exécutez la commande suivante pour installer les dépendances :

```bash
npm install
```

## 3. Lancement du serveur

Une fois les dépendances installées, vous pouvez lancer le serveur en exécutant la commande suivante dans le même terminal :

```bash
node server.js
```

## 4. Accès à l'application

Après avoir démarré le serveur, ouvrez votre navigateur web et accédez à l'adresse suivante :

[http://localhost:3000](http://localhost:3000) (ou le port configuré dans `server.js` si différent)
