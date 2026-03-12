<div align="center"> 
  <h1>Parachute Addon for AirLink Panel</h1>
</div>

Parachute is an AirLink Panel addon that integrates with Google Drive for server backups and file management. It handles authentication, token storage, and server-specific operations using server UUIDs.

<div align="center">

| Dashboard                                                                                                | Server Selection                                                                                         | Info Screen (without encryption)                                                                         |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| <img src="https://github.com/user-attachments/assets/52faabd4-62e9-474d-9602-14fa3aec49dd" width="400"/> | <img src="https://github.com/user-attachments/assets/338a245e-f37a-41e1-afbc-c78dad743222" width="400"/> | <img src="https://github.com/user-attachments/assets/32176e79-1ec4-42ae-bd32-fc9f9df77c1c" width="400"/> |

| Info Screen (with encryption)                                                                            | Dashboard after backup created                                                                           | Delete                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| <img src="https://github.com/user-attachments/assets/ef296a09-a9d3-4556-905f-940331541330" width="400"/> | <img src="https://github.com/user-attachments/assets/fb391479-7257-4d65-b3aa-7ae9e7a320e4" width="400"/> | <img src="https://github.com/user-attachments/assets/24f792dc-a832-4689-ac2f-d25e63a8cf68" width="400"/> |

| Dashboard before logging in to Google                                                                    | Progress screen                                                                                                  |
| -------------------------------------------------------------------------------------------------------- |------------------------------------------------------------------------------------------------------------------|
| <img src="https://github.com/user-attachments/assets/b8cfaf9d-3526-44cc-9c58-d243e5e1f0f5" width="400"/> |<img width="400" alt="image" src="https://github.com/user-attachments/assets/46793ec8-5a43-4091-a30a-98919ae1f6f3" />|


</div>

---

## Features

* Connect your server to Google Drive via OAuth and upload download and restore server backup files.

## Installation

### Option 1: Download Release

1. **Download the latest release** from [HERE](#get-it-here).
2. **Move the release to your Airlink addons folder:**

```
/var/www/panel/storage/addons/
```

3. **Run the following commands:**

```bash
cd /var/www/panel/storage/addons/
mkdir parachute
mv parachute.zip parachute/
cd parachute
unzip parachute.zip
cd /var/www/panel/storage/addons/parachute
sudo npm install
sudo npm run build
```

4. **Start your Airlink panel.**
   The Parachute Addon will now be available in your panel.
.

### Option 2: Clone Repository

1. **Clone the repository directly:**

```bash
cd /var/www/panel/storage/addons/
git clone --branch parachute https://github.com/g-flame-oss/airlink-addons.git parachute
```

2. **Install dependencies and build:**

```bash
cd /var/www/panel/storage/addons/parachute
npm install
npm run build
```

3. **Start your Airlink panel.**
   The Parachute Addon will now be available in your panel.

---

## Get It Here

* [SourceXchange – Download and instructions](https://www.sourcexchange.net/products/parachute-for-airlink)
* [GitHub releases page](https://github.com/g-flame-oss/airlink-addons/releases)
* [Built by bit ](https://builtbybit.com/resources/parachute-for-airlink.79073/)

---

## Configuration

Set the following environment variables in your panel environment:

```bash
APP_URL=https://yourpanel.com
GOOGLE_CLIENT_ID=your_google_app_key
GOOGLE_CLIENT_SECRET=your_google_app_secret
```

* `APP_URL` → Base URL of your AirLink panel.
* `GOOGLE_CLIENT_ID` → OAuth client ID from the Google Developer Console.
* `GOOGLE_CLIENT_SECRET` → OAuth client secret from the Google Developer Console.

---

## License

This project is licensed under the [MIT License](LICENSE).

---

## Credits

* Addon developed by [g-flame](https://github.com/g-flame-oss)
* Panel by [AirlinkLabs](https://github.com/airlinklabs)
