<div align="center"> <h1>Airlink Addons – Modrinth Store</h1>

<table>
  <tr>
    <td align="center">
      <img src="https://github.com/user-attachments/assets/f47d1213-873d-4aba-bce1-ab37a97b4f3e" width="350"/>
      <br/><strong>Home</strong>
    </td>
    <td align="center">
      <img src="https://github.com/user-attachments/assets/13da8338-7bd1-43d9-a91c-69d32ef84fdc" width="350"/>
      <br/><strong>Status</strong>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="https://github.com/user-attachments/assets/4725a0c8-048c-4a4e-9914-9248d0fe828f" width="350"/>
      <br/><strong>Project Page</strong>
    </td>
    <td align="center">
      <img src="https://github.com/user-attachments/assets/0b255e87-3bb2-4ba9-a303-1c4cc710f832" width="350"/>
      <br/><strong>Install</strong>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="2">
      <img src="https://github.com/user-attachments/assets/d85f661f-b73d-4852-9b63-daab7356826a" width="700"/>
      <br/><strong>Admin Panel</strong>
    </td>
  </tr>
</table>

</div>

---

## Overview

The **Modrinth Store Addon** integrates Modrinth directly into your Airlink panel.
You can browse, search, and install mods or modpacks from the admin panel with full feature control.

---

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
mkdir modrinth-store
mv modrinth-store.zip modrinth-store/
cd modrinth-store
unzip modrinth-store.zip
cd /var/www/panel/storage/addons/modrinth-store
sudo npm install
sudo npm run build
```

4. **Start your Airlink panel.**
   The Modrinth Store will now be available in your admin panel.

### Option 2: Clone Repository

1. **Clone the repository directly:**

```bash
cd /var/www/panel/storage/addons/
git clone --branch modrinth-addon https://github.com/g-flame-oss/airlink-addons.git modrinth-store
```

2. **Install dependencies and build:**

```bash
cd /var/www/panel/storage/addons/modrinth-store
sudo npm install
sudo npm run build
```

3. **Start your Airlink panel.**
   The Modrinth Store will now be available in your admin panel.

---

## Get It Here

- [SourceXchange – Download and instructions](https://www.sourcexchange.net/products/modrinth-store-for-airlink)
- [Built by bit – Resource page](https://builtbybit.com/resources/modrinth-store-for-airlink.76168/)
- [GitHub releases page](https://github.com/g-flame-oss/airlink-addons/releases)

---

## Features (v1.6.23)

- Made The code a bit more Readable
- Added Progress bars and improved footer credits
- Fixed bugs and improved UI


---

## License

This project is licensed under the [MIT License](LICENSE).

---

## Credits

- Addon developed by [g-flame](https://github.com/g-flame-oss)
- Panel by [AirlinkLabs](https://github.com/airlinklabs)

---
